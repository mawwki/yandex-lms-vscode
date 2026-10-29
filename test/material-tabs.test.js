// Открытие материала: в рабочей области остаётся только вкладка учебника.
// VS Code подменяется заглушкой — проверяем выбор вкладок и сохранение правок.
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
    saveAll: async () => { },
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

function makeLms() {
  return new Lms({
    secrets: { get: async () => null, store: async () => { }, delete: async () => { } },
    globalState: { get: () => undefined, update: async () => { } },
    extensionUri: { fsPath: root },
    subscriptions: []
  });
}

test('closeTabsForMaterial сохраняет панель материала и закрывает остальные вкладки', async () => {
  const lms = makeLms();
  const materialTab = { input: { viewType: 'yandexLmsMaterial' } };
  const taskTab = { input: { viewType: 'yandexLmsTask' } };
  const codeTab = { input: { uri: { scheme: 'file', fsPath: 'C:/solution.py' } } };
  const calls = [];
  let saved = 0;
  vscodeStub.window.tabGroups = {
    all: [{ tabs: [materialTab, taskTab] }, { tabs: [codeTab] }],
    close: async (tabs, preserveFocus) => { calls.push({ tabs, preserveFocus }); return true; }
  };
  vscodeStub.workspace.saveAll = async () => { saved++; };

  const closed = await lms.closeTabsForMaterial({ viewType: 'yandexLmsMaterial' });

  assert.strictEqual(saved, 1, 'несохранённые правки сохраняются перед закрытием');
  assert.strictEqual(closed, 2);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].tabs, [taskTab, codeTab]);
  assert.strictEqual(calls[0].tabs.includes(materialTab), false);
  assert.strictEqual(calls[0].preserveFocus, true);
});

test('closeTabsForMaterial узнаёт вкладку материала с префиксом mainThreadWebview-', async () => {
  const lms = makeLms();
  const materialTab = { input: { viewType: 'mainThreadWebview-yandexLmsMaterial' } };
  const taskTab = { input: { viewType: 'mainThreadWebview-yandexLmsTask' } };
  let closedTabs = null;
  vscodeStub.window.tabGroups = {
    all: [{ tabs: [materialTab, taskTab] }],
    close: async (tabs) => { closedTabs = tabs; return true; }
  };
  vscodeStub.workspace.saveAll = async () => { };

  const closed = await lms.closeTabsForMaterial({ viewType: 'yandexLmsMaterial' });

  assert.strictEqual(closed, 1);
  assert.deepStrictEqual(closedTabs, [taskTab], 'вкладка материала не должна закрываться');
});

test('closeAllTabs сохраняет задачу и материал с префиксом mainThreadWebview-', async () => {
  const lms = makeLms();
  const taskTab = { input: { viewType: 'mainThreadWebview-yandexLmsTask' } };
  const materialTab = { input: { viewType: 'mainThreadWebview-yandexLmsMaterial' } };
  const codeTab = { input: { uri: { scheme: 'file', fsPath: 'C:/solution.py' } } };
  let closedTabs = null;
  vscodeStub.window.tabGroups = {
    all: [{ tabs: [taskTab, materialTab, codeTab] }],
    close: async (tabs) => { closedTabs = tabs; return true; }
  };
  vscodeStub.workspace.saveAll = async () => { };

  await lms.closeAllTabs();

  assert.deepStrictEqual(closedTabs, [codeTab], 'панели LMS должны остаться');
});

test('closeTabsForMaterial ничего не закрывает без viewType панели материала', async () => {
  const lms = makeLms();
  let closeCalls = 0;
  let saved = 0;
  vscodeStub.window.tabGroups = {
    all: [{ tabs: [{ input: { viewType: 'yandexLmsTask' } }] }],
    close: async () => { closeCalls++; return true; }
  };
  vscodeStub.workspace.saveAll = async () => { saved++; };

  const closed = await lms.closeTabsForMaterial(null);

  assert.strictEqual(closed, 0);
  assert.strictEqual(closeCalls, 0);
  assert.strictEqual(saved, 0);
});

test('openMaterial после загрузки оставляет только панель материала', async () => {
  const lms = makeLms();
  let focused = false;
  const panel = { viewType: 'yandexLmsMaterial', reveal: () => { focused = true; } };
  lms.ensureAuth = async () => true;
  lms.loadMaterial = async () => { lms.materialPanel = panel; return true; };
  lms.closeTabsForMaterial = async (p) => { assert.strictEqual(p, panel); return 1; };

  await lms.openMaterial({
    material: { id: 26269, title: 'Учебник | Циклы' },
    materials: [{ id: 26269 }],
    courseId: 1721,
    lessonId: 13436,
    groupId: 54635
  });

  assert.strictEqual(focused, true, 'панель материала показывается поверх остальных');
});

test('openMaterial не закрывает вкладки, если материал не загрузился', async () => {
  const lms = makeLms();
  let closeCalls = 0;
  lms.ensureAuth = async () => true;
  lms.loadMaterial = async () => false;
  lms.closeTabsForMaterial = async () => { closeCalls++; return 1; };

  await lms.openMaterial({
    material: { id: 1 },
    courseId: 1,
    lessonId: 2,
    groupId: 3
  });

  assert.strictEqual(closeCalls, 0);
});

test('focusMaterialOnly переоткрывает материал, если панель закрылась вместе с вкладками', async () => {
  const lms = makeLms();
  const panel = { viewType: 'yandexLmsMaterial', reveal: () => { } };
  lms.materialPanel = panel;
  lms.currentMaterial = { materialId: 1 };
  vscodeStub.window.tabGroups = { all: [], close: async () => true };
  lms.closeTabsForMaterial = async () => { lms.materialPanel = null; return 1; };
  let renders = 0;
  lms.renderMaterialPanel = () => { renders++; };

  await lms.focusMaterialOnly();

  assert.strictEqual(renders, 1, 'материал должен открыться заново, а не пропасть');
});

test('loadMaterial считает материал открытым, даже если показана кэшированная копия', async () => {
  const lms = makeLms();
  lms.materialPanel = { viewType: 'yandexLmsMaterial' };
  lms.client.material = async () => ({ status: 500, json: null });
  lms.materialCache.set('7', { title: 'Сохранённая копия', content: '<p>Текст</p>' });
  lms.renderMaterialPanel = () => { };
  vscodeStub.window.showWarningMessage = () => { };

  const opened = await lms.loadMaterial({ materialId: 7, lessonId: 1, groupId: 2 });

  assert.strictEqual(opened, true, 'кэш показывается, значит вкладки можно закрывать');
  assert.strictEqual(lms.currentMaterial.detail.title, 'Сохранённая копия');
});
