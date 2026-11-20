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

/** Deduplicate aggregate inputs, keeping first-seen order (1 and '1' differ). */
function distinctValues(vals) {
  const seen = new Set();
  const out = [];
  for (const v of vals) {
    const k = typeof v === 'number' ? `n:${v}` : `s:${v}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}
const distinctCount = (vals) => distinctValues(vals).length;

/** SQL LIKE: `%` = any run of characters, `_` = exactly one character. */
function likeRegex(pattern) {
  let re = '^';
  for (const ch of String(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`);
}
const likeCache = new Map();
function likeMatches(value, pattern) {
  if (value === undefined || value === null) return false;
  let re = likeCache.get(pattern);
  if (!re) {
    re = likeRegex(pattern);
    likeCache.set(pattern, re);
  }
  return re.test(String(value));
}

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
    case 'in':
      return cond.values.includes(actual);
    case 'not-in':
      return !cond.values.includes(actual);
    case 'like':
      return likeMatches(actual, cond.value);
    case 'not-like':
      return !likeMatches(actual, cond.value);
    default:
      throw new Error(`engine: unsupported condition op '${cond.op}'`);
  }
}

/**
 * Evaluate a WHERE/HAVING tree. Nodes are either comparisons, an implicit AND
 * group `{ conditions: [...] }`, or `{ op: 'or', conditions: [...] }`.
 */
function matchesCondition(cond, getVal) {
  if (cond.op === 'or') return cond.conditions.some((c) => matchesCondition(c, getVal));
  if (Array.isArray(cond.conditions)) return cond.conditions.every((c) => matchesCondition(c, getVal));
  return conditionMatches(cond, getVal);
}

function matchesWhere(where, getVal) {
  return matchesCondition(where, getVal);
}

/** Arithmetic for SELECT expressions: `+ - * /` are numeric, `||` concatenates. */
function applyArith(op, a, b) {
  if (op === '||') return `${a ?? ''}${b ?? ''}`;
  if (a === undefined || a === null || b === undefined || b === null) return null;
  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return null;
  switch (op) {
    case '+':
      return na + nb;
    case '-':
      return na - nb;
    case '*':
      return na * nb;
    case '/':
      return nb === 0 ? null : na / nb;
    default:
      return null;
  }
}

/** Column names referenced by a SELECT expression tree. */
function exprColumns(expr) {
  if (expr.kind === 'col') return [expr.name];
  if (expr.kind === 'lit') return [];
  return [...exprColumns(expr.left), ...exprColumns(expr.right)];
}

