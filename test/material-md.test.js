// Запасной Markdown-режим материала: чистые функции без VS Code.
const test = require('node:test');
const assert = require('node:assert');
const {
  htmlToMaterialMarkdown, materialMarkdown, materialPlainText,
  resolveMaterialUrl, detectCodeLanguage
} = require('../src/material-md');

const lessonPlan = '<section class="material__plan"><nav><ol><li><a class="material__link" href="#1">Цикл for</a></li><li><a href="#2">while</a></li></ol></nav></section>';

test('materialMarkdown собирает заголовок, хлебные крошки и тип', () => {
  const md = materialMarkdown({
    materialId: 2,
    courseTitle: 'Программирование на Python',
    lessonTitle: 'Циклы',
    detail: {
      title: 'Учебник | Оператор for',
      type: 'textbook',
      content: lessonPlan + '<p>' + 'слово '.repeat(360) + '</p>'
    }
  }, 'https://lms.yandex.ru');
  assert.ok(md.startsWith('# Оператор for\n'), 'тип из заголовка убирается');
  assert.ok(md.includes('*Программирование на Python › Циклы*'));
  assert.ok(md.includes('`Учебник` · 2 мин чтения'));
  assert.ok(md.includes('### Содержание'), 'оглавление подписано');
  assert.ok(md.includes('1. Цикл for'), 'пункт оглавления попал в список');
  assert.ok(!md.includes('href="#1"'), 'якорные ссылки не остаются битыми');
});

test('htmlToMaterialMarkdown делает блок кода с языком и сохраняет отступы', () => {
  const md = htmlToMaterialMarkdown(
    '<p>Код:</p><pre><code class="language-python">if 1 &lt; 2:\n    print("ok")</code></pre>',
    'https://lms.yandex.ru'
  );
  assert.ok(md.includes('```python\nif 1 < 2:\n    print("ok")\n```'));
  assert.ok(!md.includes('&lt;'));
});

test('htmlToMaterialMarkdown узнаёт Python без класса языка', () => {
  const md = htmlToMaterialMarkdown('<pre>def f():\n    return 1</pre>', 'https://lms.yandex.ru');
  assert.ok(md.includes('```python'));
});

test('htmlToMaterialMarkdown собирает списки, таблицы, картинки и ссылки', () => {
  const md = htmlToMaterialMarkdown(
    '<ul><li>Первый</li><li><strong>Второй</strong></li></ul>' +
    '<table><tr><th>Ввод</th><th>Вывод</th></tr><tr><td>1</td><td>2</td></tr></table>' +
    '<p><img src="/images/pic.png" alt="Схема"> <a href="/courses/1/lessons/2/materials/3">материал</a></p>',
    'https://lms.yandex.ru'
  );
  assert.ok(md.includes('- Первый'));
  assert.ok(md.includes('- **Второй**'));
  assert.ok(md.includes('| Ввод | Вывод |'));
  assert.ok(md.includes('| 1 | 2 |'));
  assert.ok(md.includes('![Схема](https://lms.yandex.ru/images/pic.png)'));
  assert.ok(md.includes('[материал](https://lms.yandex.ru/courses/1/lessons/2/materials/3)'));
});

test('htmlToMaterialMarkdown не пропускает скрипты и обработчики', () => {
  const md = htmlToMaterialMarkdown(
    '<script>alert(1)</script><p onclick="steal()">Текст</p><a href="javascript:alert(2)">клик</a>',
    'https://lms.yandex.ru'
  );
  assert.strictEqual(md, 'Текст\n\nклик');
});

test('htmlToMaterialMarkdown сохраняет инлайновый код и форматирование', () => {
  const md = htmlToMaterialMarkdown('<p>Вызовите <code>range(3)</code> и <em>проверьте</em> <b>вывод</b>.</p>');
  assert.ok(md.includes('`range(3)`'));
  assert.ok(md.includes('*проверьте*'));
  assert.ok(md.includes('**вывод**'));
});

test('materialPlainText оставляет читаемый текст без разметки', () => {
  const text = materialPlainText({
    courseTitle: 'Python',
    lessonTitle: 'Циклы',
    detail: {
      title: 'Учебник | Оператор for',
      type: 'textbook',
      content: lessonPlan + '<p>Текст <b>важно</b>.</p><pre><code>print(1)</code></pre>'
    }
  });
  assert.ok(text.startsWith('Оператор for\n'));
  assert.ok(text.includes('Python › Циклы'));
  assert.ok(text.includes('Учебник'));
  assert.ok(text.includes('Текст важно.'));
  assert.ok(text.includes('print(1)'));
  assert.ok(!text.includes('<p>'));
  assert.ok(!text.includes('material__plan'));
});

test('resolveMaterialUrl достраивает относительные адреса и не трогает data:', () => {
  assert.strictEqual(resolveMaterialUrl('/a/b.png', 'https://lms.yandex.ru'), 'https://lms.yandex.ru/a/b.png');
  assert.strictEqual(resolveMaterialUrl('//cdn.example/x.png', 'https://lms.yandex.ru'), 'https://cdn.example/x.png');
  assert.strictEqual(resolveMaterialUrl('data:image/png;base64,AA', 'https://lms.yandex.ru'), 'data:image/png;base64,AA');
});

test('detectCodeLanguage понимает алиасы и характерный Python', () => {
  assert.strictEqual(detectCodeLanguage('class="language-py3"', ''), 'python');
  assert.strictEqual(detectCodeLanguage('', 'for i in range(3):\n    print(i)'), 'python');
  assert.strictEqual(detectCodeLanguage('', '$ pip install x'), 'bash');
  assert.strictEqual(detectCodeLanguage('', 'просто текст'), '');
});
