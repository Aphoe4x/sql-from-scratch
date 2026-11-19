// smoke_indexes.mjs — secondary indexes (CREATE INDEX), index maintenance across
// INSERT/UPDATE/DELETE, persistence across reopen, planner costing, LIMIT/OFFSET.
import fs from 'node:fs';
import { Database } from './engine.mjs';
import { planQuery } from './planner.mjs';

const dbPath = 'smoke_indexes.db';
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const cities = ['Lagos', 'Abuja', 'Kano', 'Ibadan', 'Enugu', 'Port'];
const count = (db, city) => db.execSql(`SELECT COUNT(*) AS n FROM users WHERE city = '${city}'`).rows[0].n;

let db = Database.create(dbPath);
db.execSql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT)');
for (let i = 1; i <= 300; i++) db.execSql(`INSERT INTO users (name, city) VALUES ('u${i}', '${cities[i % 6]}')`);
console.log('seeded:', db.query('users').length, 'rows (Lagos =', count(db, 'Lagos'), ')');

// 1. CREATE INDEX builds over existing rows.
const created = db.execSql('CREATE INDEX idx_users_city ON users (city)');
if (created.index !== 'idx_users_city') throw new Error(`index name: ${created.index}`);
if (count(db, 'Lagos') !== 50) throw new Error(`post-index Lagos count: ${count(db, 'Lagos')}`);
console.log('create index ok:', created.index);

// 2. Planner prefers the secondary index for equality on the indexed column.
let plan = planQuery(db, "SELECT id FROM users WHERE city = 'Kano'");
if (plan.strategy !== 'secondary-index-seek' || plan.index !== 'idx_users_city') throw new Error(`planner: ${JSON.stringify(plan)}`);
console.log('planner ok:', JSON.stringify(plan));

// 3. Index-driven results equal the full-scan results (compare against query()).
for (const city of cities) {
  const viaIndex = db.execSql(`SELECT id FROM users WHERE city = '${city}' ORDER BY id`).rows.map((r) => r.id);
  const viaScan = db.query('users', { where: { conditions: [{ col: 'city', op: '=', value: city }] } }).map((r) => r.id).sort((a, b) => a - b);
  if (JSON.stringify(viaIndex) !== JSON.stringify(viaScan)) throw new Error(`index vs scan mismatch for ${city}: ${viaIndex.length} vs ${viaScan.length}`);
}
console.log('index vs full scan ok for all 6 cities');

// 4. Index is maintained on INSERT.
db.execSql("INSERT INTO users (name, city) VALUES ('extra', 'Lagos')");
if (count(db, 'Lagos') !== 51) throw new Error(`insert not indexed: ${count(db, 'Lagos')}`);

// 5. Index is maintained on UPDATE (old bucket loses the row id, new one gains it).
db.execSql("UPDATE users SET city = 'Abuja' WHERE name = 'extra'");
if (count(db, 'Lagos') !== 50) throw new Error(`update left stale Lagos entry: ${count(db, 'Lagos')}`);
if (count(db, 'Abuja') !== 51) throw new Error(`update did not index Abuja: ${count(db, 'Abuja')}`);

// 6. Index is maintained on DELETE.
db.execSql("DELETE FROM users WHERE name = 'extra'");
if (count(db, 'Abuja') !== 50) throw new Error(`delete left stale Abuja entry: ${count(db, 'Abuja')}`);
console.log('insert/update/delete index maintenance ok');

// 7. Persistence: index directory + trees survive close/reopen.
db.fm.close();
db = Database.open(dbPath);
if (db.query('users').length !== 300) throw new Error(`reopen row count: ${db.query('users').length}`);
plan = planQuery(db, "SELECT id FROM users WHERE city = 'Ibadan'");
if (plan.strategy !== 'secondary-index-seek') throw new Error(`reopen planner: ${JSON.stringify(plan)}`);
if (count(db, 'Ibadan') !== 50) throw new Error(`reopen index lookup: ${count(db, 'Ibadan')}`);
console.log('reopen ok: index survived (Ibadan = 50)');

// 8. Bulk DELETE of one indexed value empties that bucket (entries are removed, not left dangling).
const del = db.execSql("DELETE FROM users WHERE city = 'Port'");
if (del.deleted !== 50) throw new Error(`bulk delete: expected 50, got ${del.deleted}`);
if (count(db, 'Port') !== 0) throw new Error(`bulk delete stale entries: ${count(db, 'Port')}`);
if (db.query('users').length !== 250) throw new Error(`rows after bulk delete: ${db.query('users').length}`);
console.log('bulk delete ok: 50 removed, bucket empty');

// 9. LIMIT / OFFSET.
const allIds = db.execSql('SELECT id FROM users ORDER BY id ASC').rows.map((x) => x.id);
let r = db.execSql('SELECT id FROM users ORDER BY id ASC LIMIT 5 OFFSET 10');
if (JSON.stringify(r.rows.map((x) => x.id)) !== JSON.stringify(allIds.slice(10, 15))) throw new Error(`limit/offset: ${JSON.stringify(r.rows)}`);
r = db.execSql('SELECT id FROM users ORDER BY id DESC LIMIT 3');
if (JSON.stringify(r.rows.map((x) => x.id)) !== JSON.stringify([...allIds].reverse().slice(0, 3))) throw new Error(`limit desc: ${JSON.stringify(r.rows)}`);
r = db.execSql('SELECT id FROM users LIMIT 0');
if (r.rows.length !== 0) throw new Error(`limit 0: ${r.rows.length} rows`);
r = db.execSql("SELECT city, COUNT(*) AS n FROM users GROUP BY city ORDER BY n DESC LIMIT 2");
if (r.rows.length !== 2 || r.rows[0].n < r.rows[1].n) throw new Error(`limit after group by: ${JSON.stringify(r.rows)}`);
console.log('limit/offset ok:', JSON.stringify(r.rows));

// 10. Bad index target is rejected.
let threw = false;
try {
  db.execSql('CREATE INDEX idx_bad ON users (nope)');
} catch {
  threw = true;
}
if (!threw) throw new Error('expected CREATE INDEX on a missing column to fail');

// 11. Joins still work with an index present (index only applies to single-table reads).
db.execSql('CREATE TABLE cities (cid INTEGER PRIMARY KEY, name TEXT, country TEXT)');
db.execSql("INSERT INTO cities (name, country) VALUES ('Lagos', 'NG')");
r = db.execSql("SELECT u.name FROM users u JOIN cities c ON u.city = c.name WHERE c.country = 'NG' ORDER BY u.id LIMIT 2");
if (r.rows.length !== 2) throw new Error(`join with index present: ${JSON.stringify(r.rows)}`);
console.log('join unaffected by index ok');

// 12. Non-INTEGER key columns are rejected up front (B-tree keys are u32).
threw = false;
try {
  db.execSql('CREATE TABLE bad (code TEXT PRIMARY KEY, v INTEGER)');
} catch {
  threw = true;
}
if (!threw) throw new Error('expected a TEXT PRIMARY KEY to be rejected');

db.fm.close();
console.log('indexes smoke OK');
