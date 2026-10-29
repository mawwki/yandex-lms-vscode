// Панель материала: очистка HTML и сборка страницы. VS Code подменяется
// заглушкой — проверяем чистые функции без запуска редактора.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const vscodeStub = new Proxy({
  Uri: { joinPath: (a) => a, parse: (u) => ({ toString: () => u }), file: (p) => ({ fsPath: p }) },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ViewColumn: { One: 1 },
  window: {},
  env: {}
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return function stub() { };
  }
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const root = path.join(__dirname, '..');
const { prepareMaterialContent, materialHtml } = require(path.join(root, 'src/material.js'));

const lessonPlan = '<section class="material__plan"><nav><ol><li><a class="material__link" href="#1">Цикл for</a></li></ol></nav></section>';

test('prepareMaterialContent оставляет разметку материала и подписывает оглавление', () => {
  const out = prepareMaterialContent(lessonPlan + '<section class="material__chapter"><p>Текст</p></section>');
  assert.ok(out.includes('<div class="plan-title">Содержание</div>'));
  assert.ok(out.includes('class="material__link"'));
  assert.ok(out.includes('class="material__chapter"'));
  assert.ok(out.includes('href="#1"'));
});

test('prepareMaterialContent вырезает скрипты и обработчики', () => {
  const out = prepareMaterialContent('<script>alert(1)</script><p onclick="steal()">Текст</p><style>p{}</style>');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('onclick'));
  assert.ok(!out.includes('<style'));
  assert.ok(out.includes('Текст'));
});

test('prepareMaterialContent подсвечивает Python-код', () => {
  const out = prepareMaterialContent('<pre><code class="language-python">if 1 &lt; 2:\n    print("ok")</code></pre>');
  assert.ok(out.includes('tok-kw'));
  assert.ok(out.includes('tok-builtin'));
  assert.ok(out.includes('tok-str'));
  assert.ok(out.includes('&lt;'));
  assert.ok(!out.includes('<code class="language-python">if 1 <'));
});

test('materialHtml собирает шапку, тип и время чтения', () => {
  const lms = { materialPanel: { webview: { cspSource: 'vscode-webview://test' } } };
  const current = {
    materialId: 2,
    materials: [
      { id: 1, title: 'Учебник | Первый', type: 'textbook' },
      { id: 2, title: 'Учебник | Второй', type: 'textbook' },
      { id: 3, title: 'Учебник | Третий', type: 'textbook' }
    ],
    courseTitle: 'Программирование на Python',
    lessonTitle: 'Циклы',
    detail: {
      title: 'Учебник | Второй',
      type: 'textbook',
      content: '<h1>Второй</h1><p>' + 'слово '.repeat(360) + '</p>'
    }
  };
  const html = materialHtml(lms, current);
  assert.ok(html.includes('data-act="prev"'));
  assert.ok(html.includes('data-act="next"'));
  assert.ok(html.includes('Первый'));
  assert.ok(html.includes('Третий'));
  assert.ok(html.includes('2 мин чтения'));
  assert.ok(html.includes('class="type-pill">Учебник'));
  assert.ok(html.includes('Программирование на Python'));
  // Свой h1 материала — единственный: второй шапку не дублируем.
  assert.strictEqual((html.match(/<h1/g) || []).length, 1);
});

test('materialHtml экранирует заголовок и не выполняет вложенные скрипты', () => {
  const lms = { materialPanel: { webview: { cspSource: 'vscode-webview://test' } } };
  const current = {
    materialId: 7,
    materials: [{ id: 7, title: 'Материал', type: 'article' }],
    detail: {
      title: '<img src=x onerror=alert(1)>',
      type: 'article',
      content: '<p>Текст</p><script>alert(2)</script>'
    }
  };
  const html = materialHtml(lms, current);
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('alert(2)'));
});

test('materialHtml без списка материалов не рисует переходы', () => {
  const lms = { materialPanel: null };
  const html = materialHtml(lms, {
    materialId: 1,
    detail: { title: 'Учебник | Один', type: 'textbook', content: '<p>Текст</p>' }
  });
  assert.ok(!html.includes('data-act="prev"'));
  assert.ok(!html.includes('data-act="next"'));
  assert.ok(html.includes('Учебник'));
});
