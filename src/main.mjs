// src/main.mjs — demo: seed a users table, run SELECTs, show planner estimates.

import { Database } from './engine.mjs';
import { planQuery } from './planner.mjs';

const dbPath = process.argv[2] ?? 'demo.db';
const db = Database.create(dbPath);

db.execSql("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
const N = 1000;
for (let i = 1; i <= N; i++) {
  db.execSql(`INSERT INTO users (name) VALUES ('user-${i}')`);
}
console.log(`Seeded ${N} users into ${dbPath}`);
console.log('users stats:', db.tables.get('users').bt.stats());

const show = (sql) => {
  const res = db.execSql(sql);
  const plan = res.plan ?? planQuery(db, sql);
  console.log(`\nSQL: ${sql}`);
  console.log(`  plan: ${plan.strategy} — est. ${plan.pages} page(s), est. ${plan.rowsEstimate} row(s)`);
  console.log(`  result: ${res.rows.length} row(s), first: ${JSON.stringify(res.rows[0] ?? null)}`);
};

show("SELECT * FROM users");
show("SELECT id, name FROM users WHERE id = 500");
show("SELECT name FROM users ORDER BY id DESC");
