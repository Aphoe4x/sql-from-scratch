// smoke_truncate.mjs — TRUNCATE TABLE: rows removed, freelist filled, indexes cleared.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_truncate.db';
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
db.execSql('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INTEGER)');
db.execSql('CREATE UNIQUE INDEX uq_t_v ON t (v)');
for (let i = 1; i <= 100; i++) db.execSql(`INSERT INTO t (v, n) VALUES ('v${i}', ${i})`);
if (db.query('t').length !== 100) throw new Error('seed failed');

const pagesBefore = db.fm.pageCount;
const res = db.execSql('TRUNCATE TABLE t');
if (res.truncated !== 100) throw new Error(`truncated: ${JSON.stringify(res)}`);
if (res.pages < 2) throw new Error(`truncate freed too few pages: ${JSON.stringify(res)}`);
if (db.query('t').length !== 0) throw new Error('table not empty after truncate');
if (db.execSql('SELECT COUNT(*) AS n FROM t').rows[0].n !== 0) throw new Error('count after truncate');
console.log(`truncate: 100 rows removed, freed ${res.pages} page(s), file stays at ${db.fm.pageCount} (was ${pagesBefore})`);

// UNIQUE index on the truncated table answers again with no entries.
const r = db.execSql("INSERT INTO t (v) VALUES ('v1')");
if (r.key !== 101) throw new Error(`next id: ${r.key}`); // rows deleted but ids continue
eq(db.execSql("SELECT v FROM t WHERE v = 'v1'").rows.length, 1, 'insert after truncate');
throws(() => db.execSql("INSERT INTO t (v) VALUES ('v1')"), /duplicate primary key|unique index|already exists/, 'duplicate after truncate');
eq(db.execSql('SELECT COUNT(*) AS n FROM t WHERE v = \'v1\'').rows[0].n, 1, 'index has one entry for v1');

// Secondary index count: bucket entries empty for truncated rows.
db.execSql('TRUNCATE TABLE t');
eq(db.execSql('SELECT COUNT(*) AS n FROM t').rows[0].n, 0, 'truncate again');

// Missing table is an error; reopening persists the empty table.
throws(() => db.execSql('TRUNCATE TABLE nope'), /no such table/, 'truncate missing table');
db.fm.close();
db = Database.open(dbPath);
eq(db.execSql('SELECT COUNT(*) AS n FROM t').rows[0].n, 0, 'reopen empty');
db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('TRUNCATE TABLE smoke OK');
