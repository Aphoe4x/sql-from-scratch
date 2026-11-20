# sql-from-scratch

A SQL database written from scratch — no dependencies, no external services, running on plain Node.js.

## Test it in 5 minutes

```
git clone https://github.com/Aphoe4x/sql-from-scratch
cd sql-from-scratch
npm i            # no dependencies, Node.js 24+ required
npm test         # all 22 smoke suites pass (engine, DML, aggregates, joins, ...)
npm run demo     # seeds 1000 users, runs 3 SELECTs with planner output
npm run cli      # interactive shell — try `SELECT amount * 2 FROM users LIMIT 3;`
```

Everything runs offline. To poke at the engine yourself: `node src/smoke_vacuum.mjs`, or type SQL in `npm run cli` (`.schema`, `.tables`, `VACUUM`, `ALTER TABLE ... RENAME`, ...).

## Quick start

```
npm run cli               # interactive SQL shell (creates ./cli.db)
npm run demo              # seed 1000 users + 3 SELECT queries with planner output
npm run crashtest         # SIGKILL mid-transaction: recovery verification
npm run crashtest2        # SIGKILL *inside commit*: WAL redo verification
npm run test              # smoke tests (file manager, B-tree, SQL engine, ...)
node src/smoke_fs.mjs     # FileManager unit smoke
node src/smoke_btree.mjs  # B-tree unit smoke (7000 entries)
node src/smoke_engine.mjs # SQL engine end-to-end (create/insert/query/reopen)
node src/smoke_dml.mjs    # UPDATE + DELETE smoke (merge-based rebalance, delete stress)
node src/smoke_aggregates.mjs # aggregates / GROUP BY / HAVING / BETWEEN / <> / DISTINCT
node src/smoke_joins.mjs  # INNER / LEFT / comma joins, qualified names, joins + GROUP BY
node src/smoke_indexes.mjs # CREATE INDEX, index maintenance on DML, reopen, LIMIT/OFFSET
node src/smoke_cli.mjs    # interactive shell in piped mode
node src/smoke_freelist.mjs # page reuse after deletes + checksum corruption detection
node src/smoke_constraints.mjs # NOT NULL / DEFAULT / UNIQUE indexes
node src/smoke_union.mjs  # UNION / UNION ALL, IN (SELECT ...), subqueries in DML
node src/smoke_ddl.mjs    # multi-row INSERT, DROP TABLE / INDEX, page reuse, statement rollback
node src/smoke_alter.mjs  # ALTER TABLE ADD COLUMN: row rewrite, index survival, defaults
node src/smoke_join_index.mjs # index-nested-loop joins (key + TEXT secondary index), LEFT JOIN
node src/smoke_like.mjs   # LIKE / NOT LIKE (% and _), case sensitivity, DML predicates
node src/smoke_insert_select.mjs # INSERT ... SELECT (incl. UNION), IF [NOT] EXISTS, standalone OFFSET
node src/smoke_rename.mjs # ALTER TABLE RENAME TO / RENAME COLUMN / DROP COLUMN, index cleanup
node src/smoke_where_or.mjs # OR logic, parentheses, precedence, OR in HAVING/DML
node src/smoke_ctas.mjs # CREATE TABLE name AS SELECT (type inference, keys, IF NOT EXISTS)
node src/smoke_truncate.mjs # TRUNCATE TABLE: page-freeing reset, index cleared, reopen
node src/smoke_select_expr.mjs # SELECT expressions: arithmetic (+ - * / ||), aliases, validation
node src/smoke_vacuum.mjs # VACUUM: freelist emptied, rows + UNIQUE index survive
```

## Try it in a shell

```text
$ npm run cli -- demo.db --plan
sql> CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
OK
sql> INSERT INTO users (name) VALUES ('ada');
inserted key 1
sql> SELECT * FROM users;
+----+------+
| id | name |
+----+------+
| 1  | ada  |
+----+------+
1 row
sql> .schema
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);  -- 1 rows
sql> .exit
```

Piped input works too: `echo "SELECT COUNT(*) FROM users;" | node src/cli.mjs demo.db`.

## What it is

