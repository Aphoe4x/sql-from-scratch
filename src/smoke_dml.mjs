// smoke_dml.mjs — UPDATE + DELETE: in-place value updates, deletion via merge, verify with finds/scans.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_dml.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
db.execSql("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
for (let i = 1; i <= 10; i++) db.execSql(`INSERT INTO users (name) VALUES ('user-${i}')`);
console.log(`seeded: ${db.query('users').length} rows`);

// UPDATE by key
let res = db.execSql("UPDATE users SET name = 'renamed-5' WHERE id = 5");
console.log(`update by key: ${res.updated}`);
if (res.updated !== 1) throw new Error(`expected 1 update, got ${res.updated}`);
if (db.execSql("SELECT name FROM users WHERE id = 5").rows[0].name !== 'renamed-5') throw new Error('update not persisted');

// UPDATE by key again (repeat the same value)
res = db.execSql("UPDATE users SET name = 'multi' WHERE id = 5");
if (res.updated !== 1) throw new Error(`expected 1 update, got ${res.updated}`);
if (db.execSql("SELECT name FROM users WHERE id = 5").rows[0].name !== 'multi') throw new Error('update-by-key repeat failed');

// UPDATE all rows (no WHERE)
res = db.execSql("UPDATE users SET name = 'same'");
if (res.updated !== 10) throw new Error(`expected 10 updates, got ${res.updated}`);
if (!db.query('users').every((r) => r.name === 'same')) throw new Error('update-all failed');
console.log(`update-all ok: ${db.query('users').length} rows`);

// UPDATE a non-existent key
res = db.execSql("UPDATE users SET name = 'x' WHERE id = 999");
if (res.updated !== 0) throw new Error(`expected 0 updates for missing key, got ${res.updated}`);

// DELETE one by key
res = db.execSql("DELETE FROM users WHERE id = 7");
console.log(`delete by key: ${res.deleted}`);
if (res.deleted !== 1) throw new Error(`expected 1 delete, got ${res.deleted}`);
if (db.query('users').some((r) => r.id === 7)) throw new Error('row 7 still present after delete');

// DELETE a non-existent key
res = db.execSql("DELETE FROM users WHERE id = 999");
if (res.deleted !== 0) throw new Error(`expected 0 deletes, got ${res.deleted}`);

// DELETE all
res = db.execSql("DELETE FROM users");
if (res.deleted !== 9) throw new Error(`expected 9 deletes, got ${res.deleted}`);
if (db.query('users').length !== 0) throw new Error('expected empty table after delete-all');
console.log('delete-all ok: table empty');

// Re-insert after deletes
const key = db.execSql("INSERT INTO users (name) VALUES ('after-delete')").key;
if (db.query('users').length !== 1) throw new Error('expected 1 row after reinsert');
console.log(`reinsert ok: new key ${key}`);

// Stress: insert 200 rows into a new table, delete every other one by key, verify.
db.execSql("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)");
for (let i = 1; i <= 200; i++) db.execSql(`INSERT INTO t (v) VALUES (${i * 10})`);
if (db.query('t').length !== 200) throw new Error(`expected 200 rows in t, got ${db.query('t').length}`);
for (let i = 1; i <= 200; i += 2) {
  const d = db.execSql(`DELETE FROM t WHERE id = ${i}`);
  if (d.deleted !== 1) throw new Error(`expected 1 delete for id ${i}, got ${d.deleted}`);
}
const rem = db.query('t');
const expectedIds = Array.from({ length: 100 }, (_, i) => (i + 1) * 2); // 2,4,...,200
if (rem.length !== 100) throw new Error(`expected 100 rows after deletes, got ${rem.length}`);
const ids = rem.map((r) => r.id);
if (ids.some((v, i) => v !== expectedIds[i])) throw new Error(`delete left wrong rows: ${JSON.stringify(ids.slice(0, 5))}`);
console.log(`delete stress ok: ${rem.length} rows remain (ids ${expectedIds[0]}..${expectedIds[99]})`);

// DB still usable after deletes: update + select
db.execSql("UPDATE t SET v = 111 WHERE id = 2");
const first = db.execSql('SELECT * FROM t ORDER BY id ASC').rows[0];
if (first.v !== 111) throw new Error(`expected v=111 for id=2, got ${first.v}`);
console.log('update after deletes ok:', JSON.stringify(first));

console.log('DML smoke OK');
