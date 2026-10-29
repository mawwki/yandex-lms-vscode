// Smoke-тест: весь граф модулей загружается, класс Lms создаётся.
// Ловит опечатки в require/экспортах между модулями без запуска VS Code.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const statusBar = { text: '', tooltip: '', command: '', hide() { }, show() { }, dispose() { } };
const vscodeStub = new Proxy({
  window: {
    createStatusBarItem: () => Object.assign({}, statusBar),
    createOutputChannel: () => ({ appendLine() { }, show() { }, clear() { }, dispose() { } }),
    createWebviewPanel: () => { throw new Error('not in smoke test'); },
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

test('все модули загружаются и экспортируют ожидаемое', () => {
  const lmsMod = require(path.join(root, 'src/lms.js'));
  assert.strictEqual(typeof lmsMod.Lms, 'function');
  const panel = require(path.join(root, 'src/panel.js'));
  assert.strictEqual(typeof panel.attach, 'function');
  const markers = require(path.join(root, 'src/markers.js'));
  assert.strictEqual(typeof markers.attach, 'function');
  const features = require(path.join(root, 'src/ai/features.js'));
  assert.strictEqual(typeof features.attach, 'function');
  const chat = require(path.join(root, 'src/ai/chat.js'));
  assert.strictEqual(typeof chat.aiChat, 'function');
  const pool = require(path.join(root, 'src/ai/pool.js'));
  assert.strictEqual(typeof pool.initPool, 'function');
  const oc = require(path.join(root, 'src/ai/opencode.js'));
  assert.strictEqual(typeof oc.runOpenCode, 'function');
  const client = require(path.join(root, 'src/client.js'));
  assert.strictEqual(typeof client.LmsClient, 'function');
  const material = require(path.join(root, 'src/material.js'));
  assert.strictEqual(typeof material.attach, 'function');
  assert.strictEqual(typeof material.materialHtml, 'function');
  const highlight = require(path.join(root, 'src/highlight.js'));
  assert.strictEqual(typeof highlight.highlightPython, 'function');
  assert.strictEqual(typeof highlight.highlightCodeBlocks, 'function');
});

test('Lms создаётся, методы модулей подключены к прототипу', () => {
  const { Lms } = require(path.join(root, 'src/lms.js'));
  const context = {
    secrets: { get: async () => null, store: async () => { }, delete: async () => { } },
    globalState: { get: () => undefined, update: async () => { } },
    extensionUri: { fsPath: root },
    subscriptions: []
  };
  const lms = new Lms(context);
  // из panel.js
  assert.strictEqual(typeof lms.showTaskPanel, 'function');
  // из markers.js
  assert.strictEqual(typeof lms.markersAnswer, 'function');
  // из ai/features.js
  assert.strictEqual(typeof lms.aiRun, 'function');
  assert.strictEqual(typeof lms.aiAddOpenCode, 'function');
  // из diagCommands.js
  assert.strictEqual(typeof lms.scanImages, 'function');
  // из material.js
  assert.strictEqual(typeof lms.openMaterial, 'function');
  assert.strictEqual(typeof lms.openLessonMaterials, 'function');
  assert.strictEqual(typeof lms.materialInBrowser, 'function');
  assert.strictEqual(typeof lms.focusMaterialOnly, 'function');
  assert.ok(lms.materialCache instanceof Map);
  // собственные
  assert.strictEqual(typeof lms.closeTabsForMaterial, 'function');
  assert.strictEqual(typeof lms.submitCurrent, 'function');
});
