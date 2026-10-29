const test = require('node:test');
const assert = require('node:assert');
const {
  stripTemplate, statusBadge, aiLint, aiExtractJson, htmlToMarkdown,
  htmlToText, mdToHtml, safeName, pick, latestSubmissionOf, escapeHtml, verdictReason,
  sanitizeStatementHtml, parseExamples, isOkVerdict, verdictLabel,
  MATERIAL_TYPES, materialTypeLabel, materialDisplayTitle, materialReadingMinutes
} = require('../src/util');

test('stripTemplate вырезает шаблон main()', () => {
  const tpl = 'def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n';
  assert.strictEqual(stripTemplate(tpl).trim(), '');
  assert.strictEqual(stripTemplate('a = 1\n' + tpl + 'print(a)\n'), 'a = 1\nprint(a)\n');
});

test('stripTemplate не трогает обычный код', () => {
  assert.strictEqual(stripTemplate('x = int(input())\nprint(x * 2)\n'), 'x = int(input())\nprint(x * 2)\n');
});

test('statusBadge понятные статусы', () => {
  assert.strictEqual(statusBadge('accepted', '').desc, 'Зачтено');
  assert.strictEqual(statusBadge('', 'OK').desc, 'Зачтено');
  assert.strictEqual(statusBadge('uploaded', '').desc, 'На проверке');
  assert.strictEqual(statusBadge('rework', '').desc, 'На доработку');
  assert.strictEqual(statusBadge('', '').desc, '');
});

test('вердикт «ok» в любом регистре считается зачтённым', () => {
  // LMS отдаёт строчными: «ok». Прямое сравнение с «OK» давало красную плашку.
  assert.strictEqual(isOkVerdict('ok'), true);
  assert.strictEqual(isOkVerdict('OK'), true);
  assert.strictEqual(isOkVerdict(' Ok '), true);
  assert.strictEqual(isOkVerdict('accepted'), true);
  assert.strictEqual(isOkVerdict('wrong-answer'), false);
  assert.strictEqual(isOkVerdict(''), false);
  assert.strictEqual(isOkVerdict(undefined), false);
  // Тип «rework» при вердикте ok — всё равно зачтено (вердикт важнее типа).
  assert.strictEqual(statusBadge('rework', 'ok').desc, 'Зачтено');
  assert.strictEqual(statusBadge('rework', 'ok').icon, 'pass');
  assert.strictEqual(statusBadge('rework', 'wrong-answer').desc, 'На доработку');
  // Подпись ищется без учёта регистра и не выводит сырое «ok» в уведомление.
  assert.match(verdictLabel('ok'), /Зачтено/);
  assert.strictEqual(verdictLabel('wrong-answer'), 'Неверный ответ');
  assert.strictEqual(verdictLabel(''), '');
});

test('aiLint ловит запрещённые конструкции', () => {
  assert.ok(aiLint('import sys\n').includes('import запрещён'));
  assert.ok(aiLint('x = f"{a}"\n').includes('f-строки запрещены'));
  assert.ok(aiLint('y = [i for i in range(3)]\n').length > 0);
  assert.ok(aiLint('try:\n    pass\nexcept Exception:\n    pass\n').length > 0);
  assert.deepStrictEqual(aiLint('x = int(input())\nprint(x + 1)\n'), []);
});

test('aiExtractJson достаёт JSON из болтовни модели', () => {
  assert.deepStrictEqual(aiExtractJson('Вот ответ: {"answers":{"1":"2"}} надеюсь верно'), { answers: { '1': '2' } });
  assert.deepStrictEqual(aiExtractJson('```json\n{"a": {"b": "}"}}\n```'), { a: { b: '}' } });
  assert.throws(() => aiExtractJson('никакого json тут нет'));
});

test('htmlToMarkdown таблицы и картинки', () => {
  const md = htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>');
  assert.ok(md.includes('| a | b |'));
  assert.ok(md.includes('| 1 | 2 |'));
  const img = htmlToMarkdown('<img src="x.png" alt="график">');
  assert.ok(img.includes('![график](x.png)'));
});

test('htmlToText убирает теги и раскодирует сущности', () => {
  const t = htmlToText('<p>Привет&nbsp;мир &amp; co</p><script>bad()</script>');
  assert.ok(t.includes('Привет мир & co'));
  assert.ok(!t.includes('bad()'));
});

test('mdToHtml списки и код', () => {
  const html = mdToHtml('- **один**\n- два\n\n```\ncode\n```');
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<b>один</b>'));
  assert.ok(html.includes('<pre><code>code</code></pre>'));
});

