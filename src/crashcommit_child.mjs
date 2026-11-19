// src/crashcommit_child.mjs — commits one row, then is killed by the parent's
// fault-injection env var either before any page is applied to the DB file
// (mode=wal) or after N pages (mode=<n>).
//
// Usage: node crashcommit_child.mjs <dbPath> wal|<n>
import fs from 'node:fs';
import { Database } from './engine.mjs';

const [, , dbPath, mode] = process.argv;
const db = fs.existsSync(dbPath) ? Database.open(dbPath) : Database.create(dbPath);

db.execSql('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
for (let i = 1; i <= 20; i++) db.execSql(`INSERT INTO users (name) VALUES ('pre-${i}')`);

// From here on, the next commit dies mid-flight.
if (mode === 'wal') process.env.SQDB_CRASH_AFTER_WAL = '1';
else process.env.SQDB_CRASH_AFTER_PAGES = mode;

db.execSql("INSERT INTO users (name) VALUES ('durable-after-recovery')");
console.log('child: commit survived (fault injection did not fire)');
