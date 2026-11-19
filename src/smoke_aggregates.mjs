// smoke_aggregates.mjs — aggregates, GROUP BY, HAVING, and new WHERE operators.
// Seeded data: sales (id, city, amount, status) — 20 rows, cities cycle Lagos/Abuja/Ibadan/Kano,
// amount = i * 10 (i = 1..20). City index by id: Lagos at i ∈ {1,5,9,13,17}, Abuja ∈ {2,6,10,14,18},
// Ibadan ∈ {3,7,11,15,19}, Kano ∈ {4,8,12,16,20}.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_aggregates.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const db = Database.create(dbPath);
db.execSql("CREATE TABLE sales (id INTEGER PRIMARY KEY, city TEXT, amount INTEGER, status TEXT)");

const cities = ['Lagos', 'Abuja', 'Ibadan', 'Kano'];
for (let i = 1; i <= 20; i++) {
  db.execSql(`INSERT INTO sales (city, amount, status) VALUES ('${cities[(i - 1) % 4]}', ${i * 10}, '${i % 2 ? 'paid' : 'pending'}')`);
}

// 1. COUNT(*) over the whole table (one group, no GROUP BY).
let r = db.execSql('SELECT COUNT(*) FROM sales');
if (r.rows.length !== 1 || r.rows[0]['count(*)'] !== 20) throw new Error(`COUNT(*): expected 20, got ${JSON.stringify(r.rows[0])}`);

// 2. SUM / AVG / MIN / MAX over the whole table.
r = db.execSql('SELECT SUM(amount), AVG(amount), MIN(amount), MAX(amount) FROM sales');
const s = r.rows[0];
const expected = { 'sum(amount)': 2100, 'avg(amount)': 105, 'min(amount)': 10, 'max(amount)': 200 };
for (const [k, v] of Object.entries(expected)) {
  if (s[k] === undefined || Math.abs(s[k] - v) > 1e-9) throw new Error(`${k}: expected ${v}, got ${s[k]}`);
}
console.log('aggregates ok:', JSON.stringify(s));

// 3. WHERE with AND, >= and <
r = db.execSql('SELECT id FROM sales WHERE amount >= 50 AND amount < 100');
if (r.rows.length !== 5 || r.rows[0].id !== 5 || r.rows[4].id !== 9) throw new Error(`expected ids 5..9, got ${JSON.stringify(r.rows.map((x) => x.id))}`);

// 4. WHERE with BETWEEN
r = db.execSql('SELECT id FROM sales WHERE amount BETWEEN 50 AND 150');
if (r.rows.length !== 11 || r.rows[0].id !== 5 || r.rows[10].id !== 15) throw new Error(`expected ids 5..15, got ${r.rows.length} rows`);

// 5. WHERE with <>
r = db.execSql("SELECT id FROM sales WHERE city <> 'Lagos'");
if (r.rows.length !== 15) throw new Error(`expected 15 rows without Lagos, got ${r.rows.length}`);

// 6. WHERE with >= and <=
r = db.execSql('SELECT id FROM sales WHERE amount >= 100 AND amount <= 200');
if (r.rows.length !== 11) throw new Error(`expected 11 rows, got ${r.rows.length}`);

// 7. GROUP BY with aliases + ORDER BY on the alias
r = db.execSql('SELECT city, COUNT(*) AS n, SUM(amount) AS total FROM sales GROUP BY city ORDER BY city');
const expectGroups = { Abuja: { n: 5, total: 500 }, Ibadan: { n: 5, total: 550 }, Kano: { n: 5, total: 600 }, Lagos: { n: 5, total: 450 } };
if (r.rows.length !== 4) throw new Error(`expected 4 groups, got ${r.rows.length}`);
for (const row of r.rows) {
  const want = expectGroups[row.city];
  if (!want || row.n !== want.n || row.total !== want.total) throw new Error(`city ${row.city}: expected ${JSON.stringify(want)}, got ${JSON.stringify(row)}`);
}
console.log('group by ok:', JSON.stringify(r.rows.map((x) => [x.city, x.n, x.total])));

// 8. HAVING on the aggregate alias
r = db.execSql('SELECT city, COUNT(*) AS n FROM sales GROUP BY city HAVING n > 4');
if (r.rows.length !== 4) throw new Error(`expected 4 rows with n > 4, got ${r.rows.length}`);
r = db.execSql('SELECT city, COUNT(*) AS n FROM sales GROUP BY city HAVING n > 6');
if (r.rows.length !== 0) throw new Error(`expected 0 rows with n > 6, got ${r.rows.length}`);
console.log('having ok');

// 9. Projection: SELECT id → rows have exactly { id }
r = db.execSql('SELECT id FROM sales WHERE amount < 100');
if (r.rows.length !== 9) throw new Error(`expected 9 rows, got ${r.rows.length}`);
if (JSON.stringify(Object.keys(r.rows[0])) !== JSON.stringify(['id'])) throw new Error(`expected row keys ['id'], got ${JSON.stringify(Object.keys(r.rows[0]))}`);
console.log('projection ok');

// 10. COUNT(col) counts non-null values of a column in each group
r = db.execSql('SELECT city, COUNT(city) FROM sales GROUP BY city');
if (!r.rows.every((row) => row['count(city)'] === 5)) throw new Error(`COUNT(col): ${JSON.stringify(r.rows)}`);

// 11. DISTINCT removes duplicate projected rows (before ORDER BY / LIMIT).
r = db.execSql('SELECT DISTINCT city FROM sales ORDER BY city');
if (r.rows.length !== 4) throw new Error(`DISTINCT city: expected 4, got ${r.rows.length}`);
r = db.execSql('SELECT DISTINCT status FROM sales');
if (r.rows.length !== 2) throw new Error(`DISTINCT status: expected 2, got ${r.rows.length}`);
r = db.execSql('SELECT DISTINCT city FROM sales ORDER BY city LIMIT 2');
if (JSON.stringify(r.rows.map((x) => x.city)) !== JSON.stringify(['Abuja', 'Ibadan'])) throw new Error(`DISTINCT + LIMIT: ${JSON.stringify(r.rows)}`);
console.log('distinct ok');

console.log('aggregates smoke OK');
