// smoke_alter.mjs — ALTER TABLE ADD COLUMN rewrites every stored row blob,
// keeps secondary indexes valid, persists the new schema, and enforces the
// NOT NULL / DEFAULT rules for existing rows.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_alter.db';
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
const names = (db, table) => db.tables.get(table).columns.map((c) => c.name);

let db = Database.create(dbPath);
db.execSql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT)');
db.execSql("INSERT INTO users (name, city) VALUES ('ada', 'Lagos'), ('bola', 'Kano'), ('chidi', 'Lagos'), ('dayo', 'Abuja')");
db.execSql('CREATE INDEX idx_users_city ON users (city)');

// 1. Default backfills every existing row; values already there survive.
let res = db.execSql("ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'NG'");
if (res.rows !== 4 || res.column !== 'country') throw new Error(`alter result: ${JSON.stringify(res)}`);
let rows = db.execSql('SELECT * FROM users ORDER BY id').rows;
if (rows.map((r) => r.country).join(',') !== 'NG,NG,NG,NG') throw new Error(`backfill: ${JSON.stringify(rows)}`);
if (rows.map((r) => r.name).join(',') !== 'ada,bola,chidi,dayo') throw new Error('alter damaged existing values');
// 2. No default: INTEGER -> 0, TEXT -> ''.
db.execSql('ALTER TABLE users ADD COLUMN score INTEGER');
db.execSql('ALTER TABLE users ADD COLUMN note TEXT');
rows = db.execSql('SELECT * FROM users ORDER BY id').rows;
if (rows.some((r) => r.score !== 0 || r.note !== '')) throw new Error(`zero/empty fill: ${JSON.stringify(rows[0])}`);
// 3. NOT NULL + DEFAULT is fine on a non-empty table.
db.execSql('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
if (db.execSql('SELECT * FROM users WHERE id = 1').rows[0].active !== 1) throw new Error('not-null default backfill');
console.log('alter: defaults, zero/empty fill, NOT NULL + DEFAULT ok');

// 4. The secondary index built before the rewrite still answers seeks.
const after = db.execSql("SELECT id, name FROM users WHERE city = 'Lagos'");
if (after.rows.length !== 2 || after.plan.strategy !== 'secondary-index-seek') {
  throw new Error(`index after alter: ${after.rows.length} rows, ${after.plan.strategy}`);
}
console.log('alter: secondary index still answers index seeks');

// 5. Rejections: duplicate column, NOT NULL without DEFAULT on data, bad type.
const beforeCols = names(db, 'users');
throws(() => db.execSql('ALTER TABLE users ADD COLUMN name TEXT'), /already exists/, 'duplicate column');
throws(() => db.execSql('ALTER TABLE users ADD COLUMN req TEXT NOT NULL'), /NOT NULL with no DEFAULT/, 'not-null no default');
throws(() => db.execSql('ALTER TABLE users ADD COLUMN bad BLOB'), /unsupported type/, 'bad type');
throws(() => db.execSql('ALTER TABLE users ADD COLUMN k INTEGER PRIMARY KEY'), /PRIMARY KEY/, 'add primary key');
if (JSON.stringify(names(db, 'users')) !== JSON.stringify(beforeCols)) throw new Error('failed ALTER changed the schema');
console.log('alter: duplicate / NOT NULL-without-default / bad type / PK rejected, schema unchanged');

// 6. Inserts and updates see the new columns (defaults still apply).
db.execSql("INSERT INTO users (name, city, country, score, note, active) VALUES ('emeka', 'Kano', 'GH', 9, 'vip', 0)");
let e = db.execSql("SELECT * FROM users WHERE name = 'emeka'").rows[0];
if (e.country !== 'GH' || e.score !== 9 || e.note !== 'vip' || e.active !== 0) throw new Error(`insert after alter: ${JSON.stringify(e)}`);
db.execSql("UPDATE users SET country = 'KE' WHERE id = 1");
if (db.execSql('SELECT * FROM users WHERE id = 1').rows[0].country !== 'KE') throw new Error('update after alter');
db.execSql("DELETE FROM users WHERE id = 4");
if (db.execSql('SELECT COUNT(*) AS n FROM users').rows[0].n !== 4) throw new Error('delete after alter');
console.log('alter: INSERT / UPDATE / DELETE work with the new columns');

// 7. New schema and values persist across reopen.
const snapshot = db.execSql('SELECT * FROM users ORDER BY id').rows;
db.fm.close();
db = Database.open(dbPath);
const reopened = db.execSql('SELECT * FROM users ORDER BY id').rows;
if (JSON.stringify(reopened) !== JSON.stringify(snapshot)) throw new Error('reopen changed the rows');
if (names(db, 'users').join(',') !== 'id,name,city,country,score,note,active') throw new Error(`reopen schema: ${names(db, 'users')}`);
if (db.execSql("SELECT * FROM users WHERE city = 'Lagos'").plan.strategy !== 'secondary-index-seek') throw new Error('index lost across reopen + alter');
db.execSql("INSERT INTO users (name) VALUES ('femi')");
if (db.execSql("SELECT * FROM users WHERE name = 'femi'").rows[0].active !== 1) throw new Error('defaults lost across reopen');
console.log('reopen: schema, rows, index and defaults intact');

// 8. On an empty table NOT NULL without DEFAULT is allowed; later inserts must supply it.
db.execSql('CREATE TABLE empty (id INTEGER PRIMARY KEY)');
db.execSql('ALTER TABLE empty ADD COLUMN req TEXT NOT NULL');
throws(() => db.execSql('INSERT INTO empty (id) VALUES (1)'), /NOT NULL/, 'empty-table not-null insert');
db.execSql("INSERT INTO empty (id, req) VALUES (1, 'x')");
if (db.execSql('SELECT * FROM empty').rows[0].req !== 'x') throw new Error('explicit not-null value');
console.log('alter: NOT NULL on an empty table allowed, then enforced on insert');

// 9. A larger table: rewrite 1000 rows and keep every row readable.
const values = Array.from({ length: 1000 }, (_, i) => `('v${i}')`).join(', ');
db.execSql('CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)');
db.execSql(`INSERT INTO big (v) VALUES ${values}`);
res = db.execSql("ALTER TABLE big ADD COLUMN tag TEXT DEFAULT 'bulk'");
if (res.rows !== 1000) throw new Error(`bulk alter rewrote ${res.rows} rows`);
const stats = db.execSql('SELECT COUNT(*) AS n FROM big').rows[0];
if (stats.n !== 1000) throw new Error(`bulk alter lost rows: ${stats.n}`);
for (const i of [0, 1, 499, 998, 999]) {
  const r = db.execSql(`SELECT * FROM big WHERE v = 'v${i}'`).rows[0];
  if (!r || r.tag !== 'bulk') throw new Error(`bulk alter bad row v${i}`);
}
console.log(`alter: 1000 rows rewritten (${db.tables.get('big').bt.stats().pageCount} pages), all readable`);

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('ALTER TABLE smoke OK');
