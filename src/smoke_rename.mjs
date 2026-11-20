// smoke_rename.mjs — ALTER TABLE RENAME TO / RENAME COLUMN / DROP COLUMN.
// Rows are positionally encoded, so renames touch metadata only while a
// dropped column rewrites every row and frees the indexes built on it.
import fs from 'node:fs';
import { Database } from './engine.mjs';
import { planQuery } from './planner.mjs';

const dbPath = 'smoke_rename.db';
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

let db = Database.create(dbPath);
db.execSql('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, city TEXT, score INTEGER)');
const cities = ['Lagos', 'Kano', 'Abuja'];
for (let i = 1; i <= 50; i++) {
  db.execSql(`INSERT INTO people (name, city, score) VALUES ('p${i}', '${cities[(i - 1) % 3]}', ${i * 2})`);
}
db.execSql('CREATE INDEX ix_people_city ON people (city)');
db.execSql('CREATE UNIQUE INDEX uq_people_name ON people (name)');

// 1. RENAME COLUMN: queries, indexes and the planner follow the new name.
let res = db.execSql('ALTER TABLE people RENAME COLUMN city TO town');
if (res.renamed !== true || res.from !== 'city' || res.to !== 'town') throw new Error(`rename column result: ${JSON.stringify(res)}`);
if (JSON.stringify(db.tables.get('people').columns.map((c) => c.name)) !== JSON.stringify(['id', 'name', 'town', 'score'])) throw new Error('schema not renamed');
eq(db.execSql("SELECT COUNT(*) AS n FROM people WHERE town = 'Lagos'").rows[0].n, 17, 'renamed column filter');
const plan = planQuery(db, "SELECT id FROM people WHERE town = 'Lagos'");
if (plan.strategy !== 'secondary-index-seek' || plan.index !== 'ix_people_city') throw new Error(`renamed index: ${JSON.stringify(plan)}`);
throws(() => db.execSql('SELECT city FROM people'), /no column|unknown|city/i, 'old column name');
throws(() => db.execSql("INSERT INTO people (name, city) VALUES ('zz', 'Kano')"), /no column|unknown|city/i, 'insert into old column name');
console.log('rename column: queries, index seek and rejection of the old name ok');

// The index on the renamed column still indexes the values (not a stale definition).
eq(db.execSql("SELECT id FROM people WHERE town = 'Kano' ORDER BY id LIMIT 3").rows.map((r) => r.id), [2, 5, 8], 'renamed column values');
console.log('rename column: index still answers with the renamed column');

// 2. RENAME COLUMN on the primary key: row identity follows the new name.
res = db.execSql('ALTER TABLE people RENAME COLUMN id TO person_id');
if (res.to !== 'person_id') throw new Error('pk rename failed');
eq(db.execSql('SELECT person_id, name FROM people WHERE person_id = 7').rows.map((r) => [r.person_id, r.name]), [[7, 'p7']], 'pk lookup');
res = db.execSql("INSERT INTO people (name, town, score) VALUES ('p51', 'Lagos', 102)");
if (res.key !== 51) throw new Error(`pk rename broke auto keys: ${res.key}`);
throws(() => db.execSql("INSERT INTO people (person_id, name, town, score) VALUES (51, 'dup', 'Lagos', 1)"), /duplicate primary key/, 'duplicate after pk rename');
console.log('rename column: primary key renamed, auto ids and duplicate detection still work');

// 3. RENAME TO: the map key and the on-disk directory entry change.
res = db.execSql('ALTER TABLE people RENAME TO folks');
if (res.renamed !== true || res.table !== 'folks') throw new Error(`rename table: ${JSON.stringify(res)}`);
if (db.tables.has('people')) throw new Error('old table name still mapped');
throws(() => db.execSql('SELECT * FROM people'), /no such table/, 'old table name');
eq(db.execSql('SELECT COUNT(*) AS n FROM folks').rows[0].n, 51, 'renamed table row count');
res = db.execSql('ALTER TABLE folks RENAME TO folks');
if (res.renamed !== false) throw new Error('self-rename should be a no-op');
db.execSql('CREATE TABLE other (id INTEGER PRIMARY KEY)');
throws(() => db.execSql('ALTER TABLE folks RENAME TO other'), /already exists/, 'rename onto an existing table');
console.log('rename table: directory entry moved, old name rejected');

