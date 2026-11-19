// src/engine.mjs — SQL facade over FileManager + BTree.
//
// Tables live in the DB meta page (FileManager.tables): { name, columns, rootPage, nextId }.
// Row values are encoded as typed blobs, keyed by the table's key column (PRIMARY KEY).
// `execSql` auto-commits; `begin`/`commit`/`rollback` control multi-statement transactions.

import { FileManager, serializeLeaf, LEAF } from './fs.mjs';
import { BTree } from './btree.mjs';
import { parse as parseAst } from './parser.mjs';

const VALUE_TYPES = { integer: 0, text: 1 };

/** `c.name` -> `name`; plain names pass through (used for output labels). */
const bareName = (name) => {
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(dot + 1) : name;
};

/**
 * Secondary indexes are B-trees keyed by a 32-bit hash of the column value,
 * because B-tree keys are u32. A hash collision just means a bucket with
 * several row ids — lookups re-check the real column value, so correctness
 * never depends on the hash being collision-free.
 */
export function hashValue(v) {
  const s = typeof v === 'number' ? `n:${v}` : `s:${v === undefined ? '' : String(v)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Index entry payload: [count u32][rowId u32 ...]. */
const decodeBucket = (buf) => {
  if (!buf || buf.length < 4) return [];
  const n = buf.readUInt32LE(0);
  return Array.from({ length: n }, (_, i) => buf.readUInt32LE(4 + 4 * i));
};
const encodeBucket = (ids) => {
  const b = Buffer.alloc(4 + 4 * ids.length);
  b.writeUInt32LE(ids.length, 0);
  ids.forEach((id, i) => b.writeUInt32LE(id, 4 + 4 * i));
  return b;
};

/** Evaluate one WHERE/HAVING condition, reading values through `getVal(name)`. */
function conditionMatches(cond, getVal) {
  const actual = getVal(cond.col);
  const other = cond.valueCol !== undefined ? getVal(cond.valueCol) : cond.value;
  const between = (v) => v >= cond.values[0] && v <= cond.values[1];
  switch (cond.op) {
    case '=':
      return actual === other;
    case '!=':
    case '<>':
      return actual !== other;
    case '>':
      return actual > other;
    case '<':
      return actual < other;
    case '>=':
      return actual >= other;
    case '<=':
      return actual <= other;
    case 'between':
      return between(actual);
    default:
      throw new Error(`engine: unsupported condition op '${cond.op}'`);
  }
}

function matchesWhere(where, getVal) {
  return where.conditions.every((c) => conditionMatches(c, getVal));
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
      const indexes = (t.indexes ?? []).map((ix) => ({ ...ix, committedRootPage: ix.rootPage, bt: new BTree(db.fm, ix.rootPage) }));
      db.tables.set(t.name, { name: t.name, columns: t.columns, rootPage: t.rootPage, nextId: t.nextId, committedRootPage: t.rootPage, committedNextId: t.nextId, indexes, bt: new BTree(db.fm, t.rootPage) });
    }
    return db;
  }

  keyColumnOf(table) {
    return table.columns.find((c) => c.isKey) ?? table.columns[0];
  }

  createTable(name, columns) {
    const keyCol = columns.find((c) => c.isKey) ?? columns[0];
    // B-tree keys are u32, so the row key must be an INTEGER column.
    if (!keyCol || keyCol.type !== 'INTEGER') throw new Error(`createTable: key column of '${name}' must be INTEGER`);
    const rootPage = this.fm.allocatePage();
    this.fm.writePage(rootPage, serializeLeaf({ type: LEAF, pageNum: rootPage, entries: [] }));
    const table = { name, columns, rootPage, nextId: 1, committedRootPage: rootPage, committedNextId: 1, indexes: [], bt: new BTree(this.fm, rootPage) };
    this.tables.set(name, table);
    this.fm.tables.push({ name, columns, rootPage, nextId: 1, indexes: [] });
    this.fm.writeMeta();
    return table;
  }

  /**
   * CREATE INDEX name ON table (column) — builds a secondary B-tree over every
   * existing row. Index entries map hash(value) -> [rowId...].
   */
  createIndex(tableName, column, name = null) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`createIndex: no such table '${tableName}'`);
    if (!table.columns.some((c) => c.name === column)) throw new Error(`createIndex: no column '${column}' on '${tableName}'`);
    const idxName = name ?? `idx_${tableName}_${column}`;
    if (table.indexes.some((ix) => ix.name === idxName)) throw new Error(`createIndex: '${idxName}' already exists`);
    const rootPage = this.fm.allocatePage();
    this.fm.writePage(rootPage, serializeLeaf({ type: LEAF, pageNum: rootPage, entries: [] }));
    const idx = { name: idxName, column, rootPage, committedRootPage: rootPage, bt: new BTree(this.fm, rootPage) };
    for (const { key, value } of table.bt.scan(null)) {
      this.indexAdd(idx, this.queryRow(table, key, value)[column], key);
    }
    table.indexes.push(idx);
    this.fm.writeMeta();
    return idx;
  }

  indexAdd(idx, value, rowId) {
    const h = hashValue(value);
    const found = idx.bt.find(h);
    const ids = found.found ? decodeBucket(found.value) : [];
    if (!ids.includes(rowId)) ids.push(rowId);
    idx.bt.insert(h, encodeBucket(ids));
    idx.rootPage = idx.bt.rootPage;
  }

  indexRemove(idx, value, rowId) {
    const h = hashValue(value);
    const found = idx.bt.find(h);
    if (!found.found) return;
    const ids = decodeBucket(found.value).filter((id) => id !== rowId);
    if (ids.length) idx.bt.insert(h, encodeBucket(ids));
    else idx.bt.delete(h);
    idx.rootPage = idx.bt.rootPage;
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
    for (const ix of table.indexes) this.indexAdd(ix, row[ix.column], key);
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
      meta.indexes = table.indexes.map((ix) => ({ name: ix.name, column: ix.column, rootPage: ix.rootPage }));
    }
    table.committedRootPage = table.rootPage;
    table.committedNextId = table.nextId;
    for (const ix of table.indexes) ix.committedRootPage = ix.rootPage;
  }

  /**
   * Shared WHERE-filter builder. Returns a `scan` filter or null.
   * Supports =, !=, <>, >, <, >=, <=, BETWEEN and AND-chains on the key or data columns.
   */
  buildFilter(table, where) {
    if (!where) return null;
    return (key, value) => {
      const row = this.queryRow(table, key, value);
      return matchesWhere(where, (name) => row[name]);
    };
  }

  queryRow(table, key, value) {
    const keyCol = this.keyColumnOf(table);
    return { [keyCol.name]: key, ...decodeValue(table, value) };
  }

  /**
   * Resolve `col` or `alias.col` against a joined row object ({ alias: row }).
   * An unqualified name searches every source; if several tables expose it,
   * the first one in FROM order wins (documented limitation — qualify to be safe).
   */
  resolveCol(joined, name) {
    const dot = name.indexOf('.');
    if (dot > 0) {
      const src = joined[name.slice(0, dot)];
      return src ? src[name.slice(dot + 1)] : undefined;
    }
    for (const row of Object.values(joined)) {
      if (row && Object.prototype.hasOwnProperty.call(row, name)) return row[name];
    }
    return undefined;
  }

  /**
   * Aggregate value for one SELECT item over the rows of a group:
   * count(*) = row count, count(col) = non-null values, sum/avg/min/max.
   * `get(row, col)` resolves column names for joined rows.
   */
  aggregate(item, rows, get) {
    if (item.fn === 'count') {
      if (item.col == null) return rows.length;
      return rows.filter((r) => get(r, item.col) !== undefined).length;
    }
    const vals = item.col == null ? [] : rows.map((r) => get(r, item.col)).filter((v) => v !== undefined);
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
   * Read the rows of one table, using a secondary index when the WHERE clause
   * has an equality on an indexed column (other conditions still apply).
   */
  scanRows(table, where, alias = null) {
    // Resolve `col` and `alias.col` against a plain row of this table.
    const getter = (row) => (name) => {
      if (!name.includes('.')) return row[name];
      const a = name.slice(0, name.indexOf('.'));
      return alias && a === alias ? row[bareName(name)] : undefined;
    };
    const eq = where?.conditions.find((c) => c.op === '=' && c.valueCol === undefined && (!c.col.includes('.') || (alias && c.col.slice(0, c.col.indexOf('.')) === alias)));
    if (eq) {
      const col = bareName(eq.col);
      const idx = (table.indexes ?? []).find((ix) => ix.column === col);
      if (idx) {
        const found = idx.bt.find(hashValue(eq.value));
        const rows = [];
        for (const id of found.found ? decodeBucket(found.value) : []) {
          const e = table.bt.find(id);
          if (!e.found) continue;
          const row = this.queryRow(table, id, e.value);
          if (matchesWhere(where, getter(row))) rows.push(row);
        }
        return { rows, usedIndex: idx.name };
      }
    }
    const filter = where ? (key, value) => matchesWhere(where, getter(this.queryRow(table, key, value))) : null;
    return { rows: [...table.bt.scan(filter)].map((e) => this.queryRow(table, e.key, e.value)), usedIndex: null };
  }

  /**
   * SELECT execution: nested-loop joins (INNER / LEFT / comma-cross), grouping,
   * aggregates, HAVING, ORDER BY and LIMIT/OFFSET.
   * AST shape: { table, from, joins, selectItems, where, groupBy, having, orderBy, limit, offset }.
   */
  execSelect(ast) {
    const from = ast.from ?? { table: ast.table, alias: null };
    const base = this.tables.get(from.table);
    if (!base) throw new Error(`select: no such table '${from.table}'`);

    const sources = [{ alias: from.alias ?? from.table, table: base, join: null }];
    for (const j of ast.joins ?? []) {
      const t = this.tables.get(j.table);
      if (!t) throw new Error(`select: no such table '${j.table}'`);
      sources.push({ alias: j.alias ?? j.table, table: t, join: j });
    }

    const rowsOf = (t) => [...t.bt.scan(null)].map((e) => this.queryRow(t, e.key, e.value));

    // Single-table reads can use a secondary index for equality predicates.
    const singleTable = sources.length === 1;
    const baseRows = singleTable ? this.scanRows(base, ast.where, sources[0].alias).rows : rowsOf(base);

    // Nested-loop join: start with the base rows, then multiply by each join source.
    let joined = baseRows.map((r) => ({ [sources[0].alias]: r }));
    for (let si = 1; si < sources.length; si++) {
      const src = sources[si];
      const other = rowsOf(src.table);
      const next = [];
      for (const left of joined) {
        let matched = false;
        for (const right of other) {
          const cand = { ...left, [src.alias]: right };
          if (src.join.on) {
            const lv = this.resolveCol(cand, src.join.on.left);
            const rv = this.resolveCol(cand, src.join.on.right);
            if (lv !== rv) continue;
          }
          next.push(cand);
          matched = true;
        }
        if (!matched && src.join.type === 'left') next.push({ ...left, [src.alias]: null });
      }
      joined = next;
    }

    const get = (row, name) => this.resolveCol(row, name);

    const rows = !singleTable && ast.where
      ? joined.filter((row) => matchesWhere(ast.where, (name) => get(row, name)))
      : joined;

    // Columns exposed by more than one source get an `alias.col` key in `SELECT *`.
    const dupNames = new Set();
    const seen = new Set();
    for (const s of sources) {
      for (const c of s.table.columns) {
        if (seen.has(c.name)) dupNames.add(c.name);
        seen.add(c.name);
      }
    }
    const starKey = (src, colName) => (dupNames.has(colName) ? `${src.alias}.${colName}` : colName);

    // Grouping semantics:
    //  - GROUP BY present            -> one group per distinct groupBy value
    //  - aggregates, no GROUP BY     -> a single group of all rows
    //  - otherwise                   -> one singleton group per row
    const hasAgg = ast.selectItems.some((i) => i.kind === 'agg');
    const groups = new Map();
    // Aggregates without GROUP BY always produce exactly one row, even over zero rows.
    if (hasAgg && !ast.groupBy) groups.set('__all__', { row: {}, rows: [] });
    let gid = 0;
    for (const row of rows) {
      const gkey = ast.groupBy
        ? ast.groupBy.map((c) => JSON.stringify(get(row, c.name))).join('|')
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

    const entries = [];
    for (const g of groups.values()) {
      const out = {};
      if (ast.groupBy) for (const c of ast.groupBy) out[c.name] = get(g.row, c.name);
      for (const item of ast.selectItems) {
        if (item.kind === 'col') {
          const isStar = item.name === '*' || item.name.endsWith('.*');
          if (isStar) {
            const only = item.name === '*' ? null : item.name.slice(0, -2);
            for (const src of sources) {
              if (only && src.alias !== only) continue;
              const r = g.row[src.alias];
              for (const col of src.table.columns) {
                out[starKey(src, col.name)] = r ? r[col.name] : undefined;
              }
            }
          } else {
            out[item.alias ?? bareName(item.name)] = get(g.row, item.name);
          }
        } else {
          const aggKey = item.alias ?? `${item.fn}${item.col ? `(${item.col})` : '(*)'}`;
          out[aggKey] = this.aggregate(item, g.rows, get);
        }
      }
      if (ast.having && !conditionMatches(ast.having, (name) => out[name])) continue;
      entries.push({ out, srcRow: g.row });
    }

    const sortKeys = ast.orderByKeys ?? (ast.orderBy ? [ast.orderBy] : null);
    if (sortKeys) {
      const val = (e, col) => {
        const v = e.out[col];
        return v !== undefined ? v : get(e.srcRow, col);
      };
      entries.sort((a, b) => {
        for (const k of sortKeys) {
          const av = val(a, k.col);
          const bv = val(b, k.col);
          if (av === bv) continue;
          return (av < bv ? -1 : 1) * (k.dir === 'DESC' ? -1 : 1);
        }
        return 0;
      });
    }

    const columns = ast.selectItems.flatMap((item) => {
      const isStar = item.kind === 'col' && (item.name === '*' || item.name.endsWith('.*'));
      if (isStar) {
        const only = item.name === '*' ? null : item.name.slice(0, -2);
        return sources
          .filter((s) => !only || s.alias === only)
          .flatMap((s) => s.table.columns.map((c) => starKey(s, c.name)));
      }
      if (item.kind === 'col') return [item.alias ?? bareName(item.name)];
      return [item.alias ?? `${item.fn}${item.col ? `(${item.col})` : '(*)'}`];
    });
    return { rows: entries.slice(ast.offset ?? 0, ast.limit != null ? (ast.offset ?? 0) + ast.limit : undefined).map((e) => e.out), columns };
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
    const from = ast.from ?? { table: ast.table };
    const table = this.tables.get(from.table);
    const stats = table.bt.stats();
    const joins = ast.joins ?? [];
    if (joins.length) {
      const jstats = joins.map((j) => this.tables.get(j.table).bt.stats());
      return {
        strategy: 'nested-loop-join',
        pages: stats.pageCount + jstats.reduce((a, s) => a + s.pageCount, 0),
        rowsEstimate: jstats.reduce((a, s) => a * s.entryCount, stats.entryCount),
      };
    }
    if (!ast.where) return { strategy: 'full-scan', pages: stats.pageCount, rowsEstimate: stats.entryCount };
    const eq = ast.where.conditions.find((c) => c.op === '=' && c.valueCol === undefined);
    if (eq) {
      const col = bareName(eq.col);
      if (col === this.keyColumnOf(table).name) return { strategy: 'index-seek', pages: stats.depth + 1, rowsEstimate: 1 };
      const idx = (table.indexes ?? []).find((ix) => ix.column === col);
      if (idx) {
        const istats = idx.bt.stats();
        return { strategy: 'secondary-index-seek', pages: istats.depth + 1, rowsEstimate: 1 };
      }
    }
    // Filtered scan: still reads every leaf page, but only keeps matching rows.
    return { strategy: 'full-scan', pages: stats.pageCount, rowsEstimate: stats.entryCount, filtered: true };
  }

  execSql(sql) {
    const ast = parseAst(sql);
    if (ast.type === 'createTable') {
      this.createTable(ast.name, ast.columns);
      this.commit(); // DDL is committed eagerly
      return { rows: [], columns: [], plan: null };
    }
    if (ast.type === 'createIndex') {
      this.createIndex(ast.table, ast.column, ast.name);
      this.commit();
      return { rows: [], columns: [], plan: null, index: ast.name ?? `idx_${ast.table}_${ast.column}` };
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
      const oldRow = this.queryRow(table, key, value);
      const newRow = { ...oldRow, ...Object.fromEntries(sets.map((s) => [s.col, s.value])) };
      if (!table.bt.update(key, encodeValue(table, newRow))) throw new Error(`update: key ${key} not found`);
      for (const ix of table.indexes) {
        if (oldRow[ix.column] !== newRow[ix.column]) {
          this.indexRemove(ix, oldRow[ix.column], key);
          this.indexAdd(ix, newRow[ix.column], key);
        }
      }
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
      const e = table.bt.find(key);
      if (!e.found) continue;
      const row = this.queryRow(table, key, e.value);
      for (const ix of table.indexes) this.indexRemove(ix, row[ix.column], key);
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
      for (const ix of table.indexes) {
        ix.rootPage = ix.committedRootPage;
        ix.bt = new BTree(this.fm, ix.rootPage);
      }
    }
  }
}
