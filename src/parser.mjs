// src/parser.mjs — SQL parser producing an AST for the subset in lexer.mjs.

import { tokenize } from './lexer.mjs';

const isWord = (t, word) => !!t && t.kind === 'word' && t.value.toUpperCase() === word;
const isPunct = (t, value) => !!t && t.kind === 'punct' && t.value === value;
const isKeyword = (t, word) => isWord(t, word);

export function parse(sql) {
  const tokens = tokenize(sql);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const expect = (word, punct) => {
    const t = next();
    const ok = word ? isWord(t, word) : punct ? isPunct(t, punct) : false;
    if (!ok) throw new Error(`parse: expected ${word ?? punct}, got ${t?.value ?? 'EOF'}`);
    return t;
  };
  const literal = () => {
    const t = next();
    if (!t || t.kind === 'eof') throw new Error('parse: expected value literal');
    if (t.kind === 'num') return Number(t.value);
    if (t.kind === 'str') return t.value;
    throw new Error(`parse: expected literal, got ${t.kind}`);
  };
  const ident = () => {
    const t = next();
    if (!t || t.kind !== 'word' || t.kind === 'eof') throw new Error(`parse: expected identifier`);
    return t.value;
  };

  // Column definition shared by CREATE TABLE and ALTER TABLE ADD COLUMN.
  const parseColumnDef = () => {
    const name = ident();
    const type = ident();
    let isKey = false;
    let notNull = false;
    let defaultValue;
    // Column constraints, in any order.
    for (;;) {
      if (isKeyword(peek(), 'PRIMARY')) {
        expect('PRIMARY');
        expect('KEY');
        isKey = true;
      } else if (isKeyword(peek(), 'NOT')) {
        expect('NOT');
        expect('NULL');
        notNull = true;
      } else if (isKeyword(peek(), 'DEFAULT')) {
        expect('DEFAULT');
        defaultValue = literal();
      } else {
        break;
      }
    }
    return { name, type: type.toUpperCase(), isKey, notNull, defaultValue };
  };

  const parseCreate = () => {
    expect('CREATE');
    let unique = false;
    if (isKeyword(peek(), 'UNIQUE')) {
      expect('UNIQUE');
      unique = true;
    }
    if (isKeyword(peek(), 'INDEX')) {
      expect('INDEX');
      let ifNotExists = false;
      if (isKeyword(peek(), 'IF')) {
        expect('IF');
        expect('NOT');
        expect('EXISTS');
        ifNotExists = true;
      }
      const name = ident();
      expect('ON');
      const table = ident();
      expect(null, '(');
      const column = ident();
      expect(null, ')');
      return { type: 'createIndex', name, table, column, unique, ifNotExists };
    }
    if (unique) throw new Error('parse: UNIQUE is only supported for CREATE UNIQUE INDEX');
    expect('TABLE');
    let ifNotExists = false;
    if (isKeyword(peek(), 'IF')) {
      expect('IF');
      expect('NOT');
      expect('EXISTS');
      ifNotExists = true;
    }
    const name = ident();
    // CREATE TABLE name AS SELECT ...
    if (isKeyword(peek(), 'AS')) {
      expect('AS');
      const select = parseQuery();
      return { type: 'createTableAs', name, select, ifNotExists };
    }
    expect(null, '(');
    const columns = [];
    for (;;) {
      columns.push(parseColumnDef());
      if (isPunct(peek(), ',')) {
        next();
        continue;
      }
      break;
    }
    expect(null, ')');
    return { type: 'createTable', name, columns, ifNotExists };
  };

  const parseInsert = () => {
    expect('INSERT');
    expect('INTO');
    const table = ident();
    let columns = null;
    if (isPunct(peek(), '(')) {
      expect(null, '(');
      columns = [];
      for (;;) {
        columns.push(ident());
        if (isPunct(peek(), ',')) {
          next();
          continue;
        }
        break;
      }
      expect(null, ')');
    }
    if (isKeyword(peek(), 'SELECT')) {
      return { type: 'insertSelect', table, columns, select: parseQuery() };
    }
    if (!isKeyword(peek(), 'VALUES')) throw new Error(`parse: expected VALUES or SELECT after INSERT INTO ${table}`);
    expect('VALUES');
    // One or more tuples: VALUES (...), (...), ...
    const rows = [];
    for (;;) {
      expect(null, '(');
      const values = [];
      for (;;) {
        values.push(literal());
        if (isPunct(peek(), ',')) {
          next();
          continue;
        }
        break;
      }
      expect(null, ')');
      rows.push(values);
      if (isPunct(peek(), ',') && isPunct(tokens[pos + 1], '(')) {
        next();
        continue;
      }
      break;
    }
    return { type: 'insert', table, columns, rows };
  };

  // --- Conditions (WHERE / HAVING) ---

  const parseOperand = () => {
    const t = peek();
    // A bare word on the right-hand side is a column reference, not a literal.
    if (t && t.kind === 'word') return { valueCol: ident() };
    return { value: literal() };
  };

  // `(literal, ...)` or `(SELECT ...)` for IN / NOT IN.
  const parseInList = () => {
    expect(null, '(');
    if (isKeyword(peek(), 'SELECT')) {
      const select = parseQuery();
      expect(null, ')');
      return { select };
    }
    const values = [literal()];
    while (isPunct(peek(), ',')) {
      next();
      values.push(literal());
    }
    expect(null, ')');
    return { values };
  };

  const parseComparison = () => {
    const col = ident();
    if (isKeyword(peek(), 'IN')) {
      expect('IN');
      return { col, op: 'in', ...parseInList() };
    }
    if (isKeyword(peek(), 'NOT')) {
      expect('NOT');
      if (isKeyword(peek(), 'IN')) {
        expect('IN');
        return { col, op: 'not-in', ...parseInList() };
      }
      if (isKeyword(peek(), 'LIKE')) {
        expect('LIKE');
        return { col, op: 'not-like', value: literal() };
      }
      throw new Error('parse: expected IN or LIKE after NOT');
    }
    if (isKeyword(peek(), 'LIKE')) {
      expect('LIKE');
      return { col, op: 'like', value: literal() };
    }
    const t = next();
    // Operators are punct tokens, except BETWEEN which is a word.
    const op = t.kind === 'punct' ? t.value : t.kind === 'word' && t.value.toUpperCase() === 'BETWEEN' ? 'BETWEEN' : undefined;
    if (op == null) throw new Error(`parse: expected operator, got '${t?.value ?? 'EOF'}'`);
    switch (op) {
      case '=':
      case '!=':
      case '<>':
      case '>':
      case '<':
      case '>=':
      case '<=':
        return { col, op, ...parseOperand() };
      case 'BETWEEN': {
        const v1 = literal();
        expect('AND');
        return { col, op: 'between', values: [v1, literal()] };
      }
      default:
        throw new Error(`parse: unsupported operator '${op}'`);
    }
  };

  // Condition tree: AND binds tighter than OR; parentheses group explicitly.
  // A plain AND chain stays `{ conditions: [...] }` so simple WHERE clauses keep
  // their original shape.
  const parseConditionPrimary = () => {
    if (isPunct(peek(), '(')) {
      expect(null, '(');
      const inner = parseOrChain();
      expect(null, ')');
      return inner;
    }
    return parseComparison();
  };

  const parseAndChain = () => {
    const conditions = [parseConditionPrimary()];
    while (isKeyword(peek(), 'AND')) {
      expect('AND');
      conditions.push(parseConditionPrimary());
    }
    return { conditions };
  };

  const parseOrChain = () => {
    const conditions = [parseAndChain()];
    while (isKeyword(peek(), 'OR')) {
      expect('OR');
      conditions.push(parseAndChain());
    }
    return conditions.length === 1 ? conditions[0] : { op: 'or', conditions };
  };

  // Optional `WHERE ...` clause.
  const parseWhere = () => {
    if (!isKeyword(peek(), 'WHERE')) return null;
    expect('WHERE');
    return parseOrChain();
  };

  const parseUpdate = () => {
    expect('UPDATE');
    const table = ident();
    expect('SET');
    const sets = [];
    for (;;) {
      const col = ident();
      expect(null, '=');
      sets.push({ col, value: literal() });
      if (isPunct(peek(), ',')) {
        next();
        continue;
      }
      break;
    }
    const where = parseWhere();
    return { type: 'update', table, sets, where };
  };

  const parseDelete = () => {
    expect('DELETE');
    expect('FROM');
    const table = ident();
    const where = parseWhere();
    return { type: 'delete', table, where };
  };

  // ALTER TABLE t ADD [COLUMN] c TYPE [NOT NULL] [DEFAULT literal]
  // ALTER TABLE t RENAME TO t2
  // ALTER TABLE t RENAME [COLUMN] a TO b
  // ALTER TABLE t DROP [COLUMN] c
  const parseAlter = () => {
    expect('ALTER');
    expect('TABLE');
    const table = ident();
    if (isKeyword(peek(), 'RENAME')) {
      expect('RENAME');
      if (isKeyword(peek(), 'TO')) {
        expect('TO');
        return { type: 'alterRenameTable', table, to: ident() };
      }
      if (isKeyword(peek(), 'COLUMN')) expect('COLUMN');
      const from = ident();
      expect('TO');
      return { type: 'alterRenameColumn', table, from, to: ident() };
    }
    if (isKeyword(peek(), 'DROP')) {
      expect('DROP');
      if (isKeyword(peek(), 'COLUMN')) expect('COLUMN');
      return { type: 'alterDropColumn', table, column: ident() };
    }
    expect('ADD');
    if (isKeyword(peek(), 'COLUMN')) expect('COLUMN');
    const column = parseColumnDef();
    if (column.isKey) throw new Error('parse: ALTER TABLE cannot add a PRIMARY KEY column');
    return { type: 'alterTable', table, column };
  };

  // TRUNCATE TABLE t — same effect as deleting every row.
  const parseTruncate = () => {
    expect('TRUNCATE');
    expect('TABLE');
    return { type: 'truncate', table: ident() };
  };

  // DROP TABLE [IF EXISTS] name  /  DROP INDEX [IF EXISTS] name [ON table]
  const parseDrop = () => {
    expect('DROP');
    if (isKeyword(peek(), 'TABLE')) {
      expect('TABLE');
      let ifExists = false;
      if (isKeyword(peek(), 'IF')) {
        expect('IF');
        expect('EXISTS');
        ifExists = true;
      }
      return { type: 'dropTable', table: ident(), ifExists };
    }
    if (isKeyword(peek(), 'INDEX')) {
      expect('INDEX');
      let ifExists = false;
      if (isKeyword(peek(), 'IF')) {
        expect('IF');
        expect('EXISTS');
        ifExists = true;
      }
      const name = ident();
      let table = null;
      if (isKeyword(peek(), 'ON')) {
        expect('ON');
        table = ident();
      }
      return { type: 'dropIndex', name, table, ifExists };
    }
    throw new Error(`parse: expected TABLE or INDEX after DROP`);
  };

  const parseAlias = () => {
    if (isKeyword(peek(), 'AS')) {
      expect('AS');
      return ident();
    }
    return null;
  };

  // SELECT item primary: `col`, `t.*`, `*`, a literal, or a function call
  // `F(*)` / `F(arg)` / `F(DISTINCT arg)` where arg may be an expression.
  const parseSelectPrimary = () => {
    const t = next();
    if (t.kind === 'punct' && t.value === '*') return { kind: 'col', name: '*', alias: null };
    if (t.kind === 'word') {
      // Qualified star: the lexer reads `a.*` as word 'a.' followed by '*'.
      if (t.value.endsWith('.') && isPunct(peek(), '*')) {
        next();
        return { kind: 'col', name: `${t.value}*`, alias: null };
      }
      const p2 = tokens[pos];
      if (p2 && p2.kind === 'punct' && p2.value === '(') {
        // Function call.
        expect(null, '(');
        let distinct = false;
        if (isKeyword(peek(), 'DISTINCT')) {
          expect('DISTINCT');
          distinct = true;
        }
        let arg = null;
        if (isPunct(peek(), '*')) {
          expect(null, '*');
          if (distinct) throw new Error(`parse: ${t.value.toUpperCase()}(DISTINCT *) is not valid`);
        } else arg = parseArithExpr();
        expect(null, ')');
        return { kind: 'agg', fn: t.value.toLowerCase(), arg, distinct, alias: parseAlias() };
      }
      return { kind: 'col', name: t.value, alias: parseAlias() };
    }
    if (t.kind === 'num' || t.kind === 'str') return { kind: 'lit', value: t.kind === 'num' ? Number(t.value) : t.value, alias: parseAlias() };
    throw new Error(`parse: expected column, function or literal, got '${t?.value ?? 'EOF'}'`);
  };

  const parseArithOperand = () => {
    const t = peek();
    if (t && t.kind === 'word') {
      next();
      return { kind: 'col', name: t.value };
    }
    return { kind: 'lit', value: literal() };
  };

  // Left-associative arithmetic over column names and literals.
  // `first` (when given) is already-parsed, so it can seed the chain.
  const parseArithExpr = (first = null) => {
    let expr = first ?? parseArithOperand();
    for (;;) {
      const t = peek();
      if (!isPunct(t, '+') && !isPunct(t, '-') && !isPunct(t, '*') && !isPunct(t, '/') && !isPunct(t, '||')) break;
      next();
      expr = { kind: 'expr', op: t.value, left: expr, right: parseArithOperand() };
    }
    return expr;
  };

  // SELECT item: `col`, `col AS alias`, `col + 1`, `100 - price`, `*`,
  // or a function call. Arithmetic only combines columns / literals.
  const parseSelectItem = () => {
    const first = parseSelectPrimary();
    if ((first.kind === 'col' || first.kind === 'lit') && !first.alias && !first.name?.endsWith('*')) {
      const expr = parseArithExpr(first);
      if (expr.kind === 'expr') return { kind: 'expr', expr, alias: parseAlias() };
    }
    return first;
  };

  const parseGroupBy = () => {
    if (!isKeyword(peek(), 'GROUP')) return null;
    expect('GROUP');
    expect('BY');
    const groupBy = [{ name: ident() }];
    while (isPunct(peek(), ',')) {
      next();
      groupBy.push({ name: ident() });
    }
    return groupBy;
  };

  const parseHaving = () => {
    if (!isKeyword(peek(), 'HAVING')) return null;
    expect('HAVING');
    return parseOrChain();
  };

  const parseOrderBy = () => {
    if (!isKeyword(peek(), 'ORDER')) return null;
    expect('ORDER');
    expect('BY');
    const keys = [];
    for (;;) {
      const col = ident();
      let dir = 'ASC';
      const t = peek();
      if (t && t.kind === 'word' && (t.value.toUpperCase() === 'ASC' || t.value.toUpperCase() === 'DESC')) dir = next().value.toUpperCase();
      keys.push({ col, dir });
      if (isPunct(peek(), ',')) {
        next();
        continue;
      }
      break;
    }
    return keys;
  };

  // Words that terminate a table reference (so they are not eaten as an alias).
  const NOT_AN_ALIAS = new Set(['WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'GROUP', 'ORDER', 'HAVING', 'AS', 'LIMIT', 'UNION', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER']);

  const parseTableRef = () => {
    const table = ident();
    let alias = null;
    if (isKeyword(peek(), 'AS')) {
      expect('AS');
      alias = ident();
    } else {
      const t = peek();
      if (t && t.kind === 'word' && !NOT_AN_ALIAS.has(t.value.toUpperCase())) alias = next().value;
    }
    return { table, alias };
  };

  /**
   * FROM base [, other ...] [JOIN other ON a.x = b.y ...]
   * Comma-joins are cross joins; `INNER` is optional; `LEFT [OUTER] JOIN` keeps
   * unmatched left rows with a null right side (resolved as undefined columns).
   */
  const parseFrom = () => {
    const from = parseTableRef();
    const joins = [];
    for (;;) {
      if (isPunct(peek(), ',')) {
        next();
        joins.push({ type: 'cross', on: null, ...parseTableRef() });
        continue;
      }
      let type = null;
      if (isKeyword(peek(), 'INNER')) {
        expect('INNER');
        expect('JOIN');
        type = 'inner';
      } else if (isKeyword(peek(), 'LEFT')) {
        expect('LEFT');
        if (isKeyword(peek(), 'OUTER')) expect('OUTER');
        expect('JOIN');
        type = 'left';
      } else if (isKeyword(peek(), 'JOIN')) {
        expect('JOIN');
        type = 'inner';
      } else {
        break;
      }
      const ref = parseTableRef();
      let on = null;
      if (isKeyword(peek(), 'ON')) {
        expect('ON');
        const left = ident();
        expect(null, '=');
        on = { left, right: ident() };
      }
      joins.push({ type, on, ...ref });
    }
    return { from, joins };
  };

  // SELECT core: everything before ORDER BY / LIMIT, so a UNION chain can put
  // one trailing ORDER BY / LIMIT on the combined result.
  const parseSelectCore = () => {
    expect('SELECT');
    let distinct = false;
    if (isKeyword(peek(), 'DISTINCT')) {
      expect('DISTINCT');
      distinct = true;
    }
    const selectItems = [];
    if (isPunct(peek(), '*')) {
      expect(null, '*');
      selectItems.push({ kind: 'col', name: '*', alias: null });
    } else {
      for (;;) {
        selectItems.push(parseSelectItem());
        if (isPunct(peek(), ',')) {
          next();
          continue;
        }
        break;
      }
    }
    expect('FROM');
    const { from, joins } = parseFrom();
    const where = parseWhere();
    const groupBy = parseGroupBy();
    const having = parseHaving();
    return { type: 'select', table: from.table, from, joins, distinct, selectItems, where, groupBy, having, orderBy: null, orderByKeys: null, limit: null, offset: 0 };
  };

  const parseSelectTail = () => {
    const orderByKeys = parseOrderBy();
    let limit = null;
    let offset = 0;
    if (isKeyword(peek(), 'LIMIT')) {
      expect('LIMIT');
      limit = literal();
      if (isKeyword(peek(), 'OFFSET')) {
        expect('OFFSET');
        offset = literal();
      }
    } else if (isKeyword(peek(), 'OFFSET')) {
      // OFFSET without LIMIT is allowed (skip N, return the rest).
      expect('OFFSET');
      offset = literal();
    }
    if (typeof limit === 'number' && (!Number.isInteger(limit) || limit < 0)) throw new Error('parse: LIMIT must be a non-negative integer');
    if (typeof offset === 'number' && (!Number.isInteger(offset) || offset < 0)) throw new Error('parse: OFFSET must be a non-negative integer');
    return { orderByKeys, orderBy: orderByKeys ? orderByKeys[0] : null, limit, offset };
  };

  /**
   * SELECT [UNION [ALL] SELECT ...] [ORDER BY ...] [LIMIT ...]
   * One SELECT keeps the flat AST; a chain becomes
   * { type:'union', branches, all (one flag per UNION), orderByKeys, limit, offset }.
   */
  const parseQuery = () => {
    const branches = [parseSelectCore()];
    const all = [];
    while (isKeyword(peek(), 'UNION')) {
      expect('UNION');
      let keep = false;
      if (isKeyword(peek(), 'ALL')) {
        expect('ALL');
        keep = true;
      }
      all.push(keep);
      branches.push(parseSelectCore());
    }
    const tail = parseSelectTail();
    if (branches.length === 1) return { ...branches[0], ...tail };
    return { type: 'union', branches, all, ...tail };
  };

  let ast;
  const t = peek();
  if (isWord(t, 'CREATE')) ast = parseCreate();
  else if (isWord(t, 'INSERT')) ast = parseInsert();
  else if (isWord(t, 'UPDATE')) ast = parseUpdate();
  else if (isWord(t, 'DELETE')) ast = parseDelete();
  else if (isWord(t, 'TRUNCATE')) ast = parseTruncate();
  else if (isWord(t, 'DROP')) ast = parseDrop();
  else if (isWord(t, 'ALTER')) ast = parseAlter();
  else if (isWord(t, 'SELECT')) ast = parseQuery();
  else throw new Error(`parse: unsupported statement '${t?.value ?? 'EOF'}'`);

  // A single statement runs to EOF; an optional ';' is allowed. Anything else
  // is a real syntax error rather than silently ignored input.
  if (isPunct(peek(), ';')) next();
  const trailing = peek();
  if (trailing && trailing.kind !== 'eof') throw new Error(`parse: unexpected trailing input '${trailing.value}'`);
  return ast;
}
