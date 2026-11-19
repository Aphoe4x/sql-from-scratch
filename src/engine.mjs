// src/engine.mjs — SQL facade over FileManager + BTree.
//
// Tables live in the DB meta page (FileManager.tables): { name, columns, rootPage, nextId }.
// Row values are encoded as typed blobs, keyed by the table's key column (PRIMARY KEY).
// `execSql` auto-commits; `begin`/`commit`/`rollback` control multi-statement transactions.

import { FileManager, serializeLeaf, LEAF } from './fs.mjs';
import { BTree } from './btree.mjs';
import { parse as parseAst } from './parser.mjs';

const VALUE_TYPES = { integer: 0, text: 1 };

/** Evaluate one WHERE/HAVING condition against a row object. */
function conditionMatches(cond, row) {
  const actual = row[cond.col];
  switch (cond.op) {
    case '=':
      return actual === cond.value;
    case '!=':
    case '<>':
      return actual !== cond.value;
    case '>':
      return actual > cond.value;
    case '<':
      return actual < cond.value;
    case '>=':
      return actual >= cond.value;
    case '<=':
      return actual <= cond.value;
    case 'between':
      return actual >= cond.values[0] && actual <= cond.values[1];
    default:
      throw new Error(`engine: unsupported condition op '${cond.op}'`);
  }
}

function matchesWhere(where, row) {
  return where.conditions.every((c) => conditionMatches(c, row));
}

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

  /**
   * Shared WHERE-filter builder. Returns a `scan` filter or null.
   * Supports =, !=, <>, >, <, >=, <=, BETWEEN and AND-chains on the key or data columns.
   */
  buildFilter(table, where) {
    if (!where) return null;
    return (key, value) => matchesWhere(where, this.queryRow(table, key, value));
  }

  queryRow(table, key, value) {
    const keyCol = this.keyColumnOf(table);
    return { [keyCol.name]: key, ...decodeValue(table, value) };
  }

  /**
   * Aggregate value for one SELECT item over the rows of a group:
   * count(*) = row count, count(col) = non-null values, sum/avg/min/max.
   */
  aggregate(item, rows, table) {
    if (item.fn === 'count') {
      if (item.col == null) return rows.length;
      return rows.filter((r) => r[item.col] !== undefined).length;
    }
    const vals = item.col == null ? [] : rows.map((r) => r[item.col]).filter((v) => v !== undefined);
    switch (item.fn) {
      case 'sum':
        return vals.reduce((a, b) => a + b, 0);
      case 'avg':
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      case 'min':
        return vals.length ? Math.min(...vals) : null;
      case 'max':
        return vals.length ? Math.max(...vals) : null;
      default:
        throw new Error(`aggregate: unsupported function '${item.fn}'`);
    }
  }

  /**
   * SELECT execution with grouping and aggregates.
   * AST shape: { table, selectItems, where, groupBy, having, orderBy }.
   */
  execSelect(ast) {
    const table = this.tables.get(ast.table);
    if (!table) throw new Error(`select: no such table '${ast.table}'`);
    const filter = this.buildFilter(table, ast.where);
    const rows = [...table.bt.scan(filter)].map((e) => this.queryRow(table, e.key, e.value));

    // Grouping semantics:
    //  - GROUP BY present            -> one group per distinct groupBy value
    //  - aggregates, no GROUP BY     -> a single group of all rows
    //  - otherwise                   -> one singleton group per row
    const hasAgg = ast.selectItems.some((i) => i.kind === 'agg');
    const groups = new Map();
    let gid = 0;
    for (const row of rows) {
      const gkey = ast.groupBy
        ? ast.groupBy.map((c) => JSON.stringify(row[c.name])).join('|')
        : hasAgg
          ? '__all__'
          : `__row_${gid++}`;
      let g = groups.get(gkey);
      if (!g) {
        g = { row, rows: [] };
        groups.set(gkey, g);
      }
      g.rows.push(row);
    }

    const outputs = [];
    for (const g of groups.values()) {
      const out = {};
      if (ast.groupBy) for (const c of ast.groupBy) out[c.name] = g.row[c.name];
      for (const item of ast.selectItems) {
        if (item.kind === 'col') {
          if (item.name === '*') {
            for (const c of table.columns) out[c.name] = g.row[c.name];
          } else {
            out[item.alias ?? item.name] = g.row[item.name];
          }
        } else {
          const aggKey = item.alias ?? `${item.fn}${item.col ? `(${item.col})` : '(*)'}`;
          out[aggKey] = this.aggregate(item, g.rows, table);
        }
      }
      if (ast.having && !conditionMatches(ast.having, out)) continue;
      outputs.push(out);
    }

    if (ast.orderBy) {
      const dir = ast.orderBy.dir === 'DESC' ? -1 : 1;
      outputs.sort((a, b) => {
        const av = a[ast.orderBy.col];
        const bv = b[ast.orderBy.col];
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * dir;
      });
    }

    const columns = ast.selectItems.flatMap((item) => {
      if (item.kind === 'col' && item.name === '*') return table.columns.map((c) => c.name);
      if (item.kind === 'col') return [item.alias ?? item.name];
      return [item.alias ?? `${item.fn}${item.col ? `(${item.col})` : '(*)'}`];
    });
    return { rows: outputs, columns };
  }

  query(tableName, { where = null, orderBy = null, columns = null } = {}) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`query: no such table '${tableName}'`);
    const filter = this.buildFilter(table, where);
    let rows = [];
    for (const { key, value } of table.bt.scan(filter)) {
      rows.push(this.queryRow(table, key, value));
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
    if (ast.type === 'update') {
      const updated = this.update(ast.table, ast.sets, ast.where);
      this.commit();
      return { rows: [], columns: [], updated, plan: null };
    }
    if (ast.type === 'delete') {
      const deleted = this.delete(ast.table, ast.where);
      this.commit();
      return { rows: [], columns: [], deleted, plan: null };
    }
    if (ast.type === 'select') {
      return { ...this.execSelect(ast), plan: this.plan(ast) };
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

  /**
   * UPDATE t SET col = v [, col = v ...] [WHERE c = v]
   * Returns the number of rows updated.
   */
  update(tableName, sets, where = null) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`update: no such table '${tableName}'`);
    const filter = this.buildFilter(table, where);
    let updated = 0;
    for (const { key, value } of table.bt.scan(filter)) {
      const newRow = { ...this.queryRow(table, key, value), ...Object.fromEntries(sets.map((s) => [s.col, s.value])) };
      if (!table.bt.update(key, encodeValue(table, newRow))) throw new Error(`update: key ${key} not found`);
      updated++;
    }
    return updated;
  }

  /**
   * DELETE FROM t [WHERE c = v] — collect keys first (tree mutates during delete).
   * Returns the number of rows deleted.
   */
  delete(tableName, where = null) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`delete: no such table '${tableName}'`);
    const filter = this.buildFilter(table, where);
    const keys = [...table.bt.scan(filter)].map((e) => e.key);
    let deleted = 0;
    for (const key of keys) {
      if (table.bt.delete(key)) deleted++;
    }
    return deleted;
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
