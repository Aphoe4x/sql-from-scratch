// src/crashtest.mjs — parent: spawns the child, SIGKILLs it mid-transaction,
// reopens the DB, and verifies recovery: committed rows survive, uncommitted ones are gone.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Database } from './engine.mjs';
import { FileManager } from './fs.mjs';
import { pollUntil, sleep } from './util.mjs';

const dbPath = path.resolve('crashtest.db');
const markerPath = path.resolve('crashtest.marker');

for (const p of [dbPath, dbPath + '.wal', markerPath]) fs.existsSync(p) && fs.unlinkSync(p);
FileManager.create(dbPath).close(); // pre-create so the child can open it

console.log('spawning child (seed 100 committed + 50 uncommitted)...');
const child = spawn(process.execPath, ['src/crashtest_child.mjs', dbPath, markerPath], { stdio: 'inherit' });

await pollUntil(() => fs.existsSync(markerPath), 20000);
await sleep(150); // child is now mid-transaction with staged pages
child.kill('SIGKILL');
await new Promise((resolve) => child.on('exit', resolve));
console.log(`child killed (exit signal: ${child.signalCode ?? 'unknown'})`);

console.log('reopening database (recovery)...');
const db = Database.open(dbPath);
const rows = db.query('users');
console.log(`rows after recovery: ${rows.length}`);

const committed = rows.filter((r) => r.name.startsWith('seed-')).length;
const leaked = rows.filter((r) => r.name.startsWith('uncommitted-')).length;
console.log(`  committed rows: ${committed} (want 100), uncommitted rows: ${leaked} (want 0)`);
if (committed !== 100 || leaked !== 0) throw new Error('crash recovery failed');

// Engine remains usable after recovery.
const before = db.query('users');
db.execSql(`INSERT INTO users (name) VALUES ('post-recovery')`);
const after = db.query('users');
console.log(`engine usable after recovery: ${after.length} rows (was ${before.length}), last: ${JSON.stringify(after[after.length - 1])}`);
if (after.length !== before.length + 1) throw new Error(`post-recovery insert did not add a row: ${after.length} vs ${before.length}`);
console.log('crash test OK');
