// smoke_engine.mjs — normal flow: create table, insert, query, reopen, query again.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_engine.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
db.execSql("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
for (let i = 1; i <= 100; i++) db.execSql(`INSERT INTO users (name) VALUES ('seed-${i}')`);
const rows = db.query('users');
console.log(`inserted+queried: ${rows.length}, first: ${JSON.stringify(rows[0])}`);
if (rows.length !== 100) throw new Error(`expected 100, got ${rows.length}`);
if (rows[0].name !== 'seed-1') throw new Error(`bad first row: ${JSON.stringify(rows[0])}`);

const db2 = Database.open(dbPath);
const rows2 = db2.query('users');
console.log(`after reopen: ${rows2.length}, first: ${JSON.stringify(rows2[0])}`);
if (rows2.length !== 100) throw new Error(`expected 100 after reopen, got ${rows2.length}`);
if (rows2[0].name !== 'seed-1') throw new Error(`bad first row after reopen: ${JSON.stringify(rows2[0])}`);

const r = db2.execSql('SELECT id, name FROM users WHERE id = 55');
console.log(`where id=55: ${r.rows.length}, ${JSON.stringify(r.rows[0])}`);
if (r.rows.length !== 1 || r.rows[0].name !== 'seed-55') throw new Error(`bad where result: ${JSON.stringify(r.rows)}`);

console.log('engine smoke OK');
