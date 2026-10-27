// Генератор превью-страниц для скриншотов: строит РЕАЛЬНЫЙ HTML панели
// (taskHtml из src/panel.js, welcome из src/webviews.js) с демо-данными,
// выключает CSP/скрипты и подставляет переменные темы VS Code.
// Запуск: node scripts/preview.js  → пишет .preview/*.html
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ── стаб vscode (как в test/load.test.js, плюс захват webview-панелей) ──
const captured = [];
function makePanelStub() {
  const listeners = { message: [], dispose: [] };
  return {
    title: '',
    viewType: 'stub',
    onDidDispose: fn => listeners.dispose.push(fn),
    webview: {
      cspSource: 'https://test.vscode-cdn.net',
      html: '',
      postMessage: () => { },
      onDidReceiveMessage: fn => listeners.message.push(fn),
      asWebviewUri: u => u
    },
    dispose() { listeners.dispose.forEach(f => f()); }
  };
}

const statusBar = { text: '', tooltip: '', command: '', hide() { }, show() { }, dispose() { } };

// Значения по умолчанию из package.json — чтобы превью выглядело как настоящие
// настройки, а не как пустые поля.
const pkg = require(path.join(__dirname, '..', 'package.json'));
const configDefaults = {};
for (const key of Object.keys(pkg.contributes.configuration.properties)) {
  configDefaults[key.replace(/^yandexLms\./, '')] = pkg.contributes.configuration.properties[key].default;
}