test('safeName вырезает запрещённые символы', () => {
  assert.ok(!/[<>:"/\\|?*]/.test(safeName('a<b>:c/d\\e|f?g*h')));
  assert.strictEqual(safeName(''), 'без-названия');
});

test('pick берёт первое непустое значение', () => {
  assert.strictEqual(pick({ a: null, b: 0, c: 3 }, 'a', 'b', 'c'), 0);
  assert.strictEqual(pick(null, 'a'), undefined);
});

test('latestSubmissionOf выбирает свежую посылку', () => {
  const json = { submissions: [{ id: 5, verdict: 'OK' }, { id: 9, verdict: 'wrong-answer' }] };
  assert.strictEqual(latestSubmissionOf(json).id, 9);
  assert.strictEqual(latestSubmissionOf({ solution: { latest_submission: { id: 1 } } }).id, 1);
});

test('escapeHtml экранирует всё опасное', () => {
  assert.strictEqual(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('sanitizeStatementHtml вырезает активные элементы, но не текст', () => {
  const out = sanitizeStatementHtml(
    '<p>Код: onclick=x</p><script>alert(1)</script><img src="a.png" onerror="alert(2)">' +
    '<a href="javascript:alert(3)">x</a><style>body{display:none}</style><meta http-equiv="refresh" content="0">'
  );
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('onerror'));
  assert.ok(!out.includes('javascript:'));
  assert.ok(!out.includes('<style'));
  assert.ok(!out.includes('<meta'));
  assert.ok(out.includes('<img src="a.png">'));
  assert.ok(!out.includes('href="javascript'));
  // текст «onclick=x» в условии (пример кода) должен остаться
  assert.ok(out.includes('onclick=x'));
});

test('parseExamples не принимает таблицу ограничений за пример', () => {
  const html = '<table><tr><td>Ограничение</td><td>Значение</td></tr>' +
    '<tr><td>1 ≤ n ≤ 10⁹</td><td>1 секунда</td></tr></table>' +
    '<table><tr><td>Ввод</td><td>Вывод</td></tr><tr><td>3 4</td><td>7</td></tr></table>';
  const ex = parseExamples(html);
  assert.strictEqual(ex.length, 1);
  assert.deepStrictEqual(ex[0], { input: '3 4', output: '7' });
});

test('verdictReason достаёт причину из логов проверки', () => {
  const parts = verdictReason({
    verdict: 'runtime-error',
    testNumber: 4,
    compileLog: '',
    testInfo: { 'Ввод': '3 4', 'Ошибка': 'Traceback (most recent call last):\nZeroDivisionError: division by zero' }
  });
  assert.ok(parts && parts.length >= 2);
  // текст ошибки — первым, ввод теста — контекстом
  assert.match(parts[0].text, /ZeroDivisionError/);
  assert.strictEqual(parts[0].label, 'Ошибка');
  assert.ok(parts.some(p => p.text === '3 4'));
});

test('verdictReason без текста возвращает null', () => {
  assert.strictEqual(verdictReason(null), null);
  assert.strictEqual(verdictReason({ verdict: 'runtime-error', compileLog: '   ', testInfo: {} }), null);
});

test('verdictReason не дублирует одинаковый текст', () => {
  const parts = verdictReason({ compileLog: 'SyntaxError: bad input', error: 'SyntaxError: bad input' });
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].label, 'Лог компиляции');
});

// ── материалы уроков (учебники) ──
test('materialTypeLabel переводит типы материалов LMS', () => {
  assert.strictEqual(materialTypeLabel('textbook'), 'Учебник');
  assert.strictEqual(materialTypeLabel(' TextBook '), 'Учебник');
  assert.strictEqual(materialTypeLabel('article'), 'Статья');
  assert.strictEqual(materialTypeLabel('video'), 'Видео');
  assert.strictEqual(materialTypeLabel('unknown-type'), 'Материал');
  assert.strictEqual(materialTypeLabel(null), 'Материал');
  assert.strictEqual(MATERIAL_TYPES.textbook, 'Учебник');
});

test('materialDisplayTitle убирает тип из заголовка LMS', () => {
  assert.strictEqual(materialDisplayTitle({ title: 'Учебник | Оператор for. Не будем зацикливаться на while' }), 'Оператор for. Не будем зацикливаться на while');
  assert.strictEqual(materialDisplayTitle({ title: 'Видео: Разбор задачи' }), 'Разбор задачи');
  assert.strictEqual(materialDisplayTitle({ title: 'Статья — Как читать код' }), 'Как читать код');
  assert.strictEqual(materialDisplayTitle({ title: 'Просто материал' }), 'Просто материал');
  assert.strictEqual(materialDisplayTitle({}), 'Материал');
  // Префикс без содержательного хвоста не должен давать пустое название.
  assert.strictEqual(materialDisplayTitle({ title: 'Учебник | ' }), 'Учебник |');
});

test('materialReadingMinutes оценивает время чтения по тексту', () => {
  assert.strictEqual(materialReadingMinutes(''), 0);
  assert.strictEqual(materialReadingMinutes('<p>привет мир</p>'), 1);
  assert.strictEqual(materialReadingMinutes(('слово ').repeat(360)), 2);
  // HTML-теги и скрипты не считаются словами.
  assert.strictEqual(materialReadingMinutes('<script>alert(1)</script><style>p{}</style><p>одно</p>'), 1);
});