| File | What |
|---|---|
| `src/fs.mjs` | **FileManager** — the disk: real OS file of 4096-byte pages. Meta page 0, page checksums, freelist, write-ahead log (`<db>.wal`). |
| `src/btree.mjs` | Classic bottom-up **B-tree** over the pages: `find` / `insert` / `update` / `delete` / `scan` / `pages` / `stats`. |
| `src/engine.mjs` | **SQL facade**: `Database.create/open/execSql/query/insert/commit/rollback`. |
| `src/lexer.mjs` / `src/parser.mjs` | SQL lexer + parser for the subset below. |
| `src/planner.mjs` | Static planner with real cost estimates (pages, rows, comparisons); knows full-scan, index-seek, nested-loop-join, index-nested-loop-join and union. |
| DML | `INSERT ... VALUES (...), (...)` (single statement), `INSERT INTO t (cols) SELECT ...`, `UPDATE t SET col = v [WHERE c = v]` · `DELETE FROM t [WHERE c = v]` |
| DDL | `CREATE TABLE [IF NOT EXISTS] [col defs | AS SELECT]`, `CREATE [UNIQUE] INDEX [IF NOT EXISTS]`, `ALTER TABLE ... ADD COLUMN / RENAME TO / RENAME COLUMN / DROP COLUMN`, `DROP TABLE [IF EXISTS]`, `DROP INDEX [IF EXISTS] name [ON table]`, `TRUNCATE TABLE name`, `VACUUM` |
| Joins | `INNER` / `LEFT` / comma cross joins, aliases, qualified columns, joins + GROUP BY; the inner side is probed through its key/secondary index when the `ON` equality allows it |
| Aggregates | `COUNT(*)`, `COUNT(col)`, `SUM`, `AVG`, `MIN`, `MAX`, `GROUP BY`, `HAVING`; every function also accepts `DISTINCT` (e.g. `COUNT(DISTINCT city)`) and an expression argument (e.g. `SUM(amount * 2)`) |
| Expressions | `+ - * /` and `\|\|` (concatenation) in SELECT items, e.g. `SELECT amount * 2 AS double FROM sales`; aliases are usable in `ORDER BY` |
| Indexes | `CREATE INDEX name ON t (column)` / `CREATE UNIQUE INDEX` — hash-keyed secondary B-trees, maintained on INSERT/UPDATE/DELETE, persisted in the meta page |
| Constraints | `NOT NULL`, `DEFAULT literal` per column; `CREATE UNIQUE INDEX` rejects duplicate values on build and on every write |
| Set operations | `UNION` / `UNION ALL` across branches, one trailing `ORDER BY` + `LIMIT` for the combined result |
| Filters | `= != <> < <= > >=`, `BETWEEN`, `LIKE` / `NOT LIKE` (`%`, `_`), `IN` / `NOT IN` (literal list or single-column subquery), `AND` / `OR` with parentheses (`AND` binds tighter) |
| Subqueries | `col IN (SELECT ...)` / `NOT IN (SELECT ...)` in SELECT, UPDATE and DELETE (single column, non-correlated) |
| `src/main.mjs` | Demo: seed + selects. |
| `src/cli.mjs` | Interactive SQL shell (`.tables`, `.schema`, `.plan`, `.exit`). |
| `src/crashtest.mjs` + `src/crashtest_child.mjs` | Crash-recovery test (see below). |
| `src/crashtest2.mjs` + `src/crashcommit_child.mjs` | Crash-**inside-commit** test (WAL redo + partial page apply). |

## SQL subset

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  city TEXT DEFAULT 'Lagos',
  score INTEGER DEFAULT 0
)
INSERT INTO users (name) VALUES ('user-1')     -- or: INSERT INTO users VALUES (1, 'user-1')
INSERT INTO users (name) VALUES ('a'), ('b'), ('c')   -- multi-row, one statement
INSERT INTO accounts (email) VALUES ('a@b.c')  -- city='Lagos', score=0
INSERT INTO archive (name, city) SELECT name, city FROM users WHERE city = 'Kano'
INSERT INTO archive (name, city) SELECT name, city FROM users UNION ALL SELECT name, city FROM old_users
SELECT * FROM users
SELECT id, name FROM users WHERE id = 55
SELECT name FROM users WHERE name = 'user-55'
SELECT * FROM users ORDER BY id DESC

