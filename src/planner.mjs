// src/planner.mjs — static query planner with real cost estimates.
// Cost model: estimatedPages = number of pages a B-tree scan/descent touches.

import { parse as parseAst } from './parser.mjs';

export function planQuery(db, sql) {
  const ast = parseAst(sql);
  if (ast.type !== 'select') return null;
  const from = ast.from ?? { table: ast.table };
  const table = db.tables.get(from.table);
  if (!table) throw new Error(`planner: no such table '${from.table}'`);
  const stats = table.bt.stats();
  const joins = ast.joins ?? [];
  if (joins.length) {
    const jstats = joins.map((j) => {
      const t = db.tables.get(j.table);
      if (!t) throw new Error(`planner: no such table '${j.table}'`);
      return t.bt.stats();
    });
    return {
      strategy: 'nested-loop-join',
      table: from.table,
      estimatedPages: stats.pageCount + jstats.reduce((a, s) => a + s.pageCount, 0),
      estimatedRows: jstats.reduce((a, s) => a * s.entryCount, stats.entryCount),
    };
  }
  if (!ast.where) return { strategy: 'full-scan', table: from.table, estimatedPages: stats.pageCount, estimatedRows: stats.entryCount };
  const eq = ast.where.conditions.find((c) => c.op === '=' && c.valueCol === undefined);
  if (eq) {
    const col = eq.col.includes('.') ? eq.col.slice(eq.col.indexOf('.') + 1) : eq.col;
    const keyCol = table.columns.find((c) => c.isKey) ?? table.columns[0];
    if (col === keyCol.name) return { strategy: 'index-seek', table: from.table, estimatedPages: stats.depth + 1, estimatedRows: 1 };
    const idx = (table.indexes ?? []).find((ix) => ix.column === col);
    if (idx) {
      const istats = idx.bt.stats();
      return { strategy: 'secondary-index-seek', table: from.table, index: idx.name, estimatedPages: istats.depth + 1, estimatedRows: 1 };
    }
  }
  return { strategy: 'full-scan', table: from.table, estimatedPages: stats.pageCount, estimatedRows: stats.entryCount, filtered: true };
}
