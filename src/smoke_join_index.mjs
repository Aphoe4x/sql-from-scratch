// smoke_join_index.mjs — the planner turns an ON equality into index probes
// when the joined column is the key or has a secondary index. Results must be
// identical to the nested-loop/cross-join path.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_join_index.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
db.execSql('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT)');
db.execSql('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER)');

const custVals = Array.from({ length: 50 }, (_, i) => `('cust-${i + 1}', '${['Lagos', 'Kano', 'Abuja'][i % 3]}')`).join(', ');
db.execSql(`INSERT INTO customers (name, city) VALUES ${custVals}`);
// 400 orders spread over customers 1..40, so customers 41..50 have none.
const orderVals = Array.from({ length: 400 }, (_, i) => `(${1 + (i % 40)}, ${(i + 1) * 10})`).join(', ');
db.execSql(`INSERT INTO orders (customer_id, amount) VALUES ${orderVals}`);
db.execSql('CREATE INDEX idx_orders_customer ON orders (customer_id)');

// 1. Join on an indexed column: same rows as the cross-join + WHERE form.
const sortRows = (rows, keys) =>
  rows
    .map((r) => keys.map((k) => String(r[k])))
    .sort((a, b) => (a.join('|') < b.join('|') ? -1 : a.join('|') > b.join('|') ? 1 : 0));
const indexed = db.execSql('SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id');
const cross = db.execSql('SELECT c.name, o.amount FROM customers c, orders o WHERE c.id = o.customer_id');
if (indexed.rows.length !== 400) throw new Error(`index join rows: ${indexed.rows.length}`);
if (JSON.stringify(sortRows(indexed.rows, ['name', 'amount'])) !== JSON.stringify(sortRows(cross.rows, ['name', 'amount']))) {
  throw new Error('index join disagrees with the cross-join path');
}
if (indexed.plan.strategy !== 'index-nested-loop-join') throw new Error(`plan: ${indexed.plan.strategy}`);
if (cross.plan.strategy !== 'nested-loop-join') throw new Error(`cross plan: ${cross.plan.strategy}`);
if (!(indexed.plan.comparisons < cross.plan.comparisons)) {
  throw new Error(`comparison estimate: ${indexed.plan.comparisons} vs ${cross.plan.comparisons}`);
}
console.log(`join: index path matches nested-loop (${indexed.rows.length} rows, ~${indexed.plan.comparisons} vs ~${cross.plan.comparisons} comparisons)`);

// 2. The key column of the *newly joined* table is probeable too.
const keyed = db.execSql('SELECT o.amount, c.name FROM orders o JOIN customers c ON o.customer_id = c.id');
if (keyed.rows.length !== 400 || keyed.plan.strategy !== 'index-nested-loop-join') throw new Error('key-side join failed');
const keyCross = db.execSql('SELECT o.amount, c.name FROM orders o, customers c WHERE o.customer_id = c.id');
if (JSON.stringify(sortRows(keyed.rows, ['name', 'amount'])) !== JSON.stringify(sortRows(keyCross.rows, ['name', 'amount']))) {
  throw new Error('key-side index join disagrees');
}
console.log('join: primary-key inner side uses the B-tree');

// 3. LEFT JOIN keeps customers with no orders.
const left = db.execSql('SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id');
if (left.rows.length !== 410) throw new Error(`left join rows: ${left.rows.length}`);
if (left.rows.filter((r) => r.amount === undefined).length !== 10) throw new Error('left join lost unmatched customers');
if (left.plan.strategy !== 'index-nested-loop-join') throw new Error(`left plan: ${left.plan.strategy}`);
console.log('join: LEFT JOIN preserves all 10 customers without orders');

// 4. TEXT secondary index as the inner side.
db.execSql('CREATE INDEX idx_customers_city ON customers (city)');
db.execSql('CREATE TABLE regions (id INTEGER PRIMARY KEY, city TEXT)');
db.execSql("INSERT INTO regions (city) VALUES ('Lagos'), ('Kano'), ('Abuja')");
db.execSql('CREATE INDEX idx_regions_city ON regions (city)');
const byCity = db.execSql('SELECT c.name, r.id FROM customers c JOIN regions r ON c.city = r.city');
if (byCity.rows.length !== 50) throw new Error(`text join rows: ${byCity.rows.length}`);
if (byCity.plan.strategy !== 'index-nested-loop-join') throw new Error(`text join plan: ${byCity.plan.strategy}`);
const cityCounts = {};
for (const r of byCity.rows) cityCounts[r.id] = (cityCounts[r.id] ?? 0) + 1;
if (JSON.stringify(cityCounts) !== JSON.stringify({ 1: 17, 2: 17, 3: 16 })) throw new Error(`city split: ${JSON.stringify(cityCounts)}`);
console.log('join: TEXT secondary index on the inner side, bucket contents correct');

// 5. No index on the inner column: fall back to the nested loop, still correct.
db.execSql('CREATE TABLE nums (id INTEGER PRIMARY KEY, v INTEGER)');
db.execSql('INSERT INTO nums (v) VALUES (1), (2), (3), (40)');
const fallback = db.execSql('SELECT c.name, n.v FROM customers c JOIN nums n ON c.id = n.v');
if (fallback.plan.strategy !== 'nested-loop-join') throw new Error(`fallback plan: ${fallback.plan.strategy}`);
if (fallback.rows.length !== 4) throw new Error(`fallback rows: ${fallback.rows.length}`);
eqRows(fallback.rows.map((r) => `${r.name}:${r.v}`).sort(), ['cust-1:1', 'cust-2:2', 'cust-3:3', 'cust-40:40']);
console.log('join: unindexed inner column falls back to nested-loop');

function eqRows(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

// 6. WHERE on both sides still filters after the index join.
const filtered = db.execSql("SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id WHERE c.city = 'Kano' AND o.amount > 1000");
for (const r of filtered.rows) {
  if (r.amount <= 1000) throw new Error('WHERE o.amount filter not applied');
}
const checked = db.execSql("SELECT c.name, o.amount FROM customers c, orders o WHERE c.id = o.customer_id AND c.city = 'Kano' AND o.amount > 1000");
if (JSON.stringify(sortRows(filtered.rows, ['name', 'amount'])) !== JSON.stringify(sortRows(checked.rows, ['name', 'amount']))) {
  throw new Error('filtered index join disagrees');
}
console.log(`join: WHERE on both sides filters correctly (${filtered.rows.length} rows)`);

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('index join smoke OK');