-- DML:
UPDATE users SET name = 'renamed-5' WHERE id = 5
UPDATE users SET name = 'all-same'            -- no WHERE = every row
DELETE FROM users WHERE id = 7
DELETE FROM users                             -- truncate the table

-- Aggregates, GROUP BY, HAVING (on a table with `city`, `amount`):
SELECT COUNT(*) FROM sales
SELECT SUM(amount), AVG(amount), MIN(amount), MAX(amount) FROM sales
SELECT id FROM sales WHERE amount >= 50 AND amount < 100      -- AND chains
SELECT id FROM sales WHERE amount BETWEEN 50 AND 150
SELECT id FROM sales WHERE city <> 'Lagos'
SELECT id FROM sales WHERE city = 'Lagos' OR city = 'Kano'    -- OR
SELECT id FROM sales WHERE (city = 'Lagos' OR city = 'Kano') AND amount > 100
SELECT id FROM sales WHERE city = 'Lagos' AND amount < 50 OR status = 'paid'  -- AND binds tighter
SELECT name FROM users WHERE name LIKE 'ada%'                 -- % = any run, _ = one char
SELECT name FROM users WHERE name NOT LIKE '%bot'
SELECT city, COUNT(*) AS n, SUM(amount) AS total FROM sales GROUP BY city ORDER BY city
SELECT city, COUNT(*) AS n FROM sales GROUP BY city HAVING n > 4
SELECT COUNT(DISTINCT city) FROM sales                    -- duplicates removed before counting
SELECT COUNT(*) AS n, SUM(DISTINCT amount) FROM sales     -- DISTINCT works on every aggregate
SELECT amount * 2 AS double, name || '!' AS shout FROM sales
SELECT SUM(amount * 2) AS doubled FROM sales GROUP BY city

-- Joins (customers c, orders o):
SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id
SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON c.id = o.customer_id
SELECT c.name, o.id FROM customers c, orders o WHERE c.id = o.customer_id   -- comma = cross join
SELECT c.name, COUNT(*) AS n FROM customers c JOIN orders o ON c.id = o.customer_id GROUP BY c.name
SELECT c.* FROM customers c WHERE c.id = 1        -- qualified star
SELECT c.name, o.amount FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY o.id DESC, c.name

-- Indexes + paging:
CREATE INDEX idx_users_name ON users (name)
CREATE INDEX IF NOT EXISTS idx_users_name ON users (name)    -- no-op if it exists
CREATE UNIQUE INDEX uq_accounts_email ON accounts (email)
ALTER TABLE accounts ADD COLUMN country TEXT DEFAULT 'NG'   -- rewrites existing rows
ALTER TABLE accounts RENAME COLUMN city TO town             -- metadata only (indexes follow)
ALTER TABLE accounts RENAME TO customers                    -- directory entry only
ALTER TABLE accounts DROP COLUMN score                      -- rewrites rows, frees its indexes
DROP INDEX IF EXISTS idx_users_name ON users
DROP TABLE IF EXISTS accounts
CREATE TABLE IF NOT EXISTS staging (id INTEGER PRIMARY KEY, src TEXT)
CREATE TABLE lagos AS SELECT id, name, city FROM users WHERE city = 'Lagos'
TRUNCATE TABLE lagos                                   -- page-freeing reset; row ids continue
VACUUM                                                -- rebuild all trees, clear the freelist
SELECT id FROM users WHERE name = 'user-5'      -- planner: secondary-index-seek
SELECT id FROM users ORDER BY id ASC LIMIT 5 OFFSET 10
SELECT id FROM users ORDER BY id OFFSET 990      -- OFFSET without LIMIT
SELECT city, COUNT(*) AS n FROM users GROUP BY city ORDER BY n DESC LIMIT 2
SELECT DISTINCT city FROM users ORDER BY city       -- duplicate rows removed before ORDER BY/LIMIT

