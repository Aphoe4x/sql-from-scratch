// smoke_insert_select.mjs — INSERT ... SELECT (including union sources),
// IF [NOT] EXISTS for CREATE/DROP, standalone OFFSET, and duplicate-key
// rejection with full statement rollback.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_insert_select.db';
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
db.execSql('CREATE TABLE src (id INTEGER PRIMARY KEY, name TEXT, city TEXT, amount INTEGER)');
db.execSql("INSERT INTO src (name, city, amount) VALUES ('ada','Lagos',10), ('bola','Kano',20), ('chidi','Lagos',30), ('dayo','Abuja',40), ('emeka','Kano',50), ('femi','Lagos',60)");
db.execSql('CREATE TABLE dst (id INTEGER PRIMARY KEY, name TEXT, city TEXT, amount INTEGER)');

// 1. Copy every row (target key omitted -> new ids).
let res = db.execSql('INSERT INTO dst (name, city, amount) SELECT name, city, amount FROM src');
if (res.inserted !== 6 || JSON.stringify(res.keys) !== '[1,2,3,4,5,6]') throw new Error(`copy all: ${JSON.stringify(res)}`);
eq(db.execSql('SELECT name, city, amount FROM dst ORDER BY id').rows.map((r) => [r.name, r.city, r.amount]),
  [['ada', 'Lagos', 10], ['bola', 'Kano', 20], ['chidi', 'Lagos', 30], ['dayo', 'Abuja', 40], ['emeka', 'Kano', 50], ['femi', 'Lagos', 60]], 'copy all rows');

// 2. WHERE on the source; omitted target columns default.
res = db.execSql("INSERT INTO dst (name, amount) SELECT name, amount FROM src WHERE city = 'Lagos'");
if (res.inserted !== 3) throw new Error(`copy filtered: ${res.inserted}`);
eq(db.execSql('SELECT name, city, amount FROM dst WHERE id > 6 ORDER BY id').rows.map((r) => [r.name, r.city, r.amount]),
  [['ada', '', 10], ['chidi', '', 30], ['femi', '', 60]], 'filtered copy + omitted column');
console.log('insert-select: full copy, WHERE copy, omitted columns ok');

// 3. Column order is positional, not name-based.
db.execSql('CREATE TABLE dst2 (id INTEGER PRIMARY KEY, amount INTEGER, name TEXT)');
res = db.execSql('INSERT INTO dst2 (amount, name) SELECT amount, name FROM src WHERE amount > 25');
if (res.inserted !== 4) throw new Error(`reorder copy: ${res.inserted}`);
eq(db.execSql('SELECT amount, name FROM dst2 ORDER BY id').rows.map((r) => [r.amount, r.name]),
  [[30, 'chidi'], [40, 'dayo'], [50, 'emeka'], [60, 'femi']], 'positional mapping');
console.log('insert-select: target/source columns matched positionally');

// 4. A UNION query is a valid source.
db.execSql('CREATE TABLE pair (id INTEGER PRIMARY KEY, label TEXT, total INTEGER)');
res = db.execSql("INSERT INTO pair (label, total) SELECT name, amount FROM src WHERE city = 'Kano' UNION ALL SELECT name, amount FROM src WHERE city = 'Lagos'");
if (res.inserted !== 5) throw new Error(`union copy: ${res.inserted}`);
eq(db.execSql('SELECT label, total FROM pair ORDER BY label').rows.map((r) => [r.label, r.total]),
  [['ada', 10], ['bola', 20], ['chidi', 30], ['emeka', 50], ['femi', 60]], 'union source');
console.log('insert-select: UNION / UNION ALL source ok');