/** Text form of an expression, used as the output column name when no alias. */
function exprText(expr) {
  if (expr.kind === 'col') return bareName(expr.name);
  if (expr.kind === 'lit') return String(expr.value);
  return `${exprText(expr.left)} ${expr.op} ${exprText(expr.right)}`;
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

  createTable(name, columns, ifNotExists = false) {
    if (this.tables.has(name)) {
      if (ifNotExists) return this.tables.get(name);
      throw new Error(`createTable: table '${name}' already exists`);
    }
    for (const c of columns) c.notNull = !!c.notNull;
    const names = new Set();
    for (const c of columns) {
      if (names.has(c.name)) throw new Error(`createTable: duplicate column '${c.name}'`);
      names.add(c.name);
    }
    const keyCol = columns.find((c) => c.isKey) ?? columns[0];
    // B-tree keys are u32, so the row key must be an INTEGER column.
    if (!keyCol || keyCol.type !== 'INTEGER') throw new Error(`createTable: key column of '${name}' must be INTEGER`);
    const rootPage = this.fm.allocatePage();
    this.fm.writePage(rootPage, serializeLeaf({ type: LEAF, pageNum: rootPage, entries: [] }));
    const table = { name, columns, rootPage, nextId: 1, committedRootPage: rootPage, committedNextId: 1, indexes: [], bt: new BTree(this.fm, rootPage) };
    this.tables.set(name, table);
    this.fm.tables.push({ name, columns, rootPage, nextId: 1, indexes: [] });
    // The meta page is committed atomically with the data pages by commit().
    return table;
  }

  /**
   * CREATE INDEX name ON table (column) — builds a secondary B-tree over every
   * existing row. Index entries map hash(value) -> [rowId...].
   */
  createIndex(tableName, column, name = null, unique = false, ifNotExists = false) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`createIndex: no such table '${tableName}'`);
    if (!table.columns.some((c) => c.name === column)) throw new Error(`createIndex: no column '${column}' on '${tableName}'`);
    const idxName = name ?? `idx_${tableName}_${column}`;
    const existing = table.indexes.find((ix) => ix.name === idxName);
    if (existing) {
      if (ifNotExists) return existing;
      throw new Error(`createIndex: '${idxName}' already exists`);
    }

    // Validate UNIQUE before allocating pages, so a failed build leaves nothing behind.
    if (unique) {
      const seenVals = new Map();
      for (const { key, value } of table.bt.scan(null)) {
        const v = this.queryRow(table, key, value)[column];
        const vk = `${typeof v}:${v}`;
        if (seenVals.has(vk)) throw new Error(`createIndex: duplicate value ${JSON.stringify(v)} in '${tableName}.${column}'`);
        seenVals.set(vk, key);
      }
    }

    const rootPage = this.fm.allocatePage();
    this.fm.writePage(rootPage, serializeLeaf({ type: LEAF, pageNum: rootPage, entries: [] }));
    const idx = { name: idxName, column, unique: !!unique, rootPage, committedRootPage: rootPage, bt: new BTree(this.fm, rootPage) };
    for (const { key, value } of table.bt.scan(null)) {
      this.indexAdd(idx, this.queryRow(table, key, value)[column], key);
    }
    table.indexes.push(idx);
    return idx;
  }

  /**
   * ALTER TABLE t ADD [COLUMN] c TYPE [NOT NULL] [DEFAULT literal].
   * The row encoding is positional, so every stored row is re-encoded with the
   * new trailing column (DEFAULT, else ''/0). Existing secondary indexes point
   * at row ids, so they survive unchanged. Rows are deleted and reinserted
   * rather than updated in place, so leaves that grow are split normally.
   */
  alterTableAddColumn(tableName, col) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`alterTable: no such table '${tableName}'`);
    if (table.columns.some((c) => c.name === col.name)) throw new Error(`alterTable: column '${col.name}' already exists on '${tableName}'`);
    const type = String(col.type).toUpperCase();
    if (type !== 'INTEGER' && type !== 'TEXT') throw new Error(`alterTable: unsupported type '${col.type}' (use INTEGER or TEXT)`);

    const oldColumns = table.columns;
    const newColumn = { name: col.name, type, isKey: false, notNull: !!col.notNull, defaultValue: col.defaultValue };
    const newColumns = [...oldColumns, newColumn];
    const rows = [...table.bt.scan(null)].map(({ key, value }) => ({ key, row: this.queryRow({ columns: oldColumns }, key, value) }));

    if (newColumn.notNull && newColumn.defaultValue === undefined && rows.length) {
      throw new Error(`alterTable: column '${col.name}' is NOT NULL with no DEFAULT, but '${tableName}' has ${rows.length} row(s)`);
    }
    const fill = newColumn.defaultValue !== undefined ? newColumn.defaultValue : type === 'TEXT' ? '' : 0;
    const encoded = rows.map(({ key, row }) => ({ key, blob: encodeValue({ columns: newColumns }, { ...row, [col.name]: fill }) }));

    for (const { key } of encoded) table.bt.delete(key);
    for (const { key, blob } of encoded) table.bt.insert(key, blob);
    table.columns = newColumns;
    table.rootPage = table.bt.rootPage;

    const meta = this.fm.tables.find((t) => t.name === tableName);
    if (meta) meta.columns = newColumns;
    return { table: tableName, column: col.name, rows: encoded.length };
  }

  /**
   * ALTER TABLE t RENAME TO t2 — changes the directory entry only; pages,
   * rows and secondary indexes are untouched.
   */
  renameTable(tableName, newName) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`alterTable: no such table '${tableName}'`);
    if (tableName === newName) return { table: newName, from: tableName, renamed: false };
    if (this.tables.has(newName)) throw new Error(`alterTable: table '${newName}' already exists`);
    const meta = this.fm.tables.find((t) => t.name === tableName);
    this.tables.delete(tableName);
    table.name = newName;
    this.tables.set(newName, table);
    if (meta) meta.name = newName;
    return { table: newName, from: tableName, renamed: true };
  }

  /**
   * ALTER TABLE t RENAME [COLUMN] a TO b — pure metadata: the row encoding is
   * positional and secondary indexes store the column name, so both the
   * directory entry and the index definitions are updated in place.
   */
  renameColumn(tableName, from, to) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`alterTable: no such table '${tableName}'`);
    const pos = table.columns.findIndex((c) => c.name === from);
    if (pos === -1) throw new Error(`alterTable: no column '${from}' on '${tableName}'`);
    if (from === to) return { table: tableName, from, to, renamed: false };
    if (table.columns.some((c) => c.name === to)) throw new Error(`alterTable: column '${to}' already exists on '${tableName}'`);
    const columns = table.columns.map((c, i) => (i === pos ? { ...c, name: to } : c));
    table.columns = columns;
    const renamedIndexes = [];
    for (const ix of table.indexes) {
      if (ix.column === from) {
        ix.column = to;
        renamedIndexes.push(ix.name);
      }
    }
    const meta = this.fm.tables.find((t) => t.name === tableName);
    if (meta) {
      meta.columns = columns;
      meta.indexes = table.indexes.map((ix) => ({ name: ix.name, column: ix.column, rootPage: ix.rootPage, unique: !!ix.unique }));
    }
    return { table: tableName, from, to, renamed: true, indexes: renamedIndexes };
  }

  /**
   * ALTER TABLE t DROP [COLUMN] c — re-encodes every row without that column
   * and drops any secondary index built on it (its pages go to the freelist).
   * The primary-key column cannot be dropped: it is the row identity.
   */
  dropColumn(tableName, colName) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`alterTable: no such table '${tableName}'`);
    const dropped = table.columns.find((c) => c.name === colName);
    if (!dropped) throw new Error(`alterTable: no column '${colName}' on '${tableName}'`);
    if (dropped.isKey) throw new Error(`alterTable: cannot drop the primary key column '${colName}'`);
    if (table.columns.length === 1) throw new Error(`alterTable: cannot drop the only column on '${tableName}'`);

    const removedIndexes = table.indexes.filter((ix) => ix.column === colName);
    const keptIndexes = table.indexes.filter((ix) => ix.column !== colName);
    const oldColumns = table.columns;
    const newColumns = oldColumns.filter((c) => c.name !== colName);
    const rows = [...table.bt.scan(null)].map(({ key, value }) => ({ key, row: this.queryRow({ columns: oldColumns }, key, value) }));
    // Encode everything first so a failure cannot leave half the table rewritten.
    const encoded = rows.map(({ key, row }) => ({ key, blob: encodeValue({ columns: newColumns }, row) }));

    let freed = 0;
    for (const ix of removedIndexes) {
      for (const p of ix.bt.pages()) {
        this.fm.freePage(p);
        freed++;
      }
    }
    for (const { key } of encoded) table.bt.delete(key);
    for (const { key, blob } of encoded) table.bt.insert(key, blob);
    table.columns = newColumns;
    table.indexes = keptIndexes;
    table.rootPage = table.bt.rootPage;
    const meta = this.fm.tables.find((t) => t.name === tableName);
    if (meta) meta.columns = newColumns;
    return { table: tableName, droppedColumn: colName, rows: encoded.length, indexesDropped: removedIndexes.map((ix) => ix.name), pages: freed };
  }

  /**
   * CREATE TABLE name AS SELECT ...
   * The table inherits the SELECT's column names; the first column is used as
   * the key when it is integer-valued (copied as-is), otherwise the table gets
   * a synthesized `id INTEGER PRIMARY KEY` in front and keeps all selected
   * columns as ordinary data columns.
   */
  createTableAsSelect(name, ast, ifNotExists = false) {
    if (this.tables.has(name)) {
      if (ifNotExists) return { table: name, created: false, rows: 0 };
      throw new Error(`createTableAsSelect: table '${name}' already exists`);
    }
    const sel = ast.select.type === 'union' ? this.execUnion(ast.select) : this.execSelect(ast.select);
    const infer = (values) => values.some((v) => typeof v === 'number') ? 'INTEGER' : 'TEXT';
    const info = sel.columns.map((c) => ({ name: c, values: sel.rows.map((r) => r[c]).filter((v) => v !== undefined) }));
    const keyName = info.length && info[0].values.some((v) => typeof v === 'number') ? info[0].name : 'id';
    const columns = [];
    if (keyName === 'id' && !info.some((c) => c.name === 'id')) columns.push({ name: 'id', type: 'INTEGER', isKey: true, notNull: false });
    for (const c of info) {
      columns.push({ name: c.name, type: infer(c.values), isKey: c.name === keyName, notNull: false });
    }
    this.createTable(name, columns, false);
    const table = this.tables.get(name);
    for (const row of sel.rows) {
      const out = {};
      for (const c of table.columns) out[c.name] = row[c.name];
      this.insert(name, out);
    }
    this.commit();
    return { table: name, created: true, rows: sel.rows.length, columns: info.map((c) => c.name) };
  }

  /**
   * DROP TABLE t — frees every page the table's B-tree and secondary indexes
   * own (into the freelist) and removes the table from the directory.
   */
  dropTable(tableName, ifExists = false) {
    const table = this.tables.get(tableName);
    if (!table) {
      if (ifExists) return { dropped: null, pages: 0 };
      throw new Error(`dropTable: no such table '${tableName}'`);
    }
    let pages = 0;
    for (const p of table.bt.pages()) {
      this.fm.freePage(p);
      pages++;
    }
    for (const ix of table.indexes) {
      for (const p of ix.bt.pages()) {
        this.fm.freePage(p);
        pages++;
      }
    }
    this.tables.delete(tableName);
    const i = this.fm.tables.findIndex((t) => t.name === tableName);
    if (i !== -1) this.fm.tables.splice(i, 1);
    return { dropped: tableName, pages };
  }

  /**
   * DROP INDEX name [ON table] — frees the index B-tree pages and removes the
   * index from its table. Without ON, the name must be unique across tables.
   */
  dropIndex(name, tableName = null, ifExists = false) {
    const matches = [];
    for (const table of this.tables.values()) {
      if (tableName && table.name !== tableName) continue;
      const pos = table.indexes.findIndex((ix) => ix.name === name);
      if (pos !== -1) matches.push({ table, pos });
    }
    if (matches.length === 0) {
      if (ifExists) return { index: null, table: tableName, pages: 0 };
      throw new Error(`dropIndex: no index '${name}'${tableName ? ` on '${tableName}'` : ''}`);
    }
    if (matches.length > 1) throw new Error(`dropIndex: index '${name}' is ambiguous; use DROP INDEX ${name} ON <table>`);
    const { table, pos } = matches[0];
    const idx = table.indexes[pos];
    let pages = 0;
    for (const p of idx.bt.pages()) {
      this.fm.freePage(p);
      pages++;
    }
    table.indexes.splice(pos, 1);
    return { index: name, table: table.name, pages };
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

  /** Fill DEFAULTs for missing values and enforce NOT NULL on insert. */
  applyDefaults(table, row) {
    for (const c of table.columns) {
      if (c.isKey) continue;
      const missing = row[c.name] === undefined || row[c.name] === null;
      if (missing && c.defaultValue !== undefined) row[c.name] = c.defaultValue;
      if (c.notNull && (row[c.name] === undefined || row[c.name] === null)) {
        throw new Error(`insert: column '${c.name}' is NOT NULL`);
      }
    }
    return row;
  }

  /** Throw if the row would duplicate a value in any UNIQUE index. */
  checkUnique(table, row, selfKey = null) {
    for (const ix of table.indexes) {
      if (!ix.unique) continue;
      const v = row[ix.column];
      if (v === undefined || v === null) continue;
      const found = ix.bt.find(hashValue(v));
      if (!found.found) continue;
      for (const id of decodeBucket(found.value)) {
        if (id === selfKey) continue;
        const e = table.bt.find(id);
        if (e.found && this.queryRow(table, id, e.value)[ix.column] === v) {
          throw new Error(`unique index '${ix.name}' violated: ${ix.column} = ${JSON.stringify(v)}`);
        }
      }
    }
  }

  insert(tableName, row) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`insert: no such table '${tableName}'`);
    this.applyDefaults(table, row);
    this.checkUnique(table, row);
    const keyCol = this.keyColumnOf(table);
    let key = row[keyCol.name];
    if (key == null) key = table.nextId++;
    else {
      if (typeof key !== 'number') throw new Error(`insert: primary key '${keyCol.name}' must be an integer`);
      if (table.bt.find(key).found) throw new Error(`insert: duplicate primary key ${key}`);
      table.nextId = Math.max(table.nextId, key + 1);
    }
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
      meta.indexes = table.indexes.map((ix) => ({ name: ix.name, column: ix.column, rootPage: ix.rootPage, unique: !!ix.unique }));
    }
    table.committedRootPage = table.rootPage;
    table.committedNextId = table.nextId;
    for (const ix of table.indexes) ix.committedRootPage = ix.rootPage;
  }

  /**
   * Shared WHERE-filter builder. Returns a `scan` filter or null.
   * Supports =, !=, <>, >, <, >=, <=, BETWEEN, IN/NOT IN and AND-chains on the
   * key or data columns.
   */
  buildFilter(table, where) {
    where = this.materializeWhere(where);
    if (!where) return null;
    return (key, value) => {
      const row = this.queryRow(table, key, value);
      return matchesWhere(where, (name) => row[name]);
    };
  }

  /**
   * Replace `IN (SELECT ...)` / `NOT IN (SELECT ...)` in one condition with the
   * literal list of values the subquery returns. The subquery runs once per
   * statement, not once per row.
   */
  materializeCondition(c) {
    if (c.op === 'or' || Array.isArray(c.conditions)) {
      return { ...c, conditions: c.conditions.map((child) => this.materializeCondition(child)) };
    }
    if (c.op !== 'in' && c.op !== 'not-in') return c;
    if (c.values) return c;
    const sub = c.select.type === 'union' ? this.execUnion(c.select) : this.execSelect(c.select);
    if (sub.columns.length !== 1) throw new Error(`IN subquery must return exactly one column (got ${sub.columns.length})`);
    const col = sub.columns[0];
    return { col: c.col, op: c.op, values: sub.rows.map((r) => r[col]) };
  }

  /**
   * Evaluate a SELECT expression tree for one row: `col`, a literal, or
   * `left op right` with `+ - * /` (numeric) and `||` (concatenation).
   * `getVal(name)` resolves a column against the current row.
   */
  execExpr(expr, getVal) {
    if (expr.kind === 'col') return getVal(expr.name);
    if (expr.kind === 'lit') return expr.value;
    const a = this.execExpr(expr.left, getVal);
    const b = this.execExpr(expr.right, getVal);
    return applyArith(expr.op, a, b);
  }

  /** Materialize every IN-subquery in a WHERE tree (AND/OR groups included). */
  materializeWhere(where) {
    if (!where) return null;
    return this.materializeCondition(where);
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
    const valueOf = (row) => (item.arg == null ? undefined : this.execExpr(item.arg, (name) => get(row, name)));
    const values = () => (item.arg == null ? [] : rows.map(valueOf).filter((v) => v !== undefined));
    if (item.fn === 'count') {
      if (item.arg == null) return rows.length;
      const vals = values();
      return item.distinct ? distinctCount(vals) : vals.length;
    }
    let vals = values();
    if (item.distinct) vals = distinctValues(vals);
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
   * True when `column` can be probed directly in `table`: it is the B-tree key
   * column or it has a secondary index.
   */
  isProbeable(table, column) {
    const name = bareName(column);
    if (name === this.keyColumnOf(table).name) return true;
    return (table.indexes ?? []).some((ix) => ix.column === name);
  }

  /**
   * Rows of `table` where `column` equals `value`, via the key or a secondary
   * index. Returns null when there is no way to probe (caller must scan).
   */
  lookupByColumn(table, column, value) {
    const name = bareName(column);
    const keyCol = this.keyColumnOf(table);
    if (name === keyCol.name) {
      if (typeof value !== 'number') return [];
      const e = table.bt.find(value);
      return e.found ? [this.queryRow(table, e.key, e.value)] : [];
    }
    const ix = (table.indexes ?? []).find((i) => i.column === name);
    if (!ix) return null;
    const found = ix.bt.find(hashValue(value));
    const rows = [];
    for (const id of found.found ? decodeBucket(found.value) : []) {
      const e = table.bt.find(id);
      if (!e.found) continue;
      const row = this.queryRow(table, id, e.value);
      if (row[name] === value) rows.push(row); // hash collisions re-checked
    }
    return rows;
  }

  /**
   * For `JOIN ... ON a.x = b.y`, decide which side belongs to the newly joined
   * source (the probe side) and which side is already present (the lookup key).
   * Returns { inner, outer } or null when the ON clause is not a two-column
   * equality between the new source and an earlier one.
   */
  joinLookupSpec(src, earlier, on) {
    if (!on) return null;
    const owner = (name) => {
      const dot = name.indexOf('.');
      if (dot > 0) return name.slice(0, dot) === src.alias ? 'src' : 'outer';
      const inSrc = src.table.columns.some((c) => c.name === name);
      const inEarlier = earlier.some((s) => s.table.columns.some((c) => c.name === name));
      return inSrc && !inEarlier ? 'src' : 'outer';
    };
    const l = owner(on.left);
    const r = owner(on.right);
    if (l === r) return null;
    return l === 'src' ? { inner: on.left, outer: on.right } : { inner: on.right, outer: on.left };
  }

  /**
   * Read the rows of one table, using a secondary index when the WHERE clause
   * has an equality on an indexed column (other conditions still apply).
   */
  scanRows(table, where, alias = null) {
    where = this.materializeWhere(where);
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
    const where = this.materializeWhere(ast.where);
    const having = ast.having ? this.materializeCondition(ast.having) : null;

    const sources = [{ alias: from.alias ?? from.table, table: base, join: null }];
    for (const j of ast.joins ?? []) {
      const t = this.tables.get(j.table);
      if (!t) throw new Error(`select: no such table '${j.table}'`);
      sources.push({ alias: j.alias ?? j.table, table: t, join: j });
    }

    // Reject unknown projected columns instead of silently returning undefined.
    const checkColumn = (name) => {
      const dot = name.indexOf('.');
      if (dot > 0) {
        const alias = name.slice(0, dot);
        const col = name.slice(dot + 1);
        const src = sources.find((s) => s.alias === alias);
        if (!src) throw new Error(`select: no such table alias '${alias}'`);
        if (!src.table.columns.some((c) => c.name === col)) throw new Error(`select: no column '${col}' on '${alias}'`);
        return;
      }
      if (!sources.some((s) => s.table.columns.some((c) => c.name === name))) throw new Error(`select: no column '${name}'`);
    };
    for (const item of ast.selectItems) {
      if (item.kind === 'expr') {
        for (const name of exprColumns(item.expr)) checkColumn(name);
        continue;
      }
      if (item.kind === 'agg') {
        if (item.arg) for (const name of exprColumns(item.arg)) checkColumn(name);
        continue;
      }
      const name = item.kind === 'col' ? item.name : null;
      if (!name) continue;
      if (name === '*') continue;
      if (name.endsWith('.*')) {
        const only = name.slice(0, -2);
        if (!sources.some((s) => s.alias === only)) throw new Error(`select: no such table alias '${only}'`);
        continue;
      }
      checkColumn(name);
    }

    const rowsOf = (t) => [...t.bt.scan(null)].map((e) => this.queryRow(t, e.key, e.value));

    // Single-table reads can use a secondary index for equality predicates.
    const singleTable = sources.length === 1;
    const baseRows = singleTable ? this.scanRows(base, where, sources[0].alias).rows : rowsOf(base);

    // Nested-loop join: start with the base rows, then multiply by each join
    // source. When the ON equality can be probed through the source's key or a
    // secondary index, look up only the matching rows instead of materializing
    // and scanning the whole source for every left row.
    let joined = baseRows.map((r) => ({ [sources[0].alias]: r }));
    for (let si = 1; si < sources.length; si++) {
      const src = sources[si];
      const spec = src.join.on ? this.joinLookupSpec(src, sources.slice(0, si), src.join.on) : null;
      const useIndex = !!spec && this.isProbeable(src.table, spec.inner);
      const other = useIndex ? null : rowsOf(src.table);
      const next = [];
      for (const left of joined) {
        let matched = false;
        let candidates = other;
        if (useIndex) {
          const lv = this.resolveCol(left, spec.outer);
          candidates = lv === undefined ? [] : this.lookupByColumn(src.table, spec.inner, lv);
        }
        for (const right of candidates) {
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

    const rows = !singleTable && where
      ? joined.filter((row) => matchesWhere(where, (name) => get(row, name)))
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
        } else if (item.kind === 'expr') {
          out[item.alias ?? exprText(item.expr)] = this.execExpr(item.expr, (name) => get(g.row, name));
        } else {
          const aggKey = item.alias ?? `${item.fn}(${item.distinct ? 'DISTINCT ' : ''}${item.arg == null ? '*' : exprText(item.arg)})`;
          out[aggKey] = this.aggregate(item, g.rows, get);
        }
      }
      if (having && !matchesCondition(having, (name) => out[name])) continue;
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
      if (item.kind === 'expr') return [item.alias ?? exprText(item.expr)];
      return [item.alias ?? `${item.fn}(${item.distinct ? 'DISTINCT ' : ''}${item.arg == null ? '*' : exprText(item.arg)})`];
    });
    // DISTINCT removes duplicate output rows (after grouping, before ordering).
    let outs = entries;
    if (ast.distinct) {
      const seenRows = new Set();
      outs = entries.filter((e) => {
        const k = JSON.stringify(e.out);
        if (seenRows.has(k)) return false;
        seenRows.add(k);
        return true;
      });
    }

    return { rows: outs.slice(ast.offset ?? 0, ast.limit != null ? (ast.offset ?? 0) + ast.limit : undefined).map((e) => e.out), columns };
  }

  /**
   * UNION / UNION ALL over two or more SELECT branches.
   * Branches run left to right; `UNION` de-duplicates at that point, `UNION ALL`
   * keeps duplicates. Result column names come from the first branch (values are
   * matched positionally). ORDER BY / LIMIT apply to the combined result.
   */
  execUnion(ast) {
    const results = ast.branches.map((b) => this.execSelect(b));
    const columns = results[0].columns;
    for (const r of results) {
      if (r.columns.length !== columns.length) {
        throw new Error(`union: branches return different column counts (${columns.length} vs ${r.columns.length})`);
      }
    }
    const normalize = (r) => r.rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[r.columns[i]]])));
    let acc = normalize(results[0]);
    for (let i = 1; i < results.length; i++) {
      acc = acc.concat(normalize(results[i]));
      if (!ast.all[i - 1]) {
        const seen = new Set();
        acc = acc.filter((row) => {
          const k = JSON.stringify(columns.map((c) => row[c]));
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
    }
    const sortKeys = ast.orderByKeys ?? (ast.orderBy ? [ast.orderBy] : null);
    if (sortKeys) {
      acc.sort((a, b) => {
        for (const k of sortKeys) {
          const av = a[k.col];
          const bv = b[k.col];
          if (av === bv) continue;
          return (av < bv ? -1 : 1) * (k.dir === 'DESC' ? -1 : 1);
        }
        return 0;
      });
    }
    const start = ast.offset ?? 0;
    return { rows: acc.slice(start, ast.limit != null ? start + ast.limit : undefined), columns };
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
    if (ast.type === 'union') {
      const branches = ast.branches.map((b) => this.plan(b));
      return {
        strategy: ast.all.every(Boolean) ? 'union-all' : 'union',
        branches,
        rowsEstimate: branches.reduce((a, b) => a + (b?.rowsEstimate ?? 0), 0),
      };
    }
    if (ast.type !== 'select') return null;
    const from = ast.from ?? { table: ast.table };
    const table = this.tables.get(from.table);
    const stats = table.bt.stats();
    const joins = ast.joins ?? [];
    if (joins.length) {
      const sources = [{ alias: from.alias ?? from.table, table }];
      for (const j of joins) sources.push({ alias: j.alias ?? j.table, table: this.tables.get(j.table) });
      const jstats = sources.slice(1).map((s) => s.table.bt.stats());
      const rowsEstimate = jstats.reduce((a, s) => a * s.entryCount, stats.entryCount);
      const specs = joins.map((j, i) => {
        if (!j.on) return null;
        const src = sources[i + 1];
        const spec = this.joinLookupSpec(src, sources.slice(0, i + 1), j.on);
        return spec && this.isProbeable(src.table, spec.inner) ? spec : null;
      });
      if (specs.every(Boolean)) {
        // One index probe per left row per join: far fewer comparisons, but the
        // probe path touches index pages rather than scanning the source once.
        const probePages = sources.slice(1).reduce((a, s) => a + s.table.bt.stats().depth + 1, 0);
        return {
          strategy: 'index-nested-loop-join',
          pages: stats.pageCount + probePages,
          rowsEstimate,
          comparisons: stats.entryCount * joins.length,
        };
      }
      return {
        strategy: 'nested-loop-join',
        pages: stats.pageCount + jstats.reduce((a, s) => a + s.pageCount, 0),
        rowsEstimate,
        comparisons: jstats.reduce((a, s) => a * s.entryCount, stats.entryCount),
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
        return { strategy: 'secondary-index-seek', pages: istats.depth + 1, rowsEstimate: 1, index: idx.name };
      }
    }
    // Filtered scan: still reads every leaf page, but only keeps matching rows.
    return { strategy: 'full-scan', pages: stats.pageCount, rowsEstimate: stats.entryCount, filtered: true };
  }

  execSql(sql) {
    const ast = parseAst(sql);
    // A failed statement must not leave staged pages behind for the next
    // commit to pick up (e.g. row 1 of a multi-row INSERT succeeding, row 2
    // violating a UNIQUE index).
    try {
      return this.execAst(ast);
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  execAst(ast) {
    if (ast.type === 'createTable') {
      const existed = this.tables.has(ast.name);
      this.createTable(ast.name, ast.columns, ast.ifNotExists);
      this.commit(); // DDL is committed eagerly
      return { rows: [], columns: [], plan: null, table: ast.name, created: !existed };
    }
    if (ast.type === 'createTableAs') {
      const r = this.createTableAsSelect(ast.name, ast, ast.ifNotExists);
      this.commit();
      return { rows: [], columns: [], plan: null, table: r.table, created: r.created, rows: r.rows, columns: r.columns };
    }
    if (ast.type === 'createIndex') {
      const table = this.tables.get(ast.table);
      const idxName = ast.name ?? `idx_${ast.table}_${ast.column}`;
      const existed = !!table?.indexes.some((ix) => ix.name === idxName);
      this.createIndex(ast.table, ast.column, ast.name, ast.unique, ast.ifNotExists);
      this.commit();
      return { rows: [], columns: [], plan: null, index: idxName, unique: !!ast.unique, created: !existed };
    }
    if (ast.type === 'alterTable') {
      const altered = this.alterTableAddColumn(ast.table, ast.column);
      this.commit();
      return { rows: [], columns: [], plan: null, ...altered };
    }
    if (ast.type === 'alterRenameTable') {
      const renamed = this.renameTable(ast.table, ast.to);
      this.commit();
      return { rows: [], columns: [], plan: null, ...renamed };
    }
    if (ast.type === 'alterRenameColumn') {
      const renamed = this.renameColumn(ast.table, ast.from, ast.to);
      this.commit();
      return { rows: [], columns: [], plan: null, ...renamed };
    }
    if (ast.type === 'alterDropColumn') {
      const dropped = this.dropColumn(ast.table, ast.column);
      this.commit();
      return { rows: [], columns: [], plan: null, ...dropped };
    }
    if (ast.type === 'truncate') {
      const truncated = this.truncateTable(ast.table);
      this.commit();
      return { rows: [], columns: [], plan: null, table: truncated.table, truncated: truncated.truncated, pages: truncated.pages };
    }
    if (ast.type === 'vacuum') {
      const v = this.vacuum();
      return { rows: [], columns: [], plan: null, ...v };
    }
    if (ast.type === 'dropTable') {
      const dropped = this.dropTable(ast.table, ast.ifExists);
      this.commit();
      return { rows: [], columns: [], plan: null, ...dropped };
    }
    if (ast.type === 'dropIndex') {
      const dropped = this.dropIndex(ast.name, ast.table, ast.ifExists);
      this.commit();
      return { rows: [], columns: [], plan: null, ...dropped };
    }
    if (ast.type === 'insert') {
      const rows = this.mapRows(ast);
      const keys = rows.map((row) => this.insert(ast.table, row));
      this.commit();
      return { rows: [], columns: [], key: keys.length === 1 ? keys[0] : undefined, keys, inserted: keys.length, plan: null };
    }
    if (ast.type === 'insertSelect') {
      const table = this.tables.get(ast.table);
      if (!table) throw new Error(`insert: no such table '${ast.table}'`);
      const sel = ast.select.type === 'union' ? this.execUnion(ast.select) : this.execSelect(ast.select);
      const targetCols = ast.columns ?? table.columns.map((c) => c.name);
      if (sel.columns.length !== targetCols.length) {
        throw new Error(`insert ... select: ${sel.columns.length} selected column(s) for ${targetCols.length} target column(s)`);
      }
      const keys = sel.rows.map((r) => {
        const row = {};
        targetCols.forEach((col, i) => {
          row[col] = r[sel.columns[i]];
        });
        return this.insert(ast.table, row);
      });
      this.commit();
      return { rows: [], columns: [], key: keys.length === 1 ? keys[0] : undefined, keys, inserted: keys.length, plan: null };
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
    if (ast.type === 'union') {
      return { ...this.execUnion(ast), plan: this.plan(ast) };
    }
    throw new Error(`unsupported statement type: ${ast.type}`);
  }

  mapRows(ast) {
    const table = this.tables.get(ast.table);
    if (!table) throw new Error(`insert: no such table '${ast.table}'`);
    const cols = ast.columns ?? table.columns.map((c) => c.name);
    if (ast.columns) {
      for (const col of cols) {
        if (!table.columns.some((c) => c.name === col)) throw new Error(`insert: no column '${col}' on '${ast.table}'`);
      }
    }
    return ast.rows.map((values) => {
      if (values.length !== cols.length) throw new Error(`insert: ${values.length} value(s) for ${cols.length} column(s)`);
      const row = {};
      cols.forEach((col, i) => {
        row[col] = values[i];
      });
      return row;
    });
  }

  /**
   * UPDATE t SET col = v [, col = v ...] [WHERE c = v]
   * Returns the number of rows updated.
   */
  update(tableName, sets, where = null) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`update: no such table '${tableName}'`);
    const keyName = this.keyColumnOf(table).name;
    for (const s of sets) {
      if (s.col === keyName) throw new Error(`update: cannot change the primary key '${keyName}'`);
      if (!table.columns.some((c) => c.name === s.col)) throw new Error(`update: no column '${s.col}' on '${tableName}'`);
    }
    const filter = this.buildFilter(table, where);
    let updated = 0;
    for (const { key, value } of table.bt.scan(filter)) {
      const oldRow = this.queryRow(table, key, value);
      const newRow = { ...oldRow, ...Object.fromEntries(sets.map((s) => [s.col, s.value])) };
      for (const c of table.columns) {
        if (c.notNull && (newRow[c.name] === undefined || newRow[c.name] === null)) {
          throw new Error(`update: column '${c.name}' is NOT NULL`);
        }
      }
      this.checkUnique(table, newRow, key);
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
    table.rootPage = table.bt.rootPage; // root may collapse after merges
    return deleted;
  }

  /**
   * TRUNCATE TABLE t — drops every row now: the table's B-tree (and each
   * secondary index) is freed page by page onto the freelist, then rebuilt as
   * an empty tree. Unlike repeated DELETEs, pages are freed even for small
   * tables; row ids continue from nextId.
   */
  truncateTable(tableName) {
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`truncate: no such table '${tableName}'`);
    let rows = 0;
    let pages = 0;
    rows = table.bt.stats().entryCount;
    for (const p of table.bt.pages()) {
      this.fm.freePage(p);
      pages++;
    }
    for (const ix of table.indexes) {
      for (const p of ix.bt.pages()) {
        this.fm.freePage(p);
        pages++;
      }
    }
    const newRoot = this.fm.allocatePage();
    this.fm.writePage(newRoot, serializeLeaf({ type: LEAF, pageNum: newRoot, entries: [] }));
    table.bt = new BTree(this.fm, newRoot);
    table.rootPage = newRoot;
    for (const ix of table.indexes) {
      const ixRoot = this.fm.allocatePage();
      this.fm.writePage(ixRoot, serializeLeaf({ type: LEAF, pageNum: ixRoot, entries: [] }));
      ix.bt = new BTree(this.fm, ixRoot);
      ix.rootPage = ixRoot;
    }
    return { table: tableName, truncated: rows, pages };
  }

  /**
   * VACUUM — rebuild every table and its secondary indexes in place so the
   * database has no freelist gaps: all tree pages are freed and reinserted,
   * then the freelist is emptied and committed with the meta page.
   */
  vacuum() {
    for (const table of this.tables.values()) {
      const rows = [...table.bt.scan(null)].map((e) => ({ key: e.key, blob: e.value }));
      for (const p of table.bt.pages()) this.fm.freePage(p);
      const newRoot = this.fm.allocatePage();
      this.fm.writePage(newRoot, serializeLeaf({ type: LEAF, pageNum: newRoot, entries: [] }));
      table.bt = new BTree(this.fm, newRoot);
      table.rootPage = newRoot;
      for (const ix of table.indexes) {
        for (const p of ix.bt.pages()) this.fm.freePage(p);
        const ixRoot = this.fm.allocatePage();
        this.fm.writePage(ixRoot, serializeLeaf({ type: LEAF, pageNum: ixRoot, entries: [] }));
        ix.bt = new BTree(this.fm, ixRoot);
        ix.rootPage = ixRoot;
      }
      for (const { key, blob } of rows) {
        table.bt.insert(key, blob);
        for (const ix of table.indexes) this.indexAdd(ix, this.queryRow(table, key, blob)[ix.column], key);
      }
      table.rootPage = table.bt.rootPage;
      for (const ix of table.indexes) ix.rootPage = ix.bt.rootPage;
    }
    // All freed pages were reused by the new roots; drop whatever is left.
    this.fm.freeList = [];
    this.commit();
    return { vacuumed: true, tables: this.tables.size };
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