-- Set operations and subqueries:
SELECT city FROM users UNION SELECT city FROM accounts          -- deduped
SELECT city FROM users UNION ALL SELECT city FROM accounts      -- keeps duplicates
SELECT name FROM users UNION SELECT name FROM accounts ORDER BY name DESC LIMIT 10
SELECT name FROM users WHERE city IN ('Lagos', 'Kano')
SELECT name FROM users WHERE id IN (SELECT id FROM accounts)    -- single-column subquery
SELECT name FROM users WHERE id NOT IN (SELECT id FROM banned)
DELETE FROM users WHERE id IN (SELECT id FROM banned)           -- subquery in DML
```

Rows are stored in the B-tree leaves; the key column (PRIMARY KEY) is the tree key, other columns are typed-encoded values (int = 8-byte double, text = len + bytes).

## Storage layout

- **Page 0** — meta page (format v4): magic, version, pageCount, lastCommitLSN, table directory (name, columns with type/NOT NULL/DEFAULT, rootPage, nextId, secondary indexes with a UNIQUE flag), freelist (reusable page numbers), trailing CRC-32.
- **Pages 1..** — B-tree pages (every page ends with a CRC-32 of the rest of the page):
  - internal: `[type u32][n seps][n+1 children]` (`seps.length + 1 == children.length`)
  - leaf: `[type u32][count u32][key u32, valueLen u16, value][...]`
  - Invariant: `children[i]` holds keys in `(seps[i-1], seps[i]]`, `children[0] = keys ≤ seps[0]`, `children[n] = keys > seps[n-1]`.
- **WAL** — `[crc u32][len u32][type u8][lsn u32][payload]`; type 1 = PAGE (`[pageNum u32][page bytes]`), type 2 = COMMIT. Torn tail tolerated.

## Transactions

- `db.execSql("INSERT ...")` — auto-commit.
- A statement that throws is rolled back before the next commit, so a multi-row `INSERT` that fails on its third tuple leaves no rows and no index entries behind. The same applies to `INSERT ... SELECT`: a key collision halfway through the selected rows undoes the whole statement.
- An explicit duplicate primary key is an error (`insert: duplicate primary key 42`) rather than an overwrite.
- `db.begin(); db.insert(...); db.commit()` — commits a group of statements atomically.
- `db.rollback()` — discards staged pages; the engine resets each tree to its last committed root (in-memory tree must match the file).

Commit protocol (write-ahead, in this order):

1. Stage every dirty page **plus the meta page 0** as WAL PAGE records, append a COMMIT record, `fsync` the WAL.
2. Apply the pages to the database file, `fsync` it.
3. Checkpoint: truncate the WAL (the file is durable).

A crash before step 1 discards everything; a crash after it replays the committed pages on open. Because the table directory, `pageCount` and the freelist live in page 0, they are crash-atomic with the data pages.

## Crash recovery (`Database.open`)

1. Replays the WAL from offset 0: PAGE records go to `pending`, on COMMIT the pending pages are written to the file.
2. The uncommitted tail (no COMMIT after it) is discarded.
3. Truncates the WAL to zero.

`node src/crashtest.mjs`: the child seeds 100 committed rows + a committed index, opens an uncommitted tx with 50 more, the parent SIGKILLs it mid-transaction. After recovery: exactly the 100 committed rows, 0 uncommitted leakage, the secondary index still answers `WHERE name = …` (and has no entries for the uncommitted rows), and the engine is usable (a post-recovery insert lands and is indexed).

`node src/crashtest2.mjs`: kills the child **inside commit**, once with the WAL durable and zero pages applied, once after one page of a partial apply. Both recover to 21 rows including the row whose commit was interrupted — the page file never held it.

## Page integrity and reuse

- **Checksums:** every page ends with a CRC-32 (computed with the checksum field zeroed). Reads verify it, so a torn or bit-flipped page raises `corrupt page N … checksum mismatch` instead of returning garbage. The meta page is verified on open.
- **Freelist:** when a B-tree merge or root collapse drops a page, it goes on a freelist stored in the meta page; `allocatePage()` reuses it. `DROP TABLE` / `DROP INDEX` walk the tree and return every page they own to the freelist too. In the test, deleting 1990 of 2000 rows frees 39 pages, and a 1000-row table dropped and rebuilt reuses its 20 pages instead of growing the file.

## Limitations (intended scope)

- Single connection (no locking).
- The row key (`PRIMARY KEY` or the first column) must be an `INTEGER`; B-tree keys are u32.
- Secondary indexes are **hash indexes**: they accelerate equality only (no range scans), and a hash collision just widens a bucket (lookups verify the real value).
- No correlated subqueries, RIGHT/FULL OUTER JOIN, window functions, or planner join reordering. `IN (SELECT ...)` runs once per statement (its result list is materialized), and the subquery must return exactly one column.
- `UNION` compares whole rows; its result takes the first branch's column names (later branches are matched positionally). A chain is evaluated left to right, so `A UNION ALL B UNION C` deduplicates only at the `UNION`.
- JOINs are nested-loop (no hash/merge join); when the inner side's `ON` column is the key or has a secondary index, the executor probes it per left row instead of scanning the whole inner table, and the planner reports `index-nested-loop-join` with a comparison estimate (the test shows ~50 probes vs ~20,000 comparisons).
- `DISTINCT` inside an aggregate de-duplicates its input values before aggregating (`COUNT(DISTINCT city)`, `SUM(DISTINCT amount)`), keeping numbers and text apart; `COUNT(DISTINCT *)` is rejected.
- SELECT expressions (`amount * 2`, `name || '-' || city`) work as projection items, in aggregate arguments (`SUM(amount * 2)`) and as aggregate input. Arithmetic is left-associative over columns/literals (no parentheses or unary operators yet); `+ - * /` coerce to numbers (a non-numeric operand or a division by zero yields `null`), and `||` concatenates.
- Unqualified column names in a join resolve to the first table in FROM order; qualify (`o.id`) when both sides have the same column name.
- `INSERT ... SELECT` maps columns **positionally** (target list length must match the select list), accepts `UNION`/`UNION ALL` as the source, and reads the whole source before writing — so a self-copy (`INSERT INTO t SELECT ... FROM t`) works and doubles the table with fresh keys.
- `CREATE ... IF NOT EXISTS` on an existing object is a quiet no-op that keeps the original schema; `DROP ... IF EXISTS` on a missing object reports `null` instead of throwing.
- `AND` / `OR` / parentheses are supported in WHERE, HAVING and JOIN-adjacent filters; `AND` binds tighter, and a top-level `OR` falls back to a filtered full scan (an index is only used when the equality is ANDed).
- Comparison operands may be literals or columns; `BETWEEN` takes literals only.
- `LIKE` is case-sensitive, and there is no `ESCAPE` clause (patterns are matched literally except for `%` and `_`).
- Updating the primary-key column is rejected; the B-tree key is the row identity.
- `ALTER TABLE ... ADD COLUMN` only appends a column at the end (the row encoding is positional). `RENAME COLUMN` / `RENAME TO` are metadata-only; `DROP COLUMN` rewrites every row, refuses the primary-key column, and drops (and frees) any secondary index built on that column. The rewrite keeps row ids valid.
- `CREATE TABLE name AS SELECT ...` (optionally `IF NOT EXISTS`): column names come from the SELECT; the type is inferred from the values (`INTEGER` for numbers, else `TEXT`). When the first selected column is an integer it becomes the table's key; otherwise the table is created with a synthesized leading `id INTEGER PRIMARY KEY` so every table has one key column. Duplicate keys in the source become errors, like in any insert.
- `TRUNCATE TABLE t` — frees the table's B-tree and secondary-index pages (they reuse the freelist immediately) and rebuilds them empty. Row ids continue from `nextId`; the alternative of repeated DELETEs leaves the pages in place.
- Projecting an unknown column, or inserting/updating one, is an error (`select: no column 'city'`) rather than a silently undefined value.
- No CHECK constraints, foreign keys, or NULLs (use `''`/0; `NOT NULL` therefore guards omitted values).
- Values fit in `text`/`double` encodings; no dates/blobs/NULLs (use `''`/0).
- The freelist lives in the meta page, so it holds a few hundred entries; beyond that (a single huge purge) freed pages are simply not recorded until there is room.
- `VACUUM` rebuilds every table and secondary index in place and empties the freelist; there is no page-compaction/vacuum beyond this (e.g. nothing that rewrites the file to remove trailing unused space). The WAL is checkpointed (truncated) on every commit rather than kept for point-in-time recovery.
- The engine is a library + CLI demos; deployment isn't the point — the point is "shipped a working storage engine from scratch".
