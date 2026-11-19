// smoke_freelist.mjs — pages freed by B-tree merges are reused, the freelist
// survives reopen, and every page carries a CRC-32 that detects corruption.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_freelist.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

let db = Database.create(dbPath);
db.execSql('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
for (let i = 1; i <= 2000; i++) db.execSql(`INSERT INTO t (v) VALUES ('row-${i}')`);
const p0 = db.fm.pageCount;
const stats0 = db.tableStats ? null : db.tables.get('t').bt.stats();
console.log(`seeded 2000 rows: ${p0} pages, tree depth ${stats0.depth}, freelist ${db.fm.freeList.length}`);

// 1. Deleting most rows frees pages into the freelist (file does not shrink).
const del = db.execSql('DELETE FROM t WHERE id >= 11');
if (del.deleted !== 1990) throw new Error(`expected 1990 deletes, got ${del.deleted}`);
if (db.fm.pageCount !== p0) throw new Error(`pageCount changed on delete: ${p0} -> ${db.fm.pageCount}`);
if (db.fm.freeList.length === 0) throw new Error('delete did not free any pages');
if (db.query('t').length !== 10) throw new Error(`rows after delete: ${db.query('t').length}`);
console.log(`deleted 1990 rows: freelist now holds ${db.fm.freeList.length} pages, pageCount still ${p0}`);

// 2. Reopen: the freelist is persisted with the meta page.
const freeBefore = db.fm.freeList.length;
db.fm.close();
db = Database.open(dbPath);
if (db.fm.freeList.length !== freeBefore) throw new Error(`freelist not persisted: ${freeBefore} -> ${db.fm.freeList.length}`);
if (db.query('t').length !== 10) throw new Error(`reopen row count: ${db.query('t').length}`);
console.log(`reopen: freelist ${db.fm.freeList.length} pages, 10 rows intact`);

// 3. New inserts reuse freed pages instead of growing the file, and the tree stays correct.
for (let i = 1; i <= 2000; i++) db.execSql(`INSERT INTO t (v) VALUES ('new-${i}')`);
const rows = db.query('t');
if (rows.length !== 2010) throw new Error(`rows after reinsert: ${rows.length}`);
if (db.fm.pageCount > p0 + 2) throw new Error(`file grew instead of reusing pages: ${p0} -> ${db.fm.pageCount}`);
let prev = -1;
for (const r of rows) {
  if (r.id <= prev) throw new Error(`scan not strictly ascending at id ${r.id}`);
  prev = r.id;
}
for (const id of [1, 10, 2001, 2500, 4000]) {
  const got = db.execSql(`SELECT v FROM t WHERE id = ${id}`).rows;
  if (got.length !== 1) throw new Error(`missing row id ${id} after page reuse`);
}
console.log(`reinserted 2000 rows: ${db.fm.pageCount} pages (was ${p0}), freelist ${db.fm.freeList.length}, all rows found`);

// 4. Deleting everything leaves an empty, usable table.
const delAll = db.execSql('DELETE FROM t');
if (delAll.deleted !== 2010) throw new Error(`delete-all: ${delAll.deleted}`);
if (db.query('t').length !== 0) throw new Error('table not empty after delete-all');
db.fm.close();
db = Database.open(dbPath);
db.execSql("INSERT INTO t (v) VALUES ('after-empty')");
if (db.query('t').length !== 1) throw new Error('table unusable after delete-all + reopen');
console.log(`delete-all + reopen: freelist ${db.fm.freeList.length} pages, insert works`);
db.fm.close();

// 5. Checksum: corrupt one byte of a data page -> read fails loudly.
const corruptPath = 'smoke_corrupt.db';
for (const p of [corruptPath, corruptPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
let cdb = Database.create(corruptPath);
cdb.execSql('CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT)');
for (let i = 1; i <= 5; i++) cdb.execSql(`INSERT INTO u (name) VALUES ('n${i}')`);
const rootPage = cdb.tables.get('u').rootPage;
cdb.fm.close();

const fd = fs.openSync(corruptPath, 'r+');
const page = Buffer.alloc(4096);
fs.readSync(fd, page, 0, 4096, rootPage * 4096);
page[20] ^= 0xff; // flip a byte inside the first entry
fs.writeSync(fd, page, 0, 4096, rootPage * 4096);
fs.closeSync(fd);

cdb = Database.open(corruptPath);
let threw = false;
try {
  cdb.query('u');
} catch (err) {
  threw = /checksum mismatch/.test(err.message);
}
if (!threw) throw new Error('corrupt data page was not detected');
console.log(`corrupt page ${rootPage} rejected with a checksum error`);
cdb.fm.close();

// 6. Checksum: corrupt the meta page -> open fails.
const metaFd = fs.openSync(corruptPath, 'r+');
const meta = Buffer.alloc(4096);
fs.readSync(metaFd, meta, 0, 4096, 0);
meta[30] ^= 0xff;
fs.writeSync(metaFd, meta, 0, 4096, 0);
fs.closeSync(metaFd);
threw = false;
try {
  Database.open(corruptPath);
} catch (err) {
  threw = /corrupt meta page/.test(err.message);
}
if (!threw) throw new Error('corrupt meta page was not detected');
console.log('corrupt meta page rejected');

for (const p of [corruptPath, corruptPath + '.wal', dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('freelist + checksum smoke OK');
