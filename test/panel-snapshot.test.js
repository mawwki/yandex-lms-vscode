// Снимок условия для Объектива: панель должна подключать html2canvas и
// разрешать его локальный ресурс в CSP. Скрипт проверяем на синтаксис.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const root = path.join(__dirname, '..');
const vscodeStub = new Proxy({
  window: {},
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  Uri: {
    joinPath: (a, ...rest) => {
      let p = a.fsPath || a;
      for (const r of rest) p = path.join(p, r);
      return { fsPath: p, path: p };
    }
  },
  ViewColumn: { One: 1 },
  ThemeIcon: class { }
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

const { taskHtml } = require(path.join(root, 'src/panel.js'));

function lmsWithWebview() {
  return new Proxy({
    statusMap: new Map(),
    detailCache: new Map(),
    aiChatLog: new Map(),
    aiChatDrafts: new Map(),
    currentStatementHtml: '<p>Условие</p>',
    output: () => ({ appendLine() { } }),
    context: { extensionUri: { fsPath: root } },
    panel: {
      webview: {
        cspSource: 'vscode-webview://test',
        asWebviewUri: (u) => ({ toString: () => 'vscode-webview://test/' + path.basename(u.fsPath) })
      }
    },
    contestLogsData: () => null,
    contestLogsHtml: () => '',
    examplesHtml: () => '',
    pep8Html: () => '',
    markersPanelHtml: () => '',
    aiStateHtml: () => '',
    aiBlockHtml: () => ''
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return function stub() { };
    }
  });
}

const task = { taskId: 1, taskTitle: 'Снимок', isMarkers: false, verdictInfo: null };

test('панель подключает html2canvas до основного скрипта и разрешает CSP', () => {
  const html = taskHtml(lmsWithWebview(), task, { description: '<p>Условие</p>' });
  assert.match(html, /script-src 'nonce-[a-f0-9]+' vscode-webview:\/\/test;/);
  assert.ok(html.includes('src="vscode-webview://test/html2canvas.min.js"'), 'локальный html2canvas подключён');
  const lib = html.indexOf('html2canvas.min.js');
  const main = html.indexOf('const vscode = acquireVsCodeApi()');
  assert.ok(lib > 0 && main > lib, 'библиотека загружается раньше панели');
});

test('без webview панель не вставляет пустой src и остаётся рабочей', () => {
  const lms = lmsWithWebview();
  lms.panel = null;
  const html = taskHtml(lms, task, { description: '<p>Условие</p>' });
  assert.ok(!html.includes('html2canvas.min.js'));
  assert.ok(!html.includes('src=""'));
});

test('скрипт панели синтаксически корректен', () => {
  const html = taskHtml(lmsWithWebview(), task, { description: '<p>Условие</p>' });
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  const code = scripts[scripts.length - 1][1];
  assert.doesNotThrow(() => new Function(code));
  assert.ok(code.includes('html2canvas(box'), 'снимок идёт через html2canvas');
  assert.ok(!code.includes('<foreignObject'), 'SVG/foreignObject больше не используется');
});
