// Режимы чата с ИИ: «Текст» (ответ в чат) и «Код» (правка файла решения).
// Проверяем то, что видно снаружи: переключатель в строке ввода, гарантию
// изменения файла в режиме «Код» и превращение ответа в комментарии.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const statusBar = { text: '', tooltip: '', command: '', hide() { }, show() { }, dispose() { } };
const vscodeStub = new Proxy({
  window: {
    createStatusBarItem: () => Object.assign({}, statusBar),
    createOutputChannel: () => ({ appendLine() { }, show() { }, clear() { }, dispose() { } }),
    createWebviewPanel: () => { throw new Error('not in unit test'); },
    createTreeView: () => ({ dispose() { } })
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => { } }),
    registerTextDocumentContentProvider: () => ({ dispose() { } }),
    onDidChangeTextDocument: () => ({ dispose() { } }),
    textDocuments: []
  },
  commands: { registerCommand: () => ({ dispose() { } }), executeCommand: async () => { } },
  languages: { registerInlineCompletionItemProvider: () => ({ dispose() { } }) },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } },
  ThemeIcon: class { constructor() { } },
  ThemeColor: class { constructor() { } },
  TreeItem: class { constructor() { } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Two: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { file: (p) => ({ fsPath: p }), joinPath: (a) => a, parse: (u) => ({}) },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  InlineCompletionItem: class { constructor() { } },
  WorkspaceEdit: class { replace() { } },
  Position: class { constructor() { } },
  Range: class { constructor() { } }
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
const { Lms } = require(path.join(root, 'src/lms.js'));

function makeLms(opts) {
  const o = opts || {};
  const context = {
    secrets: { get: async () => null, store: async () => { }, delete: async () => { } },
    globalState: {
      get: (key, def) => (o.state && key in o.state ? o.state[key] : def),
      update: async () => { }
    },
    extensionUri: { fsPath: root },
    subscriptions: []
  };
  const lms = new Lms(context);
  lms.currentTask = {
    taskId: 4213,
    filePath: o.noFile ? null : 'C:\\work\\yandex-lms\\4213.py',
    isMarkers: !!o.noFile,
    taskTitle: 'Сумма двух чисел'
  };
  return lms;
}

test('режим по умолчанию — «Текст»', () => {
  const lms = makeLms();
  assert.strictEqual(lms.aiChatMode(), 'text');
});

test('режим «Код» берётся из сохранённого состояния', () => {
  const lms = makeLms({ state: { 'yandexLms.aiChatMode': 'code' } });
  assert.strictEqual(lms.aiChatMode(), 'code');
});

test('переключатель живёт в строке ввода и показывает активный режим', () => {
  const text = makeLms();
  const htmlText = text.aiBlockHtml();
  assert.match(htmlText, /class="chat-composer"/);
  assert.match(htmlText, /data-act="aiMode" data-mode="text"[^>]*aria-pressed="true"/);
  assert.match(htmlText, /data-act="aiMode" data-mode="code"[^>]*aria-pressed="false"/);
  assert.match(htmlText, /ответ — в чат/);

  const code = makeLms({ state: { 'yandexLms.aiChatMode': 'code' } });
  const htmlCode = code.aiBlockHtml();
  assert.match(htmlCode, /data-act="aiMode" data-mode="code"[^>]*aria-pressed="true"/);
  assert.match(htmlCode, /ответ — в файл решения/);
  assert.match(htmlCode, /запишет в файл/);
});

test('у задания без файла кода переключателя нет', () => {
  const lms = makeLms({ noFile: true, state: { 'yandexLms.aiChatMode': 'code' } });
  const html = lms.aiBlockHtml();
  assert.doesNotMatch(html, /data-act="aiMode"/);
  assert.match(html, /Спроси наставника/);
});

test('aiSameCode игнорирует хвостовые пробелы и переводы строк', () => {
  const lms = makeLms();
  assert.strictEqual(lms.aiSameCode('a = 1\nprint(a)', 'a = 1  \r\nprint(a)\n\n'), true);
  assert.strictEqual(lms.aiSameCode('a = 1', 'a = 2'), false);
});

test('ответ комментарием: содержимое блока кода остаётся, ограждения снимаются', () => {
  const lms = makeLms();
  const out = lms.aiCommentBlock('print(1)', 'почему не так?', 'Ответ:\n```python\nx = 1\n```\nКонец.');
  assert.match(out, /^print\(1\)\n\n# ── ИИ \d\d:\d\d: почему не так\? ──\n/);
  assert.match(out, /# Ответ:/);
  assert.match(out, /# x = 1/);
  assert.match(out, /# Конец\./);
  assert.doesNotMatch(out, /```/);
});

test('режим «Код» гарантирует изменение файла даже при повторном вопросе', () => {
  const lms = makeLms();
  const base = 'print(1)';
  const answer = '```python\nprint(1)\n```';
  const first = lms.aiCommentBlock(base, 'что не так?', answer);
  assert.notStrictEqual(lms.aiSameCode(base, first), true, 'файл должен измениться');
  // Метка времени делает блок уникальным, поэтому даже два одинаковых
  // ответа подряд не дают «пустую» правку.
  assert.match(first, /# ── ИИ /);
  assert.match(first, /# print\(1\)/);
});

test('пустой ответ всё равно меняет файл', () => {
  const lms = makeLms();
  const out = lms.aiCommentBlock('print(1)', 'вопрос', '   ');
  assert.match(out, /# ── ИИ /);
  assert.match(out, /переформулируйте вопрос/);
  assert.strictEqual(lms.aiSameCode('print(1)', out), false);
});
