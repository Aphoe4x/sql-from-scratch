// smoke_like.mjs — LIKE / NOT LIKE with % and _, case sensitivity, escaped
// regex metacharacters, and use in WHERE / UPDATE / DELETE.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_like.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
db.execSql('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
const names = ['ada', 'adaeze', 'bola', 'chidi', 'dayo', 'emeka', 'a.b', 'a_b', ''];
names.forEach((n) => db.execSql(`INSERT INTO items (name) VALUES ('${n}')`));

const picked = (sql) => db.execSql(sql).rows.map((r) => r.name);
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// 1. `%` = any run of characters.
eq(picked("SELECT name FROM items WHERE name LIKE 'ad%'"), ['ada', 'adaeze'], 'prefix');
eq(picked("SELECT name FROM items WHERE name LIKE '%a'").sort(), ['ada', 'bola', 'emeka'], 'suffix');
eq(picked("SELECT name FROM items WHERE name LIKE '%da%'").sort(), ['ada', 'adaeze', 'dayo'], 'infix');
// 2. `_` = exactly one character (note: a_b also matches a.b).
eq(picked("SELECT name FROM items WHERE name LIKE '_da'"), ['ada'], 'single wildcard');
eq(picked("SELECT name FROM items WHERE name LIKE 'a_b'").sort(), ['a.b', 'a_b'], 'underscore matches any char');
// 3. Regex metacharacters in the pattern are literal.
eq(picked("SELECT name FROM items WHERE name LIKE 'a.b'"), ['a.b'], 'dot is literal');
// 4. NOT LIKE.
eq(picked("SELECT name FROM items WHERE name NOT LIKE 'a%'").sort(), ['', 'bola', 'chidi', 'dayo', 'emeka'], 'not like');
// 5. Case-sensitive (no COLLATE NOCASE).
eq(picked("SELECT name FROM items WHERE name LIKE 'A%'"), [], 'case sensitive');
// 6. `%` matches the empty string; an empty pattern matches only ''.
eq(picked("SELECT name FROM items WHERE name LIKE '%'").length, 9, 'percent matches everything');
eq(picked("SELECT name FROM items WHERE name LIKE ''"), [''], 'empty pattern');
// 7. AND chains and plans.
eq(picked('SELECT name FROM items WHERE id > 2 AND name LIKE \'%a\'').sort(), ['bola', 'emeka'], 'and chain');
const plan = db.execSql("SELECT name FROM items WHERE name LIKE 'ad%'").plan;
if (plan.strategy !== 'full-scan' || !plan.filtered) throw new Error(`like plan: ${JSON.stringify(plan)}`);
console.log('like: %, _, literal metacharacters, NOT LIKE, case sensitivity, AND chain ok');

// 8. LIKE drives UPDATE and DELETE.
const upd = db.execSql("UPDATE items SET name = 'x' WHERE name LIKE 'a%'");
if (upd.updated !== 4) throw new Error(`update like: ${upd.updated}`);
if (db.execSql("SELECT COUNT(*) AS n FROM items WHERE name = 'x'").rows[0].n !== 4) throw new Error('update like values');
const del = db.execSql("DELETE FROM items WHERE name LIKE '_'");
if (del.deleted !== 4) throw new Error(`delete like: ${del.deleted}`);
eq(picked('SELECT name FROM items ORDER BY id'), ['bola', 'chidi', 'dayo', 'emeka', ''], 'after dml');
console.log('like: UPDATE and DELETE predicates ok');

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('LIKE smoke OK');
