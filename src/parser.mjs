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

  const parseCreateTable = () => {
    expect('CREATE');
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

  const parseSelect = () => {
    expect('SELECT');
    let columns = null;
    if (isPunct(peek(), '*')) {
      expect(null, '*');
    } else {
      columns = [];
      for (;;) {
        columns.push(ident());
        if (isPunct(peek(), ',')) {
          next();
          continue;
        }
        break;
      }
    }
    expect('FROM');
    const table = ident();
    let where = null;
    if (isKeyword(peek(), 'WHERE')) {
      expect('WHERE');
      const col = ident();
      expect(null, '=');
      where = { col, value: literal() };
    }
    let orderBy = null;
    if (isKeyword(peek(), 'ORDER')) {
      expect('ORDER');
      expect('BY');
      const col = ident();
      let dir = 'ASC';
      const t = peek();
      if (t && t.kind === 'word' && (t.value === 'ASC' || t.value === 'DESC')) {
        dir = next().value;
      }
      orderBy = { col, dir };
    }
    return { type: 'select', table, columns, where, orderBy };
  };

  const t = peek();
  if (isWord(t, 'CREATE')) return parseCreateTable();
  if (isWord(t, 'INSERT')) return parseInsert();
  if (isWord(t, 'SELECT')) return parseSelect();
  throw new Error(`parse: unsupported statement '${t?.value ?? 'EOF'}'`);
}
