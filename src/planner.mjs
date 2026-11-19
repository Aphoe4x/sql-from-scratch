// src/planner.mjs — static query planner with real cost estimates.
// Cost model: estimatedPages = number of pages a B-tree scan/descent touches.

import { parse as parseAst } from './parser.mjs';

export function planQuery(db, sql) {
  const ast = parseAst(sql);
  if (ast.type !== 'select') return null;
  const table = db.tables.get(ast.table);
  if (!table) throw new Error(`planner: no such table '${ast.table}'`);
  const stats = table.bt.stats();
  if (ast.where) return { strategy: 'index-seek', table: ast.table, estimatedPages: stats.depth + 1, estimatedRows: 1 };
  return { strategy: 'full-scan', table: ast.table, estimatedPages: stats.pageCount, estimatedRows: stats.entryCount };
}
