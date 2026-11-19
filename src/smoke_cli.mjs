// smoke_cli.mjs — the interactive shell in piped mode: statements, dot-commands,
// plan output, error reporting, and persistence across two invocations.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const dbFile = 'smoke_cli.db';
for (const p of [dbFile, dbFile + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);

const runCli = (lines, extra = []) => {
  const res = spawnSync(process.execPath, ['src/cli.mjs', dbFile, ...extra], { input: `${lines.join('\n')}\n`, encoding: 'utf8' });
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
};

// 1. Create, insert, select, dot-commands, plan output.
let out = runCli([
  'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, city TEXT);',
  "INSERT INTO t (name, city) VALUES ('a', 'Lagos');",
  "INSERT INTO t (name, city) VALUES ('b', 'Lagos');",
  "INSERT INTO t (name, city) VALUES ('c', 'Kano');",
  '.tables',
  '.schema',
  'SELECT DISTINCT city FROM t ORDER BY city;',
  'SELECT city, COUNT(*) AS n FROM t GROUP BY city ORDER BY n DESC;',
], ['--plan']);
if (!out.includes('inserted key 3')) throw new Error(`insert output missing:\n${out}`);
if (!out.includes('t\n') && !out.includes('t\r\n')) throw new Error(`.tables output missing:\n${out}`);
if (!out.includes('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, city TEXT);')) throw new Error(`.schema output wrong:\n${out}`);
if (!out.includes('| Lagos |')) throw new Error(`DISTINCT output missing:\n${out}`);
if (!out.includes('[plan]')) throw new Error(`plan output missing:\n${out}`);
if (out.includes('error:')) throw new Error(`unexpected error:\n${out}`);
console.log('cli happy path ok');

// 2. Second invocation sees the persisted data (open, not create).
out = runCli(["SELECT COUNT(*) AS n FROM t WHERE city = 'Lagos';"]);
if (!out.includes('| 2') && !out.includes('| 2 |')) throw new Error(`persistence/count wrong:\n${out}`);
console.log('cli persistence ok');

// 3. Errors are reported without exiting the shell.
out = runCli(['SELECT * FROM missing;', 'SELECT 1;']);
if (!out.includes('error: select: no such table')) throw new Error(`expected a table error:\n${out}`);
console.log('cli error handling ok');

// 4. DML and dot-command toggles.
out = runCli([
  "UPDATE t SET city = 'Abuja' WHERE name = 'a';",
  "DELETE FROM t WHERE name = 'c';",
  "SELECT COUNT(*) AS n FROM t WHERE city = 'Abuja';",
  '.exit',
]);
if (!out.includes('1 row(s) updated')) throw new Error(`update output:\n${out}`);
if (!out.includes('1 row(s) deleted')) throw new Error(`delete output:\n${out}`);
if (!out.includes('| 1 |')) throw new Error(`post-DML count:\n${out}`);
console.log('cli DML ok');

fs.existsSync(dbFile) && fs.unlinkSync(dbFile);
fs.existsSync(dbFile + '.wal') && fs.unlinkSync(dbFile + '.wal');
console.log('cli smoke OK');
