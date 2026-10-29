// Подсветка Python для материалов: без внешних библиотек.
// Код материала приходит обычным текстом внутри <pre><code>, поэтому
// размечаем его на токены здесь, на сервере, а цвета задаёт CSS панели.
const { escapeHtml, decodeEntities } = require('./util');

// Управляющие конструкции — в теме VS Code они розовые.
const CONTROL_KW = new Set([
  'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'return',
  'yield', 'try', 'except', 'finally', 'raise', 'with', 'pass', 'assert',
  'del', 'global', 'nonlocal', 'lambda', 'await', 'async', 'match', 'case'
]);

// Объявления и логические операторы — синие.
const DECL_KW = new Set([
  'def', 'class', 'import', 'from', 'as', 'in', 'is', 'and', 'or', 'not'
]);

const CONST_KW = new Set(['True', 'False', 'None', 'NotImplemented', 'Ellipsis', '__debug__']);
const SELF_KW = new Set(['self', 'cls']);

const BUILTINS = new Set([
  'print', 'input', 'len', 'range', 'int', 'float', 'str', 'bool', 'list',
  'dict', 'set', 'tuple', 'frozenset', 'sum', 'min', 'max', 'abs', 'round',
  'sorted', 'reversed', 'enumerate', 'zip', 'map', 'filter', 'open', 'type',
  'isinstance', 'issubclass', 'ord', 'chr', 'bin', 'hex', 'oct', 'pow',
  'divmod', 'any', 'all', 'iter', 'next', 'id', 'hash', 'repr', 'format',
  'super', 'property', 'staticmethod', 'classmethod', 'object', 'bytes',
  'bytearray', 'complex', 'callable', 'getattr', 'setattr', 'hasattr',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'RuntimeError', 'ZeroDivisionError', 'StopIteration', 'AssertionError'
]);

// Длинные операторы проверяем раньше коротких.
const OPERATORS = [
  '**=', '//=', '<<=', '>>=', '...', '**', '//', '<<', '>>', '<=', '>=',
  '==', '!=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', ':=', '->',
  '@=', '+', '-', '*', '/', '%', '=', '<', '>', '&', '|', '^', '~', ':'
];

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.[\d_]*|\.\d[\d_]*|\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/;

function isIdStart(ch) {
  return !!ch && /[\p{L}_]/u.test(ch);
}

function isIdPart(ch) {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

function span(cls, text) {
  return '<span class="' + cls + '">' + escapeHtml(text) + '</span>';
}

// Строка может начинаться с префикса: r, b, f, u, rb, br, fr, rf.
function stringAt(code, i) {
  const ch = code[i];
  if (ch === '"' || ch === "'") return { quote: ch, prefixLen: 0 };
  const m = /^(?:[rR][bBfF]?|[bBfF][rR]?|[uU])(?=["'])/.exec(code.slice(i, i + 3));
  if (!m) return null;
  return { quote: code[i + m[0].length], prefixLen: m[0].length };
}

function scanString(code, i, st) {
  const q = st.quote;
  const triple = code.slice(i + st.prefixLen, i + st.prefixLen + 3) === q + q + q;
  const endSeq = triple ? q + q + q : q;
  let j = i + st.prefixLen + (triple ? 3 : 1);
  while (j < code.length) {
    if (code[j] === '\\') { j += 2; continue; }
    if (!triple && code[j] === '\n') break;
    if (code.startsWith(endSeq, j)) { j += endSeq.length; break; }
    j++;
  }
  return { text: code.slice(i, j), end: j };
}

function highlightPython(source) {
  const code = decodeEntities(String(source == null ? '' : source)).replace(/\r\n?/g, '\n');
  let i = 0;
  let out = '';
  let expectName = '';

  while (i < code.length) {
    const ch = code[i];

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /\s/.test(code[j])) j++;
      out += escapeHtml(code.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '#') {
      const nl = code.indexOf('\n', i);
      const stop = nl < 0 ? code.length : nl;
      out += span('tok-com', code.slice(i, stop));
      i = stop;
      continue;
    }

    const st = stringAt(code, i);
    if (st) {
      const r = scanString(code, i, st);
      out += span('tok-str', r.text);
      i = r.end;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      const m = NUMBER_RE.exec(code.slice(i));
      if (m) {
        out += span('tok-num', m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (ch === '@' && isIdStart(code[i + 1])) {
      let j = i + 1;
      while (j < code.length && isIdPart(code[j])) j++;
      out += span('tok-dec', code.slice(i, j));
      i = j;
      continue;
    }

    if (isIdStart(ch)) {
      const start = i;
      while (i < code.length && isIdPart(code[i])) i++;
      const word = code.slice(start, i);
      let cls;
      if (word === 'def') {
        cls = 'tok-kw2';
        expectName = 'tok-fn';
      } else if (word === 'class') {
        cls = 'tok-kw2';
        expectName = 'tok-cls';
      } else if (CONTROL_KW.has(word)) {
        cls = 'tok-kw';
      } else if (DECL_KW.has(word)) {
        cls = 'tok-kw2';
      } else if (CONST_KW.has(word)) {
        cls = 'tok-const';
      } else if (SELF_KW.has(word)) {
        cls = 'tok-const';
      } else if (expectName) {
        cls = expectName;
        expectName = '';
      } else if (BUILTINS.has(word)) {
        cls = 'tok-builtin';
      } else {
        let j = i;
        while (j < code.length && (code[j] === ' ' || code[j] === '\t')) j++;
        cls = code[j] === '(' ? 'tok-fn' : 'tok-var';
      }
      out += span(cls, word);
      continue;
    }

    const op = OPERATORS.find(o => code.startsWith(o, i));
    if (op) {
      out += span('tok-op', op);
      i += op.length;
      continue;
    }

    out += escapeHtml(ch);
    i++;
  }

  return out;
}

// Заменяет содержимое <pre><code> подсвеченными токенами. Не-python блоки
// (например, вывод программы) остаются как есть.
function highlightCodeBlocks(html) {
  const blockRe = /<pre(\s[^>]*)?>\s*<code([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  return String(html || '').replace(blockRe, (all, preAttrs, codeAttrs, body) => {
    const lang = /language-([\w-]+)/i.exec(codeAttrs || '');
    if (lang && !/^(python|py|python3)$/i.test(lang[1])) return all;
    const pre = preAttrs || '';
    const code = codeAttrs || '';
    return '<pre' + pre + '><code' + code + '>' + highlightPython(body) + '</code></pre>';
  });
}

module.exports = { highlightPython, highlightCodeBlocks };
