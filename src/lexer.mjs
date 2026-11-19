// src/lexer.mjs — SQL tokenizer for the small subset supported by the engine:
//   CREATE TABLE t (col TYPE [PRIMARY KEY], ...)
//   INSERT INTO t [(col, ...)] VALUES (literal, ...)
//   SELECT [cols|*] FROM t [WHERE c = literal] [ORDER BY c [ASC|DESC]]
// Literals: 'text' (with '' escape) and numbers.

export function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const isDigit = (c) => c >= '0' && c <= '9';
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
    } else if (ch === "'") {
      i++;
      let v = '';
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            v += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          v += sql[i++];
        }
      }
      tokens.push({ kind: 'str', value: v });
    } else if (isDigit(ch)) {
      let j = i;
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
      tokens.push({ kind: 'num', value: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      tokens.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
    } else if ('(),=;*'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
    } else {
      throw new Error(`lexer: unexpected character '${ch}' at offset ${i}`);
    }
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}