// 4. DROP COLUMN: rows rewritten, values of the kept columns preserved.
const before = db.execSql('SELECT person_id, name, town FROM folks ORDER BY person_id').rows;
res = db.execSql('ALTER TABLE folks DROP COLUMN score');
if (res.droppedColumn !== 'score' || res.rows !== 51) throw new Error(`drop column: ${JSON.stringify(res)}`);
eq(db.execSql('SELECT person_id, name, town FROM folks ORDER BY person_id').rows, before, 'rows after drop');
if (db.tables.get('folks').columns.some((c) => c.name === 'score')) throw new Error('dropped column still in schema');
throws(() => db.execSql('SELECT score FROM folks'), /no column|unknown|score/i, 'dropped column select');
console.log('drop column: 51 rows rewritten, kept values identical');

// 5. DROP COLUMN of an indexed column drops the index and frees pages.
const pagesBefore = db.fm.pageCount;
const freeBefore = db.fm.freeList.length;
res = db.execSql('ALTER TABLE folks DROP COLUMN town');
if (JSON.stringify(res.indexesDropped) !== JSON.stringify(['ix_people_city'])) throw new Error(`index not dropped: ${JSON.stringify(res)}`);
if (db.fm.freeList.length !== freeBefore + res.pages || res.pages < 1) throw new Error(`pages not freed: ${JSON.stringify(res)}`);
if (db.fm.pageCount !== pagesBefore) throw new Error('file grew while dropping a column');
if (db.tables.get('folks').indexes.some((ix) => ix.column === 'town')) throw new Error('dropped index still listed');
eq(db.execSql('SELECT COUNT(*) AS n FROM folks').rows[0].n, 51, 'rows after indexed drop');
console.log(`drop column: index freed ${res.pages} page(s), ${res.rows} rows kept`);

// 6. Reopen: schema, rows, renamed objects and the surviving UNIQUE index persist.
db.fm.close();
db = Database.open(dbPath);
eq(db.tables.get('folks').columns.map((c) => c.name), ['person_id', 'name'], 'columns after reopen');
eq(db.execSql('SELECT person_id, name FROM folks WHERE person_id = 3').rows.map((r) => [r.person_id, r.name]), [[3, 'p3']], 'row after reopen');
db.execSql("INSERT INTO folks (name) VALUES ('p52')");
throws(() => db.execSql("INSERT INTO folks (name) VALUES ('p3')"), /unique index/, 'unique index after reopen');
console.log('reopen: renamed table/columns, dropped column and UNIQUE index all persisted');

// 7. Error cases leave the schema untouched.
throws(() => db.execSql('ALTER TABLE folks RENAME COLUMN nope TO x'), /no column/, 'rename missing column');
throws(() => db.execSql("ALTER TABLE folks RENAME COLUMN name TO person_id"), /already exists/, 'rename onto an existing column');
throws(() => db.execSql('ALTER TABLE folks DROP COLUMN person_id'), /primary key/, 'drop the primary key');
throws(() => db.execSql('ALTER TABLE folks DROP COLUMN nope'), /no column/, 'drop missing column');
throws(() => db.execSql('ALTER TABLE nope RENAME TO x'), /no such table/, 'rename missing table');
eq(db.tables.get('folks').columns.map((c) => c.name), ['person_id', 'name'], 'schema unchanged after errors');
eq(db.execSql('SELECT COUNT(*) AS n FROM folks').rows[0].n, 52, 'rows unchanged after errors');
db.execSql('CREATE TABLE solo (id INTEGER PRIMARY KEY, v TEXT)');
db.execSql("INSERT INTO solo (v) VALUES ('x')");
res = db.execSql('ALTER TABLE solo DROP COLUMN v');
if (res.droppedColumn !== 'v') throw new Error(`drop last data column: ${JSON.stringify(res)}`);
eq(db.execSql('SELECT id FROM solo').rows.map((r) => r.id), [1], 'key-only table keeps its row');
db.execSql('INSERT INTO solo VALUES (2)');
eq(db.execSql('SELECT id FROM solo ORDER BY id').rows.map((r) => r.id), [1, 2], 'key-only table accepts inserts');
throws(() => db.execSql('ALTER TABLE solo DROP COLUMN id'), /primary key/, 'drop the only remaining (key) column');

db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('ALTER TABLE rename/drop smoke OK');
