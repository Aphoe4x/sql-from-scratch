#!/usr/bin/env node
// src/cli.mjs — a tiny interactive SQL shell over the engine.
//
//   node src/cli.mjs [db-file]        (default: cli.db)
//   node src/cli.mjs demo.db --plan   (also print the query plan)
//
// Reads SQL statements terminated by `;`. Dot-commands: .tables, .schema, .plan, .exit.
// When stdin is piped, executes the whole input and exits.

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { Database } from './engine.mjs';

const args = process.argv.slice(2);
const showPlanDefault = args.includes('--plan');
const dbFile = args.find((a) => !a.startsWith('--')) ?? 'cli.db';
const fresh = args.includes('--fresh');

if (fresh) for (const p of [dbFile, `${dbFile}.wal`]) fs.existsSync(p) && fs.unlinkSync(p);

const db = fs.existsSync(dbFile) ? Database.open(dbFile) : Database.create(dbFile);
let showPlan = showPlanDefault;

/** Render rows as a fixed-width text table. */
function formatTable(columns, rows) {
  if (!rows.length) return '(0 rows)';
  const cell = (v) => (v === undefined ? '' : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const sep = `+-${widths.map((w) => '-'.repeat(w)).join('-+-')}-+`;
  const line = (cells) => `| ${cells.map((v, i) => cell(v).padEnd(widths[i])).join(' | ')} |`;
  const out = [sep, line(columns), sep];
  for (const r of rows) out.push(line(columns.map((c) => r[c])));
  out.push(sep);
  out.push(`${rows.length} row${rows.length === 1 ? '' : 's'}`);
  return out.join('\n');
}

function run(sql) {
  try {
    const res = db.execSql(sql);
    if (res.plan && showPlan) {
      const est = res.plan.pages ?? res.plan.estimatedPages;
      const rowsEst = res.plan.rowsEstimate ?? res.plan.estimatedRows;
      console.log(`[plan] ${res.plan.strategy} — est. ${est} page(s), ${rowsEst} row(s)`);
    }
    if (res.columns?.length) {
      console.log(formatTable(res.columns, res.rows));
    } else if (res.key !== undefined) {
      console.log(`inserted key ${res.key}`);
    } else if (res.updated !== undefined) {
      console.log(`${res.updated} row(s) updated`);
    } else if (res.deleted !== undefined) {
      console.log(`${res.deleted} row(s) deleted`);
    } else {
      console.log('OK');
    }
  } catch (err) {
    console.log(`error: ${err.message}`);
  }
}

function printSchema() {
  if (db.tables.size === 0) return console.log('(no tables)');
  for (const t of db.tables.values()) {
    const cols = t.columns.map((c) => `${c.name} ${c.type.toUpperCase()}${c.isKey ? ' PRIMARY KEY' : ''}`).join(', ');
    console.log(`CREATE TABLE ${t.name} (${cols});  -- ${t.bt.stats().entryCount} rows`);
    for (const ix of t.indexes) console.log(`CREATE INDEX ${ix.name} ON ${t.name} (${ix.column});`);
  }
}

const DOT_COMMANDS = {
  '.tables': () => (db.tables.size ? [...db.tables.keys()].join(' ') : '(no tables)'),
  '.schema': () => printSchema(),
  '.plan': () => {
    showPlan = !showPlan;
    return `plan output ${showPlan ? 'on' : 'off'}`;
  },
  '.exit': () => process.exit(0),
  '.quit': () => process.exit(0),
};

function handleLine(buf, line) {
  const trimmed = line.trim();
  if (!trimmed) return buf;
  if (trimmed.startsWith('.')) {
    const fn = DOT_COMMANDS[trimmed];
    if (!fn) console.log(`unknown command: ${trimmed} (try .tables, .schema, .plan, .exit)`);
    else {
      const res = fn();
      if (res !== undefined) console.log(res);
    }
    return buf;
  }
  buf += `${line}\n`;
  if (!buf.includes(';')) return buf;
  for (const stmt of buf.split(';').map((s) => s.trim()).filter(Boolean)) run(stmt);
  return '';
}

if (!process.stdin.isTTY) {
  // Piped input: run everything, then leave.
  const input = fs.readFileSync(0, 'utf8');
  let buf = '';
  for (const line of input.split(/\r?\n/)) buf = handleLine(buf, line);
  if (buf.trim()) run(buf.trim());
  db.fm.close();
  process.exit(0);
}

console.log(`sql-from-scratch shell — ${path.resolve(dbFile)}`);
console.log("statements end with ';' · .tables · .schema · .plan · .exit");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sql> ' });
let buf = '';
rl.prompt();
rl.on('line', (line) => {
  buf = handleLine(buf, line);
  rl.prompt();
});
rl.on('close', () => {
  db.fm.close();
  console.log('\nbye');
  process.exit(0);
});