const vscodeStub = new Proxy({
  window: {
    createStatusBarItem: () => Object.assign({}, statusBar),
    createOutputChannel: () => ({ appendLine() { }, show() { }, clear() { }, dispose() { } }),
    createWebviewPanel: (viewType) => {
      const p = makePanelStub();
      p.viewType = viewType;
      captured.push(p);
      return p;
    },
    createTreeView: () => ({ dispose() { } }),
    tabGroups: { all: [], close: async () => { } }
  },
  workspace: {
    getConfiguration: () => ({ get: k => configDefaults[k], update: async () => { } }),
    registerTextDocumentContentProvider: () => ({ dispose() { } }),
    textDocuments: []
  },
  commands: { registerCommand: () => ({ dispose() { } }), executeCommand: async () => { } },
  languages: { registerInlineCompletionItemProvider: () => ({ dispose() { } }) },
  env: { openExternal: async () => { } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } },
  ThemeIcon: class { constructor() { } },
  ThemeColor: class { constructor() { } },
  TreeItem: class { constructor(label) { this.label = label; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Two: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: { file: p => ({ fsPath: p }), joinPath: a => a, parse: u => ({}) },
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
const panelMod = require(path.join(root, 'src/panel.js'));
const webviews = require(path.join(root, 'src/webviews.js'));
const { Lms } = require(path.join(root, 'src/lms.js'));

// ── демо-данные ──
const detail = {
  id: 4213,
  title: 'Сумма двух чисел',
  scoreMax: 100,
  deadline: '2026-11-01',
  description: [
    '<p>Даны два целых числа <code>a</code> и <code>b</code>, записанные в одной строке через пробел. Выведите их сумму.</p>',
    '<h3>Формат ввода</h3><p>Одна строка с двумя целыми числами, разделёнными пробелом:</p>',
    '<pre><code>3 4</code></pre>',
    '<h3>Формат вывода</h3><p>Одно целое число — сумма <code>a + b</code>.</p>',
    '<blockquote>Обратите внимание: числа могут быть отрицательными и превышать 10<sup>9</sup>.</blockquote>',
    '<table><tr><th>Ввод</th><th>Вывод</th></tr><tr><td>3 4</td><td>7</td></tr><tr><td>-5 12</td><td>7</td></tr></table>'
  ].join('\n')
};

function makeLms() {
  const context = {
    secrets: { get: async () => null, store: async () => { }, delete: async () => { } },
    globalState: { get: () => undefined, update: async () => { } },
    extensionUri: { fsPath: root },
    subscriptions: []
  };
  const lms = new Lms(context);
  lms.detailCache.set('4213', detail);
  lms.currentTask = {
    taskId: 4213, solutionId: 90210, groupId: 7, compilerId: 'python-3.11',
    filePath: 'C:\\work\\yandex-lms\\Программирование на Python\\Ввод и вывод\\4213-сумма-двух-чисел.py',
    isMarkers: false, problemDefinition: null, markersQuestion: '',
    taskTitle: 'Сумма двух чисел',
    courseTitle: 'Программирование на Python', lessonTitle: 'Ввод и вывод',
    courseId: 101, lessonId: 202, taskUrl: 'https://lms.yandex.ru/',
    verdictInfo: { id: 555, verdict: 'wrong-answer' }
  };
  lms.currentStatementHtml = detail.description;
  lms.aiHints = [
    '1. Прочитай строку целиком через `input()`.',
    '2. Разбей её на две части методом **split()**.',
    '3. Каждую часть преврати в число через `int()`.',
    '4. Сложи и выведи результат через `print()`.'
  ].join('\n');
  lms.aiNote = [
    '- **Вердикт:** Есть ошибки',
    '- **Что не так:** строка 2 — `input()` возвращает строку, а не числа; складываются строки, поэтому для «3 4» получается `34`.',
    '- **Как исправить:** разбей строку и приведи обе части к числу перед сложением.'
  ].join('\n');
  lms.contestLogs = {
    verdict: 'wrong-answer', usedTime: 34, usedMemory: 8420, testNumber: 3,
    testInfo: { 'Ввод': '3 4', 'Ожидалось': '7', 'Получено': '34' }
  };
  lms.pep8Report = {
    tool: 'pycodestyle',
    errors: [{ line: 2, col: 1, code: 'E225', text: 'missing whitespace around operator' }]
  };
  lms.aiLessons = [
    'LMS: срезы и индексы строк будут немного позже — используйте цикл',
    'LMS: не забывайте перевод строки после вывода'
  ];
  // Демо-переписка в чате: проверяем вёрстку лога и строки ввода.
  lms.aiChatMsgs(4213).push(
    { role: 'user', text: 'Почему для green=5, blue=1 выходит 500?', ts: 0 },
    {
      role: 'ai',
      text: '**Проблема:** в примере из условия не совпадает с логикой.\n\n' +
        '- Если `green=5`, `blue=1` → `(5 * 100 + 1 - 1) // 1 = 500`.\n\n' +
        'Ваш код правильный, но пример в условии неверен.',
      ts: 0
    }
  );
  return lms;
}

// ── переменные тем VS Code ──
const DARK = `
  :root {
    --vscode-font-family: 'Segoe UI', system-ui, sans-serif;
    --vscode-editor-font-family: Consolas, 'Courier New', monospace;
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1f1f1f;
    --vscode-sideBar-background: rgba(127,127,127,0.06);
    --vscode-panel-border: #2b2b2b;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-border: transparent;
    --vscode-button-secondaryBackground: #313131;
    --vscode-button-secondaryForeground: #cccccc;
    --vscode-textBlockQuote-background: rgba(127,127,127,0.12);
    --vscode-textCodeBlock-background: rgba(127,127,127,0.15);
    --vscode-list-hoverBackground: rgba(127,127,127,0.10);
    --vscode-testing-iconPassed: #3fb950;
    --vscode-testing-iconFailed: #f14c4c;
    --vscode-errorForeground: #f85149;
    --vscode-charts-blue: #3794ff;
    --vscode-charts-green: #3fb950;
    --vscode-charts-red: #f14c4c;
    --vscode-charts-orange: #d18616;
    --vscode-charts-purple: #b180d7;
    --vscode-charts-yellow: #d7ba7d;
    --vscode-focusBorder: #0078d4;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-list-activeSelectionBackground: #04395e;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-notifications-background: #252526;
    --vscode-notifications-foreground: #cccccc;
  }`;
const LIGHT = `
  :root {
    --vscode-font-family: 'Segoe UI', system-ui, sans-serif;
    --vscode-editor-font-family: Consolas, 'Courier New', monospace;
    --vscode-foreground: #3b3b3b;
    --vscode-editor-background: #ffffff;
    --vscode-sideBar-background: rgba(0,0,0,0.03);
    --vscode-panel-border: #e5e5e5;
    --vscode-button-background: #005fb8;
    --vscode-button-foreground: #ffffff;
    --vscode-button-border: transparent;
    --vscode-button-secondaryBackground: #e4e4e4;
    --vscode-button-secondaryForeground: #3b3b3b;
    --vscode-textBlockQuote-background: rgba(127,127,127,0.10);
    --vscode-textCodeBlock-background: rgba(127,127,127,0.10);
    --vscode-list-hoverBackground: rgba(0,0,0,0.05);
    --vscode-testing-iconPassed: #1a7f37;
    --vscode-testing-iconFailed: #cf222e;
    --vscode-errorForeground: #d1242f;
    --vscode-charts-blue: #1a85ff;
    --vscode-charts-green: #1a7f37;
    --vscode-charts-red: #cf222e;
    --vscode-charts-orange: #bc4c00;
    --vscode-charts-purple: #8250df;
    --vscode-charts-yellow: #bf8803;
    --vscode-focusBorder: #005fb8;
    --vscode-input-background: #ffffff;
    --vscode-input-foreground: #3b3b3b;
    --vscode-input-border: #cecece;
    --vscode-list-activeSelectionBackground: #e4e6f1;
    --vscode-list-activeSelectionForeground: #000000;
    --vscode-notifications-background: #f8f8f8;
    --vscode-notifications-foreground: #3b3b3b;
  }`;

function finalize(html, theme) {
  let out = String(html);
  out = out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  const vars = theme === 'light' ? LIGHT : DARK;
  const bg = theme === 'light' ? '#ffffff' : '#1f1f1f';
  const banner = theme === 'light' ? '' : '';
  return out.replace('</head>', `<style>${vars}\nbody { background: ${bg}; padding-bottom: 40px; } .preview-note { position: fixed; right: 10px; bottom: 10px; font-size: 11px; opacity: .45; font-family: sans-serif; }</style>${banner}</head>`)
    .replace('</body>', '<div class="preview-note">превью · тема ' + (theme === 'light' ? 'Light+' : 'Dark+') + '</div></body>');
}

const outDir = path.join(root, '.preview');
fs.mkdirSync(outDir, { recursive: true });

// 1-2: панель задачи, тёмная и светлая
const lms = makeLms();
const taskHtml = panelMod.taskHtml(lms, lms.currentTask, detail);
fs.writeFileSync(path.join(outDir, 'task-dark.html'), finalize(taskHtml, 'dark'), 'utf8');
fs.writeFileSync(path.join(outDir, 'task-light.html'), finalize(taskHtml, 'light'), 'utf8');

// 2b: тот же экран в режиме «Код» — переключатель в строке ввода активен,
// подсказка и placeholder меняются.
const lmsC = makeLms();
lmsC._aiChatMode = 'code';
fs.writeFileSync(path.join(outDir, 'task-code.html'), finalize(panelMod.taskHtml(lmsC, lmsC.currentTask, detail), 'dark'), 'utf8');

// 2c: зачтённое решение — LMS отдаёт вердикт «ok» строчными, плашка зелёная.
const lmsOk = makeLms();
lmsOk.currentTask.verdictInfo = { id: 557, verdict: 'ok' };
lmsOk.contestLogs = null;
lmsOk.pep8Report = null;
fs.writeFileSync(path.join(outDir, 'task-ok.html'), finalize(panelMod.taskHtml(lmsOk, lmsOk.currentTask, detail), 'dark'), 'utf8');

// 3: задание с вариантами ответа (чистая панель: без ИИ-блоков и подробностей)
const lmsM = makeLms();
lmsM.currentTask.isMarkers = true;
lmsM.currentTask.filePath = null;
lmsM.currentTask.verdictInfo = null;
lmsM.currentTask.taskTitle = 'Результат выражения';
lmsM.currentStatementHtml = '';
lmsM.aiHints = null;
lmsM.aiNote = null;
lmsM.contestLogs = null;
lmsM.pep8Report = null;
lmsM.aiLessons = [];
lmsM.markersProblem = {
  markup: {
    layout: [
      { kind: 'text', content: { text: '<p>Сколько выведет эта программа?</p>' } },
      { content: { id: 'm1' } }
    ]
  },
  markers: {
    m1: {
      type: 'radio',
      content: { options: { choices: [{ value: '1', text: '6' }, { value: '0', text: '8' }, { value: '2', text: '4' }] } }
    }
  }
};
lmsM.fetchProblemDefinition = async () => ({ data: lmsM.markersProblem, problem: lmsM.markersProblem, source: 'demo' });
lmsM.currentTask.problemDefinition = lmsM.markersProblem;
const markersHtml = panelMod.taskHtml(lmsM, lmsM.currentTask, { title: 'Результат выражения' });
fs.writeFileSync(path.join(outDir, 'markers.html'), finalize(markersHtml, 'dark'), 'utf8');

// 4: панель с ошибкой выполнения и раскрытой причиной (клик по плашке)
const lmsE = makeLms();
lmsE.currentTask.verdictInfo = { id: 556, verdict: 'runtime-error' };
lmsE.contestLogs = {
  verdict: 'runtime-error', usedTime: 41, usedMemory: 9216, testNumber: 4,
  compileLog: '',
  testInfo: {
    'Ввод': '3 4',
    'Ошибка': 'Traceback (most recent call last):\n  File "solution.py", line 3, in <module>\n    print(a + b)\nTypeError: unsupported operand type(s) for +: \'str\' and \'str\''
  }
};
lmsE.verdictReasonOpen = String(lmsE.currentTask.taskId);
const errorHtml = panelMod.taskHtml(lmsE, lmsE.currentTask, detail);
fs.writeFileSync(path.join(outDir, 'task-error.html'), finalize(errorHtml, 'dark'), 'utf8');
fs.writeFileSync(path.join(outDir, 'task-error-light.html'), finalize(errorHtml, 'light'), 'utf8');

// 5-6: welcome и QR (через заглушку createWebviewPanel)
webviews.welcomeWebview({ extensionUri: { fsPath: root } }).then(() => {
  fs.writeFileSync(path.join(outDir, 'welcome.html'), finalize(captured[captured.length - 1].webview.html, 'dark'), 'utf8');
  console.log('OK:', fs.readdirSync(outDir).join(', '));
}).catch(e => { console.error('welcome failed:', e); process.exit(1); });

// 7-8: панель настроек — с демо-ключами, включая «остывающий» и локальный CLI
const settingsMod = require(path.join(root, 'src/settings.js'));
const poolMod = require(path.join(root, 'src/ai/pool.js'));
poolMod.poolAdd({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', apiKey: 'sk-or-v1-9f4c1a2b7d6e5f4a3b2c1d0e', label: 'OpenRouter' });
poolMod.poolAdd({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder', apiKey: '', label: 'Ollama (локально)' });
poolMod.poolAdd({ provider: 'opencode', bin: 'opencode', model: 'opencode/big-pickle', apiKey: '', label: 'OpenCode CLI' });
const demoEntries = poolMod.aiEntries();
if (demoEntries[0]) poolMod.aiMarkOk(demoEntries[0], 1240);
if (demoEntries[1]) poolMod.aiMarkFail(demoEntries[1], { status: 429, message: 'rate limit: 20 req/min exceeded, retry later' });

const lmsS = makeLms();
lmsS.settingsPanel = { webview: { cspSource: 'https://test.vscode-cdn.net', postMessage: () => { } } };
const settingsHtml = settingsMod.settingsHtml(lmsS);
fs.writeFileSync(path.join(outDir, 'settings-dark.html'), finalize(settingsHtml, 'dark'), 'utf8');
fs.writeFileSync(path.join(outDir, 'settings-light.html'), finalize(settingsHtml, 'light'), 'utf8');

// Сырая версия (со скриптами) — для проверки кликов в headless-браузере.
fs.writeFileSync(
  path.join(outDir, 'settings-raw.html'),
  String(settingsHtml)
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '')
    .replace('</head>', `<style>${DARK}</style></head>`),
  'utf8'
);

fs.writeFileSync(path.join(outDir, 'task-dark.html'), finalize(taskHtml, 'dark'), 'utf8');
