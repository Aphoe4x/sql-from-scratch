# sql-from-scratch

A SQL database written from scratch — no dependencies, no external services, running on plain Node.js.

```
npm run demo              # seed 1000 users + 3 SELECT queries with planner output
npm run crashtest         # SIGKILL mid-transaction: recovery verification
npm run test              # smoke tests (file manager, B-tree, SQL engine)
node src/smoke_fs.mjs     # FileManager unit smoke
node src/smoke_btree.mjs  # B-tree unit smoke (7000 entries)
node src/smoke_engine.mjs # SQL engine end-to-end (create/insert/query/reopen)
node src/smoke_dml.mjs    # UPDATE + DELETE smoke (merge-based rebalance, delete stress)
node src/smoke_aggregates.mjs # aggregates / GROUP BY / HAVING / BETWEEN / <> / AND-chains smoke
```

## What it is

| File | What |
|---|---|
| `src/fs.mjs` | **FileManager** — the disk: real OS file of 4096-byte pages. Meta page 0, write-ahead log (`<db>.wal`). |
| `src/btree.mjs` | Classic bottom-up **B-tree** over the pages: `find` / `insert` / `scan` / `stats`. |
| `src/engine.mjs` | **SQL facade**: `Database.create/open/execSql/query/insert/commit/rollback`. |
| `src/lexer.mjs` / `src/parser.mjs` | SQL lexer + parser for the subset below. |
| `src/planner.mjs` | Static planner with real cost estimates (pages touched). |
| DML | `UPDATE t SET col = v [WHERE c = v]` · `DELETE FROM t [WHERE c = v]` |
| `src/main.mjs` | Demo: seed + selects. |
| `src/crashtest.mjs` + `src/crashtest_child.mjs` | Crash-recovery test (see below). |

## SQL subset

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
INSERT INTO users (name) VALUES ('user-1')     -- or: INSERT INTO users VALUES (1, 'user-1')
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
SELECT city, COUNT(*) AS n, SUM(amount) AS total FROM sales GROUP BY city ORDER BY city
SELECT city, COUNT(*) AS n FROM sales GROUP BY city HAVING n > 4
```

Rows are stored in the B-tree leaves; the key column (PRIMARY KEY) is the tree key, other columns are typed-encoded values (int = 8-byte double, text = len + bytes).

## Storage layout

- **Page 0** — meta page: magic, version, pageCount, lastCommitLSN, table directory (name, columns, rootPage, nextId).
- **Pages 1..** — B-tree pages:
  - internal: `[type u32][n seps][n+1 children]` (`seps.length + 1 == children.length`)
  - leaf: `[type u32][count u32][key u32, valueLen u16, value][...]`
  - Invariant: `children[i]` holds keys in `(seps[i-1], seps[i]]`, `children[0] = keys ≤ seps[0]`, `children[n] = keys > seps[n-1]`.
- **WAL** — `[crc u32][len u32][type u8][lsn u32][payload]`; type 1 = PAGE (`[pageNum u32][page bytes]`), type 2 = COMMIT. Torn tail tolerated.

## Transactions

- `db.execSql("INSERT ...")` — auto-commit.
- `db.begin(); db.insert(...); db.commit()` — `commit()` flushes dirty pages to the file, appends a COMMIT record and fsyncs.
- `db.rollback()` — discards staged pages; the engine resets each tree to its last committed root (in-memory tree must match the file).

## Crash recovery (`Database.open`)

1. Replays the WAL from offset 0: PAGE records go to `pending`, on COMMIT the pending pages are written to the file.
2. The uncommitted tail (no COMMIT after it) is discarded.
3. Truncates the WAL to zero.

`node src/crashtest.mjs`: the child seeds 100 committed rows, opens an uncommitted tx with 50 more, the parent SIGKILLs it mid-transaction. After recovery: exactly the 100 committed rows, 0 uncommitted leakage, and the engine is usable (a post-recovery insert lands).

## Limitations (intended scope)

- Single connection (no locking).
- No updates/deletes, no GROUP BY/JOINs/aggregates yet.
- Values fit in `text`/`double` encodings; no dates/blobs/NULLs (use `''`/0).
- The engine is a library + CLI demos; deployment isn't the point — the point is "shipped a working storage engine from scratch".
