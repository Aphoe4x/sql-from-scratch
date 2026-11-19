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
   * SELECT execution: nested-loop joins (INNER / LEFT / comma-cross), grouping,
   * aggregates, HAVING and ORDER BY.
   * AST shape: { table, from, joins, selectItems, where, groupBy, having, orderBy }.
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

    // Nested-loop join: start with the base rows, then multiply by each join source.
    let joined = rowsOf(base).map((r) => ({ [sources[0].alias]: r }));
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

    const rows = ast.where
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
    return { rows: entries.map((e) => e.out), columns };
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
