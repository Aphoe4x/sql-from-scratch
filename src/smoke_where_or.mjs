// smoke_where_or.mjs — OR logic and parenthesised condition groups.
// AND binds tighter than OR; parentheses override that. The planner may only
// use an index when an equality is ANDed at the top level.
import fs from 'node:fs';
import { Database } from './engine.mjs';
import { planQuery } from './planner.mjs';

const dbPath = 'smoke_where_or.db';
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

const db = Database.create(dbPath);
db.execSql('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, city TEXT, price INTEGER, tag TEXT)');
const cities = ['Lagos', 'Kano', 'Abuja', 'Ibadan'];
for (let i = 1; i <= 40; i++) {
  db.execSql(`INSERT INTO items (name, city, price, tag) VALUES ('i${i}', '${cities[(i - 1) % 4]}', ${i * 5}, '${i % 3 === 0 ? 'sale' : 'full'}')`);
}
db.execSql('CREATE INDEX ix_items_city ON items (city)');

const ids = (sql) => db.execSql(sql).rows.map((r) => r.id);
const sorted = (a) => [...a].sort((x, y) => x - y);

// 1. Simple OR.
eq(sorted(ids("SELECT id FROM items WHERE city = 'Lagos' OR city = 'Kano'")),
  sorted([1, 2, 5, 6, 9, 10, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38]), 'simple OR');
console.log('or: two equality branches ok');

// 2. AND binds tighter than OR: `tag='sale' AND city='Lagos' OR city='Abuja'`
//    means (tag='sale' AND city='Lagos') OR city='Abuja'.
const tagSaleLagos = [9, 21, 33];             // i%12==9 -> sale + Lagos
const abuja = [3, 7, 11, 15, 19, 23, 27, 31, 35, 39];
eq(sorted(ids("SELECT id FROM items WHERE tag = 'sale' AND city = 'Lagos' OR city = 'Abuja'")),
  sorted([...tagSaleLagos, ...abuja]), 'AND before OR');
console.log('or: AND precedence over OR ok');

// 3. Parentheses override precedence: (tag='sale' OR city='Abuja') AND price > 100.
const saleIds = Array.from({ length: 13 }, (_, k) => 3 * (k + 1)); // 3,6,...,39
const expectParen = [...new Set([...saleIds, ...abuja])].filter((id) => id * 5 > 100).sort((a, b) => a - b);
eq(sorted(ids("SELECT id FROM items WHERE (tag = 'sale' OR city = 'Abuja') AND price > 100")), expectParen, 'parenthesised OR');
console.log('or: parentheses group tighter ok');

// 4. Nested groups.
eq(sorted(ids("SELECT id FROM items WHERE (city = 'Lagos' OR (city = 'Kano' AND price > 150))")),
  sorted([1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 34, 38]), 'nested group');
console.log('or: nested groups ok');

// 5. OR combined with IN / NOT IN / LIKE / BETWEEN.
const lagosAndIbadan = [...[1, 5, 9, 13, 17, 21, 25, 29, 33, 37], ...[4, 8, 12, 16, 20, 24, 28, 32, 36, 40]];
eq(sorted(ids("SELECT id FROM items WHERE city IN ('Lagos', 'Ibadan') OR name = 'i2'")),
  sorted([...lagosAndIbadan, 2]), 'OR with IN');
if (ids("SELECT id FROM items WHERE name LIKE 'i1%' OR price BETWEEN 190 AND 200").length !== 14) throw new Error('OR with LIKE/BETWEEN');
console.log('or: IN / LIKE / BETWEEN branches ok');

// 6. Index still used when an equality is ANDed with an OR group.
const plan = planQuery(db, "SELECT id FROM items WHERE city = 'Lagos' AND (price < 30 OR price > 180)");
if (plan.strategy !== 'secondary-index-seek' || plan.index !== 'ix_items_city') throw new Error(`plan: ${JSON.stringify(plan)}`);
eq(sorted(ids("SELECT id FROM items WHERE city = 'Lagos' AND (price < 30 OR price > 180)")), [1, 5, 37], 'index + OR group');
// A top-level OR cannot use one index for both branches.
if (planQuery(db, "SELECT id FROM items WHERE city = 'Lagos' OR city = 'Kano'").strategy !== 'full-scan') throw new Error('top-level OR should plan a filtered scan');
console.log('or: index seek preserved for ANDed equality, top-level OR scans');

// 7. OR in UPDATE and DELETE.
let res = db.execSql("UPDATE items SET tag = 'promo' WHERE city = 'Kano' OR price = 5");
if (res.updated !== 10 + 1) throw new Error(`update OR: ${res.updated}`); // 10 Kano rows, id 1 not Kano
eq(db.execSql("SELECT COUNT(*) AS n FROM items WHERE tag = 'promo'").rows[0].n, 11, 'update OR applied');
res = db.execSql("DELETE FROM items WHERE name = 'i4' OR (city = 'Abuja' AND price > 150)");
if (res.deleted !== 1 + 3) throw new Error(`delete OR: ${res.deleted}`); // i4 + Abuja ids 35,39 (price 175,195)
eq(db.execSql('SELECT COUNT(*) AS n FROM items').rows[0].n, 40 - 4, 'delete OR removed');
console.log('or: UPDATE and DELETE predicates ok');

// 8. OR in HAVING over aggregates.
res = db.execSql("SELECT city, COUNT(*) AS n FROM items GROUP BY city HAVING n > 8 OR city = 'Abuja'");
if (res.rows.length !== 4) throw new Error(`HAVING OR: ${JSON.stringify(res.rows)}`);
res = db.execSql("SELECT city, COUNT(*) AS n FROM items GROUP BY city HAVING n > 8 OR city = 'Nope'");
if (res.rows.length !== 3) throw new Error(`HAVING OR filtered: ${JSON.stringify(res.rows)}`);
console.log('or: HAVING combinations ok');

// 9. OR with a subquery branch.
eq(sorted(ids("SELECT id FROM items WHERE city = 'Abuja' OR id IN (SELECT id FROM items WHERE tag = 'sale')")),
  sorted([...ids("SELECT id FROM items WHERE city = 'Abuja'"), ...ids("SELECT id FROM items WHERE tag = 'sale'")].filter((v, i, a) => a.indexOf(v) === i)),
  'OR with subquery');
console.log('or: IN (SELECT ...) inside a branch ok');

// 10. Malformed parentheses are rejected.
throws(() => db.execSql("SELECT id FROM items WHERE (city = 'Lagos'"), /expected|EOF/i, 'unclosed paren');
throws(() => db.execSql("SELECT id FROM items WHERE city = 'Lagos')"), /unexpected|trailing/i, 'stray close paren');
console.log('or: malformed groups rejected');

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('WHERE OR smoke OK');
