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
  if (ast.where) return { strategy: 'index-seek', table: from.table, estimatedPages: stats.depth + 1, estimatedRows: 1 };
  return { strategy: 'full-scan', table: from.table, estimatedPages: stats.pageCount, estimatedRows: stats.entryCount };
}
