// smoke_joins.mjs — nested-loop joins: INNER, LEFT, comma cross joins, qualified names,
// joins + GROUP BY / aggregates / ORDER BY on a non-selected column.
//
// customers: 1 Ada/Lagos, 2 Bola/Abuja, 3 Chidi/Kano, 4 Dami/Lagos, 5 Eze/Abuja
// orders:    (1,c1,100) (2,c1,50) (3,c2,200) (4,c3,75) (5,c99,10)  <- order 5 is an orphan
import fs from 'node:fs';
import { Database } from './engine.mjs';
import { planQuery } from './planner.mjs';

const dbPath = 'smoke_joins.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
db.execSql('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT)');
db.execSql('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER)');

for (const [name, city] of [['Ada', 'Lagos'], ['Bola', 'Abuja'], ['Chidi', 'Kano'], ['Dami', 'Lagos'], ['Eze', 'Abuja']]) {
  db.execSql(`INSERT INTO customers (name, city) VALUES ('${name}', '${city}')`);
}
for (const [cid, amount] of [[1, 100], [1, 50], [2, 200], [3, 75], [99, 10]]) {
  db.execSql(`INSERT INTO orders (customer_id, amount) VALUES (${cid}, ${amount})`);
}

const ids = (rows, key = 'id') => rows.map((r) => r[key]);

// 1. INNER JOIN with table aliases; ORDER BY a column that is not selected.
let r = db.execSql('SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY o.id');
if (r.rows.length !== 4) throw new Error(`inner join: expected 4 rows, got ${r.rows.length}`);
if (JSON.stringify(r.rows.map((x) => [x.name, x.amount])) !== JSON.stringify([['Ada', 100], ['Ada', 50], ['Bola', 200], ['Chidi', 75]])) {
  throw new Error(`inner join rows wrong: ${JSON.stringify(r.rows)}`);
}
console.log('inner join ok:', JSON.stringify(r.rows));

// 2. LEFT JOIN keeps all customers (Ada appears twice — she has two orders).
r = db.execSql('SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id ORDER BY c.id');
if (r.rows.length !== 6) throw new Error(`left join: expected 6 rows, got ${r.rows.length}`);
if (r.rows[4].amount !== undefined || r.rows[5].amount !== undefined) throw new Error(`left join: unmatched customers should have no amount: ${JSON.stringify(r.rows)}`);
if (r.rows[4].name !== 'Dami' || r.rows[5].name !== 'Eze') throw new Error(`left join tail: ${JSON.stringify(r.rows.slice(4))}`);
const total = r.rows.reduce((a, x) => a + (x.amount ?? 0), 0);
if (total !== 425) throw new Error(`left join total: expected 425, got ${total}`);
console.log('left join ok: 6 rows, total 425, Dami/Eze unmatched');

// 3. LEFT JOIN the other way: the orphan order survives with no customer name.
r = db.execSql('SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON o.customer_id = c.id ORDER BY o.id');
if (r.rows.length !== 5) throw new Error(`left join (orders first): expected 5 rows, got ${r.rows.length}`);
if (r.rows[4].id !== 5 || r.rows[4].name !== undefined) throw new Error(`orphan order should have no name: ${JSON.stringify(r.rows[4])}`);
console.log('left join (orphan) ok:', JSON.stringify(r.rows[4]));

// 4. Comma cross join filtered by WHERE.
r = db.execSql('SELECT c.name, o.id FROM customers c, orders o WHERE c.id = o.customer_id ORDER BY o.id');
if (r.rows.length !== 4) throw new Error(`cross join + where: expected 4 rows, got ${r.rows.length}`);
console.log('comma cross join ok: 4 rows');

// 5. JOIN + GROUP BY + aggregates, ORDER BY an alias.
r = db.execSql('SELECT c.name, COUNT(*) AS n, SUM(o.amount) AS total FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.name ORDER BY n DESC, c.name');
const groups = r.rows.map((x) => [x.name, x.n, x.total]);
if (JSON.stringify(groups) !== JSON.stringify([['Ada', 2, 150], ['Bola', 1, 200], ['Chidi', 1, 75]])) {
  throw new Error(`join+group by wrong: ${JSON.stringify(groups)}`);
}
console.log('join + group by ok:', JSON.stringify(groups));

// 6. COUNT(*) over the whole join; count(o.id) counts only matched rows.
r = db.execSql('SELECT COUNT(*) AS all_rows, COUNT(o.id) AS order_rows FROM customers c LEFT JOIN orders o ON c.id = o.customer_id');
if (r.rows[0].all_rows !== 6 || r.rows[0].order_rows !== 4) throw new Error(`count over left join: ${JSON.stringify(r.rows[0])}`);
console.log('count over left join ok:', JSON.stringify(r.rows[0]));

// 7. Qualified star: only the requested table's columns.
r = db.execSql('SELECT c.* FROM customers c WHERE c.id = 1');
if (JSON.stringify(r.columns) !== JSON.stringify(['id', 'name', 'city'])) throw new Error(`c.* columns: ${JSON.stringify(r.columns)}`);
if (r.rows.length !== 1 || r.rows[0].name !== 'Ada') throw new Error(`c.* rows: ${JSON.stringify(r.rows)}`);
console.log('qualified star ok:', JSON.stringify(r.columns));

// 8. Plain * on a join: duplicate column names get qualified keys.
r = db.execSql('SELECT * FROM customers c JOIN orders o ON c.id = o.customer_id WHERE o.id = 1');
const keys = Object.keys(r.rows[0]);
if (!keys.includes('c.id') || !keys.includes('o.id') || !keys.includes('name') || !keys.includes('amount')) {
  throw new Error(`star join keys: ${JSON.stringify(keys)}`);
}
console.log('star join keys ok:', JSON.stringify(keys));

// 9. Unqualified unique columns resolve across sources; aliases rename output keys.
r = db.execSql('SELECT c.name AS who, o.amount AS amt FROM customers c JOIN orders o ON c.id = o.customer_id WHERE o.id = 3');
if (JSON.stringify(r.rows) !== JSON.stringify([{ who: 'Bola', amt: 200 }])) throw new Error(`alias projection: ${JSON.stringify(r.rows)}`);

// 10. Planner reports a nested-loop join with a pages/rows estimate.
const plan = planQuery(db, 'SELECT c.name FROM customers c JOIN orders o ON c.id = o.customer_id');
if (plan.strategy !== 'nested-loop-join') throw new Error(`plan strategy: ${plan.strategy}`);
if (!(plan.estimatedPages > 0) || plan.estimatedRows !== 25) throw new Error(`plan estimate: ${JSON.stringify(plan)}`);
console.log('join plan ok:', JSON.stringify(plan));

// 11. Three-table join.
db.execSql('CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT)');
db.execSql("INSERT INTO items (order_id, sku) VALUES (1, 'abc')");
db.execSql("INSERT INTO items (order_id, sku) VALUES (1, 'def')");
db.execSql("INSERT INTO items (order_id, sku) VALUES (3, 'ghi')");
r = db.execSql('SELECT c.name, o.id, i.sku FROM customers c JOIN orders o ON c.id = o.customer_id JOIN items i ON i.order_id = o.id ORDER BY i.id');
if (JSON.stringify(r.rows.map((x) => x.sku)) !== JSON.stringify(['abc', 'def', 'ghi'])) throw new Error(`3-table join: ${JSON.stringify(r.rows)}`);
console.log('3-table join ok:', JSON.stringify(r.rows));

console.log('joins smoke OK');
