const test = require('node:test');
const assert = require('node:assert');
const { parseExamples, normalizeOutput } = require('../src/util');

test('parseExamples: таблица «ввод | вывод»', () => {
  const html = '<p>Дана строка.</p><table><tr><th>Ввод</th><th>Вывод</th></tr>' +
    '<tr><td>2 3</td><td>5</td></tr><tr><td><pre>10\n20</pre></td><td><pre>30</pre></td></tr></table>';
  assert.deepStrictEqual(parseExamples(html), [
    { input: '2 3', output: '5' },
    { input: '10\n20', output: '30' }
  ]);
});

test('parseExamples: пары <pre> при слове «Пример»', () => {
  const html = '<p>Пример 1:</p><p>Ввод:</p><pre><code>a = 2\nprint(a)</code></pre><p>Вывод:</p><pre><code>2</code></pre>' +
    '<p>Пример 2:</p><p>Ввод:</p><pre><code>x</code></pre><p>Вывод:</p><pre><code>x</code></pre>';
  const ex = parseExamples(html);
  assert.strictEqual(ex.length, 2);
  assert.strictEqual(ex[0].input, 'a = 2\nprint(a)');
  assert.strictEqual(ex[0].output, '2');
});

test('parseExamples: entities и <br> в ячейках', () => {
  const html = '<table><tr><td>1&nbsp;&lt;&nbsp;2<br>строка2</td><td>false</td></tr></table>';
  const ex = parseExamples(html);
  assert.strictEqual(ex.length, 1);
  assert.strictEqual(ex[0].input, '1 < 2\nстрока2');
  assert.strictEqual(ex[0].output, 'false');
});

test('parseExamples: одиночный <pre> без примеров — пусто', () => {
  assert.deepStrictEqual(parseExamples('<p>Формат:</p><pre><code>n</code></pre>'), []);
  assert.deepStrictEqual(parseExamples(''), []);
  assert.deepStrictEqual(parseExamples('<p>текст без кода</p>'), []);
});

test('normalizeOutput: мягкое сравнение как чекер LMS', () => {
  assert.strictEqual(normalizeOutput('5'), normalizeOutput('5\n'));
  assert.strictEqual(normalizeOutput('5  '), normalizeOutput('5'));
  assert.strictEqual(normalizeOutput('a\r\nb\r\n'), normalizeOutput('a\nb'));
  assert.notStrictEqual(normalizeOutput('a\n\nb'), normalizeOutput('a\nb'));
  assert.strictEqual(normalizeOutput('a\nb\n\n\n'), normalizeOutput('a\nb\n'));
});
