// Запасной режим материала: Markdown-предпросмотр и текстовый редактор.
// VS Code подменяется заглушкой — проверяем выбор режима и файлы.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const vscodeStub = new Proxy({
  window: {
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', hide() { }, show() { }, dispose() { } }),
    createOutputChannel: () => ({ appendLine() { }, show() { }, clear() { }, dispose() { } }),
    createWebviewPanel: () => { throw new Error('not in unit test'); },
    createTreeView: () => ({ dispose() { } }),
    tabGroups: { all: [], close: async () => true },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showTextDocument: async () => { },
    setStatusBarMessage: () => { },
    withProgress: async (opts, fn) => fn()
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => { } }),
    registerTextDocumentContentProvider: () => ({ dispose() { } }),
    onDidChangeTextDocument: () => ({ dispose() { } }),
    saveAll: async () => { },
    openTextDocument: async (uri) => ({ uri }),
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
  Uri: {
    file: (p) => ({ fsPath: p, path: p, toString: () => 'file://' + p }),
    joinPath: (a) => a,
    parse: (u) => ({ toString: () => u })
  },
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

function material() {
  return {
    materialId: 5,
    courseTitle: 'Python',
    lessonTitle: 'Циклы',
    detail: {
      title: 'Учебник | Циклы',
      type: 'textbook',
      content: '<h1>Циклы</h1><p>Текст</p><pre><code class="language-python">for i in range(2):\n    print(i)</code></pre>'
    }
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lms-material-'));
}

test('openMaterialMarkdown пишет Markdown, открывает предпросмотр и оставляет одну вкладку', async () => {
  const dir = tempDir();
  const lms = makeLms();
  lms.currentMaterial = material();
  lms.viewDir = () => dir;
  const commands = [];
  vscodeStub.commands.executeCommand = async (cmd) => { commands.push(cmd); };
  vscodeStub.window.tabGroups = {
    all: [{ tabs: [{ input: { viewType: 'mainThreadWebview-markdown.preview' } }] }],
    close: async () => true
  };
  let kept = null;
  lms.closeTabsForMaterial = async (p) => { kept = p; return 0; };

  const ok = await lms.openMaterialMarkdown();

  assert.strictEqual(ok, true);
  assert.ok(commands.includes('markdown.showPreview'), 'вызывается встроенный предпросмотр');
  assert.deepStrictEqual(kept, { viewType: 'markdown.preview' });
  const file = path.join(dir, 'Циклы.md');
  assert.ok(fs.existsSync(file), 'Markdown-файл создан');
  const md = fs.readFileSync(file, 'utf8');
  assert.ok(md.startsWith('# Циклы\n'));
  assert.ok(md.includes('Python › Циклы'));
  assert.ok(md.includes('```python'));
  assert.strictEqual(lms.materialFallback, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openMaterialMarkdown уходит в текст, если предпросмотр не появился', async () => {
  const dir = tempDir();
  const lms = makeLms();
  lms.currentMaterial = material();
  lms.viewDir = () => dir;
  vscodeStub.commands.executeCommand = async () => { };
  vscodeStub.window.tabGroups = { all: [], close: async () => true };
  let textCalls = 0;
  lms.openMaterialText = async () => { textCalls++; return true; };

  const ok = await lms.openMaterialMarkdown();

  assert.strictEqual(ok, true);
  assert.strictEqual(textCalls, 1, 'без вкладки предпросмотра открывается текст');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openMaterialText пишет .txt и закрывает остальные вкладки', async () => {
  const dir = tempDir();
  const lms = makeLms();
  lms.currentMaterial = material();
  lms.viewDir = () => dir;
  let shown = null;
  let keptUri = null;
  vscodeStub.workspace.openTextDocument = async (uri) => ({ uri });
  vscodeStub.window.showTextDocument = async (doc, opts) => { shown = { doc, opts }; };
  lms.closeTabsForUri = async (uri) => { keptUri = uri; return 0; };

  const ok = await lms.openMaterialText();

  assert.strictEqual(ok, true);
  assert.ok(shown, 'текстовый документ показан');
  assert.strictEqual(shown.opts.viewColumn, 1);
  assert.strictEqual(lms.materialTextMode, true);
  assert.strictEqual(lms.materialFallback, true);
  const file = path.join(dir, 'Циклы.txt');
  assert.ok(fs.existsSync(file));
  const txt = fs.readFileSync(file, 'utf8');
  assert.ok(txt.startsWith('Циклы\n'));
  assert.ok(txt.includes('print(i)'));
  assert.ok(!txt.includes('<h1>'));
  assert.strictEqual(keptUri.fsPath, file);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openMaterialPanel не создаёт webview в запасном режиме', async () => {
  const lms = makeLms();
  lms.materialFallback = true;
  let mdCalls = 0;
  lms.openMaterialMarkdown = async () => { mdCalls++; return true; };
  vscodeStub.window.createWebviewPanel = () => { throw new Error('webview не должен создаваться'); };

  await lms.openMaterialPanel('Циклы');

  assert.strictEqual(mdCalls, 1);
});

test('focusMaterialOnly при отсутствии панели открывает запасной режим', async () => {
  const lms = makeLms();
  lms.currentMaterial = material();
  lms.materialFallback = true;
  let mdCalls = 0;
  lms.openMaterialMarkdown = async () => { mdCalls++; return true; };

  await lms.focusMaterialOnly();

  assert.strictEqual(mdCalls, 1);
});
