// smoke_ctas.mjs — CREATE TABLE name AS SELECT ...
// Types are inferred from the selected values; when the first selected
// column is an integer it becomes the table key, otherwise the table is
// created with a synthesized `id INTEGER PRIMARY KEY`.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_ctas.db';
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
db.execSql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT, score INTEGER)');
for (const [id, name, city, score] of [
  [1, 'ada', 'Lagos', 10], [2, 'bola', 'Kano', 20], [3, 'chidi', 'Lagos', 30], [4, 'dayo', 'Abuja', 40],
]) db.execSql(`INSERT INTO users (id, name, city, score) VALUES (${id}, '${name}', '${city}', ${score})`);

// 1. CTAS with an integer first column: that column becomes the key.
let r = db.execSql('CREATE TABLE lagos AS SELECT id, name, city, score FROM users WHERE city = \'Lagos\' ORDER BY id');
if (r.table !== 'lagos' || r.created !== true) throw new Error(`ctas result: ${JSON.stringify(r)}`);
eq(db.tables.get('lagos').columns.map((c) => [c.name, c.type, c.isKey]), [['id', 'INTEGER', true], ['name', 'TEXT', false], ['city', 'TEXT', false], ['score', 'INTEGER', false]], 'integer first column is the key');
eq(db.execSql('SELECT name, score FROM lagos ORDER BY id').rows.map((x) => [x.name, x.score]), [['ada', 10], ['chidi', 30]], 'rows copied');
eq(db.execSql('SELECT COUNT(*) AS n FROM lagos').rows[0].n, 2, 'row count');
console.log('ctas: integer first column becomes the key, rows copied');

// 2. CTAS with a text first column: a synthesized `id INTEGER PRIMARY KEY` leads.
r = db.execSql('CREATE TABLE bycity AS SELECT DISTINCT city FROM users ORDER BY city');
eq(db.tables.get('bycity').columns.map((c) => [c.name, c.type, c.isKey]), [['id', 'INTEGER', true], ['city', 'TEXT', false]], 'synthesized id for text-first select');
eq(db.execSql('SELECT city FROM bycity ORDER BY city').rows.map((x) => x.city), ['Abuja', 'Kano', 'Lagos'], 'bycity rows');
console.log('ctas: synthesized id column for text-first select');

// 3. Duplicate keys in the source become a duplicate-primary-key error.
throws(() => db.execSql("CREATE TABLE dupkey AS SELECT id FROM users UNION ALL SELECT id FROM users"), /duplicate primary key/, 'ctas duplicate key');
console.log('ctas: duplicates rejected as duplicate primary keys');

// 4. Aggregate selects work: the key is the aggregate value.
r = db.execSql('CREATE TABLE totals AS SELECT city, COUNT(*) AS n, SUM(score) AS total FROM users GROUP BY city');
eq(db.tables.get('totals').columns.map((c) => [c.name, c.type, c.isKey]), [['id', 'INTEGER', true], ['city', 'TEXT', false], ['n', 'INTEGER', false], ['total', 'INTEGER', false]], 'aggregate first column is the key');
eq(db.execSql('SELECT n, total FROM totals ORDER BY city').rows, [{ n: 1, total: 40 }, { n: 1, total: 20 }, { n: 2, total: 40 }], 'totals rows');
console.log('ctas: aggregate select -> key + data columns');

// 5. Empty result still creates the table (0 rows), including via IF NOT EXISTS.
r = db.execSql('CREATE TABLE empty_sel AS SELECT name, city FROM users WHERE score > 1000');
if (!r.created || r.rows !== 0) throw new Error(`empty ctas: ${JSON.stringify(r)}`);
eq(db.execSql('SELECT COUNT(*) AS n FROM empty_sel').rows[0].n, 0, 'empty ctas row count');
r = db.execSql('CREATE TABLE IF NOT EXISTS empty_sel AS SELECT name, city FROM users WHERE score > 1000');
if (r.created) throw new Error('IF NOT EXISTS re-created empty_sel');
console.log('ctas: empty results create the table with 0 rows');

// 6. IF NOT EXISTS: missing tables get created, existing ones are untouched.
r = db.execSql('CREATE TABLE IF NOT EXISTS users AS SELECT id FROM users WHERE id > 100');
if (r.created !== false) throw new Error('IF NOT EXISTS re-created users');
eq(db.execSql('SELECT COUNT(*) AS n FROM users').rows[0].n, 4, 'users unchanged after IF NOT EXISTS');
db.execSql('CREATE TABLE IF NOT EXISTS brand_new AS SELECT id, name FROM users WHERE id = 1');
eq(db.execSql('SELECT name FROM brand_new').rows.map((x) => x.name), ['ada'], 'brand_new rows');
console.log('ctas: IF NOT EXISTS guards duplicates');

// 7. Persistence across reopen.
const lagosNames = db.execSql('SELECT name, score FROM lagos ORDER BY id').rows;
db.fm.close();
db = Database.open(dbPath);
eq(db.execSql('SELECT name, score FROM lagos ORDER BY id').rows, lagosNames, 'reopened lagos rows');
eq(db.execSql('SELECT COUNT(*) AS n FROM bycity').rows[0].n, 3, 'reopened bycity');
db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('CREATE TABLE AS SELECT smoke OK');
