// src/engine.mjs — SQL facade over FileManager + BTree.
//
// Tables live in the DB meta page (FileManager.tables): { name, columns, rootPage, nextId }.
// Row values are encoded as typed blobs, keyed by the table's key column (PRIMARY KEY).
// `execSql` auto-commits; `begin`/`commit`/`rollback` control multi-statement transactions.

import { FileManager, serializeLeaf, LEAF } from './fs.mjs';
import { BTree } from './btree.mjs';
import { parse as parseAst } from './parser.mjs';

const VALUE_TYPES = { integer: 0, text: 1 };

function encodeValue(table, row) {
  const parts = [];
  for (const col of table.columns) {
    if (col.isKey) continue;
    const v = row[col.name];
    if (typeof v === 'number') {
      const b = Buffer.alloc(9);
      b.writeUInt8(VALUE_TYPES.integer, 0);
      b.writeDoubleLE(v, 1);
      parts.push(b);
    } else {
      const s = Buffer.from(String(v ?? ''), 'utf8');
      const b = Buffer.alloc(5 + s.length);
      b.writeUInt8(VALUE_TYPES.text, 0);
      b.writeUInt32LE(s.length, 1);
      s.copy(b, 5, 0, s.length);
      parts.push(b);
    }
  }
  return Buffer.concat(parts);
}

function decodeValue(table, buf) {
  const out = {};
  let off = 0;
  for (const col of table.columns) {
    if (col.isKey) continue;
    const t = buf[off];
    if (t === VALUE_TYPES.integer) {
      out[col.name] = buf.readDoubleLE(off + 1);
      off += 9;
    } else {
      const len = buf.readUInt32LE(off + 1);
      out[col.name] = buf.slice(off + 5, off + 5 + len).toString('utf8');
      off += 5 + len;
    }
  }
  return out;
}

export class Database {
  /** @param {import('./fs.mjs').FileManager} fm */
  constructor(fm) {
    this.fm = fm;
    /** @type {Map<string, {name, columns, rootPage, nextId, bt: BTree}>} */
    this.tables = new Map();
  }

  static create(filePath) {
    return new Database(FileManager.create(filePath));
  }
  static open(filePath) {
    const db = new Database(FileManager.open(filePath));
    for (const t of db.fm.tables) {
      db.tables.set(t.name, { name: t.name, columns: t.columns, rootPage: t.rootPage, nextId: t.nextId, committedRootPage: t.rootPage, committedNextId: t.nextId, bt: new BTree(db.fm, t.rootPage) });
    }
    return db;
  }

  keyColumnOf(table) {
    return table.columns.find((c) => c.isKey) ?? table.columns[0];
  }

  createTable(name, columns) {
    const rootPage = this.fm.allocatePage();
    this.fm.writePage(rootPage, serializeLeaf({ type: LEAF, pageNum: rootPage, entries: [] }));
    const table = { name, columns, rootPage, nextId: 1, committedRootPage: rootPage, committedNextId: 1, bt: new BTree(this.fm, rootPage) };
    this.tables.set(name, table);
    this.fm.tables.push({ name, columns, rootPage, nextId: 1 });
    this.fm.writeMeta();
    return table;
  }

  insert(tableName, row) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`insert: no such table '${tableName}'`);
    const keyCol = this.keyColumnOf(table);
    let key = row[keyCol.name];
    if (key == null) key = table.nextId++;
    else table.nextId = Math.max(table.nextId, key + 1);
    table.bt.insert(key, encodeValue(table, row));
    table.rootPage = table.bt.rootPage; // may have moved after root splits
    // NOTE: meta page is synced on commit, not per-insert.
    return key;
  }

  /**
   * Sync meta + record committed tree state. Called by commit().
   */
  syncTableMeta(table) {
    const meta = this.fm.tables.find((t) => t.name === table.name);
    if (meta) {
      meta.rootPage = table.rootPage;
      meta.nextId = table.nextId;
    }
    table.committedRootPage = table.rootPage;
    table.committedNextId = table.nextId;
  }

  query(tableName, { where = null, orderBy = null, columns = null } = {}) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`query: no such table '${tableName}'`);
    const keyCol = this.keyColumnOf(table);
    const filter = where
      ? (key, value) => (where.col === keyCol.name ? key === where.value : decodeValue(table, value)[where.col] === where.value)
      : null;
    let rows = [];
    for (const { key, value } of table.bt.scan(filter)) {
      rows.push({ [keyCol.name]: key, ...decodeValue(table, value) });
    }
    if (orderBy) {
      const dir = orderBy.dir === 'DESC' ? -1 : 1;
      rows.sort((a, b) => (a[orderBy.col] < b[orderBy.col] ? -1 : a[orderBy.col] > b[orderBy.col] ? 1 : 0) * dir);
    }
    if (columns) rows = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])));
    return rows;
  }

  plan(ast) {
    if (ast.type !== 'select') return null;
    const table = this.tables.get(ast.table);
    const stats = table.bt.stats();
    if (ast.where) return { strategy: 'index-seek', pages: stats.depth + 1, rowsEstimate: 1 };
    return { strategy: 'full-scan', pages: stats.pageCount, rowsEstimate: stats.entryCount };
  }

  execSql(sql) {
    const ast = parseAst(sql);
    if (ast.type === 'createTable') {
      this.createTable(ast.name, ast.columns);
      this.commit(); // DDL is committed eagerly
      return { rows: [], columns: [], plan: null };
    }
    if (ast.type === 'insert') {
      const key = this.insert(ast.table, this.mapRow(ast));
      this.commit();
      return { rows: [], columns: [], key, plan: null };
    }
    if (ast.type === 'select') {
      const table = this.tables.get(ast.table);
      const rows = this.query(ast.table, { where: ast.where, orderBy: ast.orderBy, columns: ast.columns });
      return { rows, columns: ast.columns ?? table.columns.map((c) => c.name), plan: this.plan(ast) };
    }
    throw new Error(`unsupported statement type: ${ast.type}`);
  }

  mapRow(ast) {
    const table = this.tables.get(ast.table);
    const cols = ast.columns ?? table.columns.map((c) => c.name);
    if (ast.values.length !== cols.length) throw new Error('insert: values count mismatch with columns');
    const row = {};
    cols.forEach((col, i) => {
      row[col] = ast.values[i];
    });
    return row;
  }

  begin() {
    this.fm.rollback(); // discard anything staged before the transaction begins
  }
  commit() {
    for (const table of this.tables.values()) this.syncTableMeta(table);
    this.fm.commit();
  }
  rollback() {
    this.fm.rollback();
    // Uncommitted changes were never flushed; reset each tree to its last committed root.
    for (const table of this.tables.values()) {
      table.rootPage = table.committedRootPage;
      table.nextId = table.committedNextId;
      table.bt = new BTree(this.fm, table.rootPage);
    }
  }
}
