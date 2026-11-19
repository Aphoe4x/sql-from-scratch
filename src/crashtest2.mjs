// src/crashtest2.mjs — crash *inside* commit:
//   mode=wal : WAL durable, zero pages applied to the DB file
//   mode=3   : WAL durable, 3 pages applied (partial write)
// Both must recover to exactly the committed data, including the row whose
// commit was interrupted before the file was updated.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Database } from './engine.mjs';

const runScenario = async (mode, dbFile) => {
  const dbPath = path.resolve(dbFile);
  for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

  const child = spawn(process.execPath, ['src/crashcommit_child.mjs', dbPath, String(mode)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const { code, signal } = await new Promise((resolve) => child.on('exit', (c, sig) => resolve({ code: c, signal: sig })));
  if (out.includes('commit survived')) throw new Error(`mode ${mode}: fault injection did not fire\n${out}`);
  console.log(`  [${mode}] child died (code=${code}, signal=${signal}); file left stale/partial`);

  let db = Database.open(dbPath);
  let rows = db.query('users');
  if (rows.length !== 21) throw new Error(`mode ${mode}: expected 21 rows after recovery, got ${rows.length}`);
  if (!rows.some((r) => r.name === 'durable-after-recovery')) throw new Error(`mode ${mode}: interrupted commit lost`);
  console.log(`  [${mode}] recovered ${rows.length} rows, interrupted commit present`);

  db.execSql("INSERT INTO users (name) VALUES ('post-recovery')");
  db.fm.close();
  db = Database.open(dbPath);
  rows = db.query('users');
  if (rows.length !== 22) throw new Error(`mode ${mode}: engine unusable after recovery (${rows.length} rows)`);
  db.fm.close();
  fs.unlinkSync(dbPath);
  fs.unlinkSync(dbPath + '.wal');
  console.log(`  [${mode}] engine usable after recovery (22 rows)`);
};

console.log('scenario 1: kill after WAL fsync, before applying pages');
await runScenario('wal', 'crashcommit1.db');

console.log('scenario 2: kill after 1 page of a partial apply');
await runScenario(1, 'crashcommit2.db');

console.log('commit crash test OK');
