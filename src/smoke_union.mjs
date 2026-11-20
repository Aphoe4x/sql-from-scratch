// smoke_union.mjs — query composition: UNION / UNION ALL, trailing ORDER BY +
// LIMIT over the combined result, and IN / NOT IN with literal lists or a
// single-column subquery (SELECT, and inside UPDATE / DELETE).
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_union.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
const q = (sql) => db.execSql(sql);
const rows = (sql) => q(sql).rows;
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

db.execSql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT, team TEXT)');
for (const [name, city, team] of [
  ['ada', 'Lagos', 'alpha'],
  ['bola', 'Kano', 'alpha'],
  ['chidi', 'Lagos', 'beta'],
  ['dayo', 'Abuja', 'beta'],
  ['emeka', 'Kano', 'gamma'],
  ['femi', 'Lagos', 'gamma'],
]) db.execSql(`INSERT INTO users (name, city, team) VALUES ('${name}', '${city}', '${team}')`);

db.execSql('CREATE TABLE admins (id INTEGER PRIMARY KEY, name TEXT)');
db.execSql("INSERT INTO admins (name) VALUES ('ada')");
db.execSql("INSERT INTO admins (name) VALUES ('grace')");
db.execSql('CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT)');
db.execSql("INSERT INTO teams (name) VALUES ('alpha')");
db.execSql("INSERT INTO teams (name) VALUES ('gamma')");

// 1. UNION removes duplicates across branches.
eq(rows('SELECT city FROM users UNION SELECT city FROM users').map((r) => r.city), ['Lagos', 'Kano', 'Abuja'], 'union distinct');
// 2. UNION ALL keeps them.
if (rows('SELECT city FROM users UNION ALL SELECT city FROM users').length !== 12) throw new Error('union all kept the wrong count');
// 3. Result columns take the first branch's names; the other branch is matched positionally.
eq(rows("SELECT city AS place FROM users UNION SELECT name FROM admins ORDER BY place").map((r) => r.place), ['Abuja', 'Kano', 'Lagos', 'ada', 'grace'], 'union column names');
// 4. ORDER BY DESC + LIMIT apply to the whole union.
eq(rows('SELECT name FROM users UNION SELECT name FROM admins ORDER BY name DESC LIMIT 2').map((r) => r.name), ['grace', 'femi'], 'union order/limit');
// 5. A chain is left-associative: `A UNION ALL B UNION C` dedupes the final result.
const mixed = rows("SELECT city FROM users UNION ALL SELECT city FROM users UNION SELECT city FROM users");
eq(mixed.map((r) => r.city), ['Lagos', 'Kano', 'Abuja'], 'mixed chain');
// 6. Branches may carry their own WHERE / aggregates.
eq(rows('SELECT COUNT(*) AS n FROM users UNION ALL SELECT COUNT(*) AS n FROM admins').map((r) => r.n), [6, 2], 'aggregate branches');
eq(rows("SELECT name FROM users WHERE city = 'Lagos' UNION SELECT name FROM users WHERE team = 'gamma' ORDER BY name").map((r) => r.name), ['ada', 'chidi', 'emeka', 'femi'], 'union of filtered branches');
// 7. The planner labels the strategy.
eq(q('SELECT name FROM users UNION SELECT name FROM admins').plan.strategy, 'union', 'union plan');
eq(q('SELECT name FROM users UNION ALL SELECT name FROM admins').plan.strategy, 'union-all', 'union-all plan');
console.log('union: dedupe, union all, column naming, order/limit, mixed chain, plans ok');

// 8. IN / NOT IN with a literal list.
eq(rows("SELECT name FROM users WHERE city IN ('Lagos', 'Kano') ORDER BY name").map((r) => r.name), ['ada', 'bola', 'chidi', 'emeka', 'femi'], 'in list');
eq(rows("SELECT name FROM users WHERE city NOT IN ('Lagos', 'Kano')").map((r) => r.name), ['dayo'], 'not in list');
// 9. IN / NOT IN against a subquery.
eq(rows('SELECT name FROM users WHERE name IN (SELECT name FROM admins)').map((r) => r.name), ['ada'], 'in subquery');
eq(rows('SELECT name FROM users WHERE name NOT IN (SELECT name FROM admins) ORDER BY name').map((r) => r.name), ['bola', 'chidi', 'dayo', 'emeka', 'femi'], 'not in subquery');
eq(rows('SELECT name FROM users WHERE team IN (SELECT name FROM teams) ORDER BY name').map((r) => r.name), ['ada', 'bola', 'emeka', 'femi'], 'in subquery on a non-key column');
// 10. The subquery may itself be a UNION.
eq(rows("SELECT name FROM users WHERE city IN (SELECT city FROM users WHERE city = 'Abuja' UNION SELECT city FROM users WHERE city = 'Lagos') ORDER BY name").map((r) => r.name), ['ada', 'chidi', 'dayo', 'femi'], 'in union subquery');
console.log('in: literal lists, subqueries, subquery union ok');

// 11. A subquery must project exactly one column.
let threw = false;
try {
  q('SELECT * FROM users WHERE id IN (SELECT id, name FROM admins)');
} catch (err) {
  threw = /exactly one column/.test(err.message);
}
if (!threw) throw new Error('multi-column IN subquery was accepted');

// 12. IN subqueries inside UPDATE / DELETE.
db.execSql('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount INTEGER)');
for (let i = 1; i <= 6; i++) db.execSql(`INSERT INTO orders (user_id, amount) VALUES (${i}, ${i * 10})`);
db.execSql('CREATE TABLE vip (id INTEGER PRIMARY KEY)');
db.execSql('INSERT INTO vip (id) VALUES (1)');
db.execSql('INSERT INTO vip (id) VALUES (3)');
eq(q('DELETE FROM orders WHERE user_id IN (SELECT id FROM vip)').deleted, 2, 'delete with subquery');
eq(q('UPDATE orders SET amount = 0 WHERE user_id NOT IN (SELECT id FROM vip)').updated, 4, 'update with subquery');
eq(rows('SELECT id, amount FROM orders ORDER BY id').map((r) => [r.id, r.amount]), [[2, 0], [4, 0], [5, 0], [6, 0]], 'dml subquery result');
console.log('in: multi-column rejected, DELETE/UPDATE with subquery ok');

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('union / subquery smoke OK');
