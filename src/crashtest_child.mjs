// src/crashtest_child.mjs — opens the DB, commits 100 rows, opens an
// UNCOMMITTED transaction, writes a marker, then waits for the parent to SIGKILL it.

import fs from 'node:fs';
import { Database } from './engine.mjs';

const [, , dbPath, markerPath] = process.argv;
const db = Database.open(dbPath);

db.execSql("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
// Committed transaction: 100 rows, plus a secondary index over them.
for (let i = 1; i <= 100; i++) {
  db.execSql(`INSERT INTO users (name) VALUES ('seed-${i}')`);
}
db.execSql('CREATE INDEX idx_users_name ON users (name)');

// Uncommitted transaction: 50 rows. Marker signals the parent, then we stall.
db.begin();
for (let i = 1; i <= 50; i++) {
  db.insert('users', { name: `uncommitted-${i}` });
}
fs.writeFileSync(markerPath, 'tx2_open');
const interval = setInterval(() => fs.writeFileSync(markerPath, `tx2_open ${Date.now()}`), 50);
setTimeout(() => {
  // The parent is expected to SIGKILL us long before this fires.
  db.commit();
  clearInterval(interval);
  console.log('child: committed (parent killed too late for this test)');
}, 120000);
