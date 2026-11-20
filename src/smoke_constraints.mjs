// smoke_constraints.mjs — NOT NULL, DEFAULT, UNIQUE indexes (and their persistence),
// plus rejection of primary-key updates.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_constraints.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

let db = Database.create(dbPath);
db.execSql("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT DEFAULT 'Lagos', score INTEGER DEFAULT 0)");

const byId = (id) => db.execSql(`SELECT * FROM users WHERE id = ${id}`).rows[0];
const throws = (fn, re, label) => {
  try {
    fn();
  } catch (err) {
    if (re && !re.test(err.message)) throw new Error(`${label}: wrong error: ${err.message}`);
    return;
  }
  throw new Error(`${label}: expected an error`);
};

// 1. DEFAULT fills omitted columns.
db.execSql("INSERT INTO users (name) VALUES ('ada')");
if (JSON.stringify(byId(1)) !== JSON.stringify({ id: 1, name: 'ada', city: 'Lagos', score: 0 })) throw new Error(`defaults: ${JSON.stringify(byId(1))}`);

// 2. Explicit values override defaults.
db.execSql("INSERT INTO users (name, city, score) VALUES ('bola', 'Kano', 7)");
if (byId(2).city !== 'Kano' || byId(2).score !== 7) throw new Error(`override: ${JSON.stringify(byId(2))}`);

// 3. NOT NULL rejects a missing value and leaves no row behind.
throws(() => db.execSql("INSERT INTO users (city) VALUES ('Abuja')"), /NOT NULL/, 'not-null insert');
if (db.query('users').length !== 2) throw new Error(`failed insert left a row: ${db.query('users').length}`);
console.log('default + not-null ok:', JSON.stringify(byId(1)));

// 4. Constraints survive reopen.
db.fm.close();
db = Database.open(dbPath);
db.execSql("INSERT INTO users (name) VALUES ('chidi')");
if (byId(3).city !== 'Lagos' || byId(3).score !== 0) throw new Error(`defaults after reopen: ${JSON.stringify(byId(3))}`);
throws(() => db.execSql('INSERT INTO users (score) VALUES (1)'), /NOT NULL/, 'not-null after reopen');
console.log('reopen: defaults + NOT NULL still enforced');

// 5. UNIQUE index: build, then reject duplicates on INSERT and UPDATE.
const r = db.execSql('CREATE UNIQUE INDEX uq_users_name ON users (name)');
if (!r.unique || r.index !== 'uq_users_name') throw new Error(`create unique index result: ${JSON.stringify(r)}`);
const before = db.query('users').length;
throws(() => db.execSql("INSERT INTO users (name) VALUES ('ada')"), /unique index/, 'duplicate insert');
if (db.query('users').length !== before) throw new Error('failed unique insert left a row');
throws(() => db.execSql("UPDATE users SET name = 'ada' WHERE id = 2"), /unique index/, 'duplicate update');
if (byId(2).name !== 'bola') throw new Error(`failed unique update changed the row: ${JSON.stringify(byId(2))}`);
db.execSql("UPDATE users SET name = 'bella' WHERE id = 2");
if (byId(2).name !== 'bella') throw new Error('valid unique update failed');
console.log('unique index: duplicate insert/update rejected, valid update applied');

// 6. Deleting frees the value for reuse.
db.execSql("DELETE FROM users WHERE id = 1");
db.execSql("INSERT INTO users (name) VALUES ('ada')");
if (db.query('users').length !== 3) throw new Error(`reuse after delete: ${db.query('users').length}`);

// 7. UNIQUE survives reopen.
db.fm.close();
db = Database.open(dbPath);
throws(() => db.execSql("INSERT INTO users (name) VALUES ('bella')"), /unique index/, 'unique after reopen');
console.log('reopen: UNIQUE still enforced');

// 8. CREATE UNIQUE INDEX over duplicate data fails cleanly (no half-built index).
db.execSql('CREATE TABLE dup (id INTEGER PRIMARY KEY, code TEXT)');
db.execSql("INSERT INTO dup (code) VALUES ('x')");
db.execSql("INSERT INTO dup (code) VALUES ('x')");
throws(() => db.execSql('CREATE UNIQUE INDEX uq_dup ON dup (code)'), /duplicate value/, 'unique over duplicates');
// The failed name is still free: a non-unique index under that name works.
db.execSql('CREATE INDEX uq_dup ON dup (code)');
db.execSql("DELETE FROM dup WHERE id = 2");
db.execSql('CREATE UNIQUE INDEX uq_dup2 ON dup (code)');
throws(() => db.execSql("INSERT INTO dup (code) VALUES ('x')"), /unique index/, 'unique on dup after cleanup');
console.log('unique build over duplicates rejected, engine left consistent');

// 9. Primary-key updates are rejected (the B-tree key is the identity).
throws(() => db.execSql('UPDATE users SET id = 99 WHERE id = 3'), /primary key/, 'pk update');
if (byId(3) === undefined) throw new Error('row 3 disappeared');

// 10. Unknown columns are still rejected by CREATE INDEX.
throws(() => db.execSql('CREATE INDEX bad ON users (nope)'), /no column/, 'bad index column');

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('constraints smoke OK');