// 5. Errors: column-count mismatch, duplicate primary key, missing tables.
const dstBefore = db.query('dst').length;
throws(() => db.execSql('INSERT INTO dst (name) SELECT name, city FROM src'), /selected column/, 'column count');
if (db.query('dst').length !== dstBefore) throw new Error('column-count failure inserted rows');
throws(() => db.execSql('INSERT INTO dst (id, name) SELECT id, name FROM src'), /duplicate primary key/, 'duplicate pk');
if (db.query('dst').length !== dstBefore) throw new Error('duplicate-key failure inserted rows');
throws(() => db.execSql('INSERT INTO nope SELECT name FROM src'), /no such table/, 'missing target');
throws(() => db.execSql('INSERT INTO dst (name) SELECT name FROM nope'), /no such table/, 'missing source');
// A duplicate key halfway through the select rolls the whole statement back.
db.execSql('CREATE TABLE part (id INTEGER PRIMARY KEY, name TEXT)');
db.execSql('CREATE UNIQUE INDEX uq_part ON part (name)');
db.execSql("INSERT INTO part (name) VALUES ('x')");
throws(() => db.execSql('INSERT INTO part (name) SELECT name FROM src UNION ALL SELECT name FROM src'), /unique index/, 'partial copy');
eq(db.query('part').map((r) => r.name), ['x'], 'partial copy rolled back');
console.log('insert-select: count mismatch / duplicate key / missing table rejected cleanly');

// 6. IF NOT EXISTS / IF EXISTS.
res = db.execSql('CREATE TABLE IF NOT EXISTS dst (id INTEGER PRIMARY KEY, wrong TEXT)');
if (res.created !== false) throw new Error('IF NOT EXISTS created a duplicate table');
eq(db.tables.get('dst').columns.map((c) => c.name), ['id', 'name', 'city', 'amount'], 'IF NOT EXISTS kept the original schema');
throws(() => db.execSql('CREATE TABLE dst (id INTEGER PRIMARY KEY)'), /already exists/, 'duplicate table');
res = db.execSql('CREATE INDEX IF NOT EXISTS ix_dst_city ON dst (city)');
if (res.created !== true) throw new Error('IF NOT EXISTS did not create a missing index');
res = db.execSql('CREATE INDEX IF NOT EXISTS ix_dst_city ON dst (city)');
if (res.created !== false) throw new Error('IF NOT EXISTS duplicated an index');
res = db.execSql('DROP INDEX IF EXISTS not_there');
if (res.index !== null) throw new Error('DROP INDEX IF EXISTS reported an index');
res = db.execSql('DROP TABLE IF EXISTS not_there');
if (res.dropped !== null) throw new Error('DROP TABLE IF EXISTS reported a table');
res = db.execSql('DROP INDEX IF EXISTS ix_dst_city ON dst');
if (res.index !== 'ix_dst_city') throw new Error('DROP INDEX IF EXISTS did not drop the index');
console.log('if-exists: CREATE dupe guarded, missing DROP is a no-op');

// 7. OFFSET without LIMIT (single select and union).
eq(db.execSql('SELECT name FROM src ORDER BY id OFFSET 4').rows.map((r) => r.name), ['emeka', 'femi'], 'standalone offset');
eq(db.execSql('SELECT name FROM src ORDER BY id LIMIT 2 OFFSET 2').rows.map((r) => r.name), ['chidi', 'dayo'], 'limit + offset');
eq(db.execSql('SELECT city FROM src UNION SELECT city FROM src ORDER BY city OFFSET 1').rows.map((r) => r.city), ['Kano', 'Lagos'], 'union offset');
console.log('offset: standalone, with LIMIT, and over a UNION ok');

// 8. Self-copy doubles the table with fresh keys.
res = db.execSql('INSERT INTO src (name, city, amount) SELECT name, city, amount FROM src');
if (res.inserted !== 6) throw new Error(`self copy: ${res.inserted}`);
eq(db.execSql('SELECT COUNT(*) AS n FROM src').rows[0].n, 12, 'self copy count');
eq(db.execSql("SELECT COUNT(*) AS n FROM src WHERE name = 'ada'").rows[0].n, 2, 'self copy values');
console.log('insert-select: self-copy doubles the table with new keys');

// 9. Persistence.
const dstRows = db.execSql('SELECT * FROM dst ORDER BY id').rows;
db.execSql('DROP TABLE IF EXISTS dst2');
db.fm.close();
db = Database.open(dbPath);
eq(db.execSql('SELECT * FROM dst ORDER BY id').rows, dstRows, 'reopen dst');
if (db.tables.has('dst2')) throw new Error('dropped table came back');
eq(db.execSql('SELECT COUNT(*) AS n FROM src').rows[0].n, 12, 'reopen src');
console.log('reopen: copied rows and drops persisted');

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('INSERT ... SELECT smoke OK');
