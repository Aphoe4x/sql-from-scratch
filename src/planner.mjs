// src/planner.mjs — thin adapter over Database.plan().
//
// The engine owns the cost model so the CLI, the demo and the tests always
// report the same strategy. This module keeps the historical
// estimatedPages/estimatedRows field names for callers that used it directly.

import { parse as parseAst } from './parser.mjs';

export function planQuery(db, sql) {
  const ast = parseAst(sql);
  const plan = db.plan(ast);
  if (!plan) return null;
  const { pages, rowsEstimate, ...rest } = plan;
  const out = { ...rest, estimatedPages: pages, estimatedRows: rowsEstimate };
  if (ast.type === 'select') out.table = (ast.from ?? { table: ast.table }).table;
  return out;
}
