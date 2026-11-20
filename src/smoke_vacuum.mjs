// smoke_vacuum.mjs — VACUUM rebuilds tables/indexes so the freelist is empty.
// Rows and the UNIQUE index survive; everything persists across reopen.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_vacuum.db';
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
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

let db = Database.create(dbPath);
db.execSql('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
db.execSql('CREATE UNIQUE INDEX uq_t_n ON t (n)');
for (let i = 1; i <= 500; i++) db.execSql(`INSERT INTO t (name, n) VALUES ('v${i}', ${i})`);
db.execSql('DELETE FROM t WHERE id <= 400'); // creates freelist pages
const pageCountBefore = db.fm.pageCount;
if (db.fm.freeList.length === 0) throw new Error('test setup: expected a non-empty freelist after deletes');
console.log(`before: ${pageCountBefore} pages, freelist ${db.fm.freeList.length}`);

const r = db.execSql('VACUUM');
if (r.vacuumed !== true || r.tables !== 1) throw new Error(`vacuum result: ${JSON.stringify(r)}`);
eq(db.fm.freeList.length, 0, 'freelist emptied by vacuum');
eq(db.query('t').length, 100, 'row count after vacuum');
eq(db.execSql('SELECT COUNT(*) AS n FROM t').rows[0].n, 100, 'count after vacuum');
eq(db.execSql('SELECT name FROM t ORDER BY id').rows.map((x) => x.name)[0], 'v401', 'first row intact');
eq(db.execSql('SELECT name FROM t ORDER BY id').rows.map((x) => x.name)[99], 'v500', 'last row intact');
eq(db.execSql('SELECT name FROM t WHERE n = 500').rows.map((x) => x.name), ['v500'], 'index seek after vacuum');
throws(() => db.execSql("INSERT INTO t (name, n) VALUES ('dup', 500)"), /unique|duplicate/i, 'unique index still enforced after vacuum');
console.log('vacuum: freelist emptied, 100 rows intact, unique index ok');

// VACUUM on a database with no freelist and no changes is still fine.
db.execSql('VACUUM');
eq(db.query('t').length, 100, 'row count after second vacuum');

// Empty result set: rows survive in other tables; a table with 0 rows stays 0.
db.execSql('CREATE TABLE empty (id INTEGER PRIMARY KEY, v TEXT)');
db.execSql('VACUUM');
eq(db.query('t').length, 100, 'rows in t still intact after second vacuum');
eq(db.query('empty').length, 0, 'empty table stays empty');

// Reopen: the vacuumed state persists.
const before = db.execSql('SELECT * FROM t ORDER BY id').rows;
db.fm.close();
db = Database.open(dbPath);
eq(db.fm.freeList.length, 0, 'freelist empty after reopen');
eq(db.execSql('SELECT * FROM t ORDER BY id').rows, before, 'rows survive reopen');
eq(db.execSql('SELECT name FROM t WHERE n = 500').rows.map((x) => x.name), ['v500'], 'reopen: index seek works');
db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('VACUUM smoke OK');
