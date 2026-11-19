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

  const parseCreate = () => {
    expect('CREATE');
    if (isKeyword(peek(), 'INDEX')) {
      expect('INDEX');
      const name = ident();
      expect('ON');
      const table = ident();
      expect(null, '(');
      const column = ident();
      expect(null, ')');
      return { type: 'createIndex', name, table, column };
    }
    expect('TABLE');
    const name = ident();
    expect(null, '(');
    const columns = [];
    for (;;) {
      const cname = ident();
      const ctype = ident();
      let isKey = false;
      if (isKeyword(peek(), 'PRIMARY')) {
        expect('PRIMARY');
        expect('KEY');
        isKey = true;
      }
      columns.push({ name: cname, type: ctype.toUpperCase(), isKey });
      if (isPunct(peek(), ',')) {
        next();
        continue;
      }
      break;
    }
    expect(null, ')');
    return { type: 'createTable', name, columns };
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
    expect('VALUES');
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
    return { type: 'insert', table, columns, values };
  };

  // --- Conditions (WHERE / HAVING) ---

  const parseOperand = () => {
    const t = peek();
    // A bare word on the right-hand side is a column reference, not a literal.
    if (t && t.kind === 'word') return { valueCol: ident() };
    return { value: literal() };
  };

  const parseCondition = () => {
    const col = ident();
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

  // Optional `WHERE c1 [AND c2 ...]` clause.
  const parseWhere = () => {
    if (!isKeyword(peek(), 'WHERE')) return null;
    expect('WHERE');
    const conditions = [parseCondition()];
    while (isKeyword(peek(), 'AND')) {
      expect('AND');
      conditions.push(parseCondition());
    }
    return { conditions };
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

  const parseAlias = () => {
    if (isKeyword(peek(), 'AS')) {
      expect('AS');
      return ident();
    }
    return null;
  };

  // SELECT item: `col`, `col AS alias`, `*`, `t.*`, or a function call `F(*)` / `F(col)`.
  const parseSelectItem = () => {
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
        let col = null;
        if (isPunct(peek(), '*')) expect(null, '*');
        else col = ident();
        expect(null, ')');
        return { kind: 'agg', fn: t.value.toLowerCase(), col, alias: parseAlias() };
      }
      return { kind: 'col', name: t.value, alias: parseAlias() };
    }
    throw new Error(`parse: expected column or function, got '${t?.value ?? 'EOF'}'`);
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
    return parseCondition();
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
  const NOT_AN_ALIAS = new Set(['WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'GROUP', 'ORDER', 'HAVING', 'AS', 'LIMIT', 'UNION']);

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

  const parseSelect = () => {
    expect('SELECT');
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
    const orderByKeys = parseOrderBy();
    const orderBy = orderByKeys ? orderByKeys[0] : null;
    let limit = null;
    let offset = 0;
    if (isKeyword(peek(), 'LIMIT')) {
      expect('LIMIT');
      limit = literal();
      if (isKeyword(peek(), 'OFFSET')) {
        expect('OFFSET');
        offset = literal();
      }
    }
    if (typeof limit === 'number' && (!Number.isInteger(limit) || limit < 0)) throw new Error('parse: LIMIT must be a non-negative integer');
    return { type: 'select', table: from.table, from, joins, selectItems, where, groupBy, having, orderBy, orderByKeys, limit, offset };
  };

  const t = peek();
  if (isWord(t, 'CREATE')) return parseCreate();
  if (isWord(t, 'INSERT')) return parseInsert();
  if (isWord(t, 'UPDATE')) return parseUpdate();
  if (isWord(t, 'DELETE')) return parseDelete();
  if (isWord(t, 'SELECT')) return parseSelect();
  throw new Error(`parse: unsupported statement '${t?.value ?? 'EOF'}'`);
}
