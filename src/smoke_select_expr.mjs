// smoke_select_expr.mjs — SELECT expressions: `col op col`, `col op literal`,
// `literal op col`, `||` concatenation, aliases, ORDER BY on the alias, and
// validation of the columns they reference.
import fs from 'node:fs';
import { Database } from './engine.mjs';

const dbPath = 'smoke_select_expr.db';
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
db.execSql('CREATE TABLE sales (id INTEGER PRIMARY KEY, name TEXT, city TEXT, amount INTEGER, price INTEGER)');
db.execSql("INSERT INTO sales (name, city, amount, price) VALUES ('ada', 'Lagos', 10, 4), ('bola', 'Kano', 20, 5), ('chidi', 'Lagos', 30, 6), ('dayo', 'Abuja', 40, 7)");

// 1. Arithmetic with literals, no alias -> column named after the expression.
let r = db.execSql('SELECT id, amount * 2 FROM sales ORDER BY id');
eq(r.columns, ['id', 'amount * 2'], 'expression column name');
eq(r.rows.map((x) => x['amount * 2']), [20, 40, 60, 80], 'amount * 2');
r = db.execSql('SELECT id, 100 - amount FROM sales ORDER BY id');
eq(r.rows.map((x) => x['100 - amount']), [90, 80, 70, 60], 'literal - col');
r = db.execSql('SELECT id, price * 2 + 1 FROM sales ORDER BY id');
eq(r.rows.map((x) => x['price * 2 + 1']), [9, 11, 13, 15], 'left-associative chain');
console.log('select-expr: col/literal arithmetic ok');

// 2. Aliases, used by ORDER BY.
r = db.execSql('SELECT id, amount * 2 AS double FROM sales ORDER BY double DESC LIMIT 2');
eq(r.rows.map((x) => [x.id, x.double]), [[4, 80], [3, 60]], 'alias + ORDER BY alias');
console.log('select-expr: aliases feed ORDER BY');

// 3. Column op column and string concatenation.
r = db.execSql('SELECT id, amount + price FROM sales ORDER BY id');
eq(r.rows.map((x) => x['amount + price']), [14, 25, 36, 47], 'col + col');
r = db.execSql("SELECT id, name || '-' || city AS label FROM sales ORDER BY id");
eq(r.rows.map((x) => x.label), ['ada-Lagos', 'bola-Kano', 'chidi-Lagos', 'dayo-Abuja'], 'concat');
console.log('select-expr: col op col and || ok');

// 4. Expression names survive a join.
db.execSql('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT)');
db.execSql("INSERT INTO customers (id, name) VALUES (1, 'Ada'), (2, 'Bola'), (3, 'Chidi')");
db.execSql('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER)');
db.execSql('INSERT INTO orders (id, customer_id, amount) VALUES (1, 1, 50), (2, 1, 20), (3, 2, 30), (4, 3, 40)');
r = db.execSql('SELECT c.name, o.amount * 2 FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY c.id, o.id');
eq(r.rows.length, 4, 'join expression rows');
eq(r.columns, ['name', 'amount * 2'], 'join expression columns');
eq(r.rows[0]['amount * 2'], 100, 'join expression value');
console.log('select-expr: expressions over joined rows ok');

// 5. Errors: unknown column in an expression; division by zero yields null.
throws(() => db.execSql('SELECT amount * nope FROM sales'), /no column 'nope'/, 'unknown expr column');
r = db.execSql('SELECT id, 10 / 0 AS bad, 10 / 2 AS good FROM sales ORDER BY id');
eq(r.rows[0].bad, null, 'division by zero -> null');
eq(r.rows[0].good, 5, 'normal division');
eq(db.execSql('SELECT id, amount + 0.5 FROM sales ORDER BY id').rows[0]['amount + 0.5'], 10.5, 'fractional literal');
console.log('select-expr: bad columns rejected, div-by-zero -> null');

// 6. Expressions in GROUP BY-free queries and persistence.
r = db.execSql('SELECT city, SUM(amount * 2) AS total FROM sales GROUP BY city ORDER BY city');
eq(r.rows.map((x) => [x.city, x.total]), [['Abuja', 80], ['Kano', 40], ['Lagos', 80]], 'aggregate of expression');
console.log('select-expr: aggregates over expression literals ok');

db.fm.close();
db = Database.open(dbPath);
eq(db.execSql('SELECT amount * 2 AS double FROM sales ORDER BY id').rows.map((x) => x.double), [20, 40, 60, 80], 'reopen expressions');
db.fm.close();
for (const p of [dbPath, dbPath + '.wal']) fs.existsSync(p) && fs.unlinkSync(p);
console.log('SELECT expression smoke OK');
