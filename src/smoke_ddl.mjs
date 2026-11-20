// smoke_ddl.mjs — multi-row INSERT, DROP TABLE / DROP INDEX, page reuse after
// a drop, statement rollback on a failed multi-row insert, and strict parsing
// (trailing input is rejected instead of silently ignored).
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_ddl.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const throws = (fn, re, label) => {
  try {
    fn();
  } catch (err) {
    if (re && !re.test(err.message)) throw new Error(`${label}: wrong error: ${err.message}`);
    return;
  }
  throw new Error(`${label}: expected an error`);
};

let db = Database.create(dbPath);
db.execSql('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, city TEXT)');

// 1. Multi-row INSERT returns every key and reports the row count.
let res = db.execSql("INSERT INTO t (name, city) VALUES ('a', 'Lagos'), ('b', 'Kano'), ('c', 'Lagos')");
if (res.inserted !== 3 || JSON.stringify(res.keys) !== '[1,2,3]' || res.key !== undefined) {
  throw new Error(`multi-row insert result: ${JSON.stringify(res)}`);
}
if (db.query('t').length !== 3) throw new Error('multi-row insert row count');
// 2. Explicit keys work too.
res = db.execSql("INSERT INTO t VALUES (10, 'x', 'Abuja'), (11, 'y', 'Abuja')");
if (JSON.stringify(res.keys) !== '[10,11]') throw new Error(`explicit keys: ${JSON.stringify(res.keys)}`);
if (db.query('t').length !== 5) throw new Error('explicit-key insert row count');
// 3. A single-row insert still exposes `.key` (used by the CLI/tests).
res = db.execSql("INSERT INTO t (name) VALUES ('solo')");
if (res.key !== 12 || res.inserted !== 1) throw new Error(`single insert: ${JSON.stringify(res)}`);
console.log('multi-row insert: keys, explicit keys, single-row .key ok');

// 4. A failing tuple rolls back the whole statement (no partial insert, no
//    half-written index).
db.execSql('CREATE UNIQUE INDEX uq_t_name ON t (name)');
const before = db.query('t').length;
throws(() => db.execSql("INSERT INTO t (name) VALUES ('d'), ('a'), ('e')"), /unique index/, 'partial multi-row insert');
if (db.query('t').length !== before) throw new Error(`partial insert leaked rows: ${before} -> ${db.query('t').length}`);
for (const n of ['d', 'e']) {
  if (db.execSql(`SELECT * FROM t WHERE name = '${n}'`).rows.length !== 0) throw new Error(`failed insert left '${n}'`);
}
console.log('failed multi-row insert: statement rolled back cleanly');

// 5. DROP INDEX frees the index and removes the uniqueness rule.
res = db.execSql('DROP INDEX uq_t_name ON t');
if (res.index !== 'uq_t_name' || res.table !== 't' || res.pages < 1) throw new Error(`drop index result: ${JSON.stringify(res)}`);
db.execSql("INSERT INTO t (name) VALUES ('a')"); // duplicate now allowed
if (db.execSql("SELECT * FROM t WHERE name = 'a'").rows.length !== 2) throw new Error('unique rule survived DROP INDEX');
console.log('drop index: pages freed, uniqueness rule removed');

// 6. Same index name on two tables is ambiguous without ON.
db.execSql('CREATE TABLE u (id INTEGER PRIMARY KEY, v TEXT)');
db.execSql('CREATE INDEX dup ON t (city)');
db.execSql('CREATE INDEX dup ON u (v)');
throws(() => db.execSql('DROP INDEX dup'), /ambiguous/, 'ambiguous drop index');
db.execSql('DROP INDEX dup ON t');
throws(() => db.execSql('DROP INDEX dup ON t'), /no index/, 'drop missing index');
if (db.tables.get('t').indexes.some((ix) => ix.name === 'dup')) throw new Error('dropped index still registered on t');
if (!db.tables.get('u').indexes.some((ix) => ix.name === 'dup')) throw new Error('dropped wrong index');
console.log('drop index: ON disambiguates, missing index errors');

// 7. DROP TABLE removes the directory entry and frees the table + index pages.
res = db.execSql('DROP TABLE u');
if (res.dropped !== 'u' || res.pages < 2) throw new Error(`drop table result: ${JSON.stringify(res)}`);
throws(() => db.execSql('SELECT * FROM u'), /no such table/, 'select dropped table');
throws(() => db.execSql('DROP TABLE u'), /no such table/, 'drop missing table');
if (db.tables.has('u')) throw new Error('dropped table still in memory');
console.log(`drop table: directory entry removed, ${res.pages} pages freed`);

// 8. Freed pages are reused: build a 1000-row table with one statement, drop
//    it, then rebuild the same shape without the file growing much.
const values = Array.from({ length: 1000 }, (_, i) => `('v${i}')`).join(', ');
db.execSql('CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)');
db.execSql(`INSERT INTO big (v) VALUES ${values}`);
const pagesBig = db.fm.pageCount;
db.execSql('DROP TABLE big');
const freeAfterDrop = db.fm.freeList.length;
db.execSql('CREATE TABLE fresh (id INTEGER PRIMARY KEY, v TEXT)');
db.execSql(`INSERT INTO fresh (v) VALUES ${values}`);
if (db.fm.pageCount > pagesBig + 2) throw new Error(`drop did not enable reuse: ${pagesBig} -> ${db.fm.pageCount}`);
if (db.query('fresh').length !== 1000) throw new Error('rebuilt table lost rows');
console.log(`drop table: ${freeAfterDrop} pages freed, 1000 rows rebuilt in ${db.fm.pageCount} pages (was ${pagesBig})`);

// 9. Parsing is strict about leftover input; one trailing ';' is fine.
throws(() => db.execSql('SELECT * FROM t SELECT'), /trailing input/, 'trailing input');
if (db.execSql('SELECT COUNT(*) AS n FROM t;').rows[0].n === undefined) throw new Error('trailing semicolon rejected');
console.log('parser: trailing input rejected, trailing semicolon accepted');

// 10. Drops persist across reopen.
const tCount = db.query('t').length;
db.fm.close();
db = Database.open(dbPath);
if (db.tables.has('u') || db.tables.has('big')) throw new Error('dropped table came back after reopen');
if (!db.tables.has('t') || db.query('t').length !== tCount) throw new Error('surviving table damaged by reopen');
if (db.tables.get('t').indexes.some((ix) => ix.name === 'dup')) throw new Error('dropped index came back after reopen');
console.log(`reopen: drops persisted, t intact (${tCount} rows)`);

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('DDL / multi-row insert smoke OK');
