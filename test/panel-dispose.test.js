// Закрытие панели задачи вкладкой (например, при открытии учебника) не должно
// оставлять lms.panel ссылкой на уже уничтоженный webview — иначе следующая
// задача не откроется.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const vscodeStub = new Proxy({
  workspace: {
    getConfiguration: () => ({ get: () => undefined, update: async () => { } })
  }
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
const { attachPanel, attach } = require(path.join(root, 'src/panel.js'));

test('attachPanel очищает lms.panel при закрытии и не читает viewType после dispose', () => {
  let disposeCb = null;
  const panel = {
    _disposed: false,
    get viewType() {
      if (this._disposed) throw new Error('Webview is disposed');
      return 'yandexLmsTask';
    },
    onDidDispose(cb) { disposeCb = cb; },
    webview: { onDidReceiveMessage() { } }
  };
  const lms = { panel };
  attachPanel(panel, lms);

  panel._disposed = true;
  assert.doesNotThrow(() => disposeCb());
  assert.strictEqual(lms.panel, null);
});

test('showTaskPanel пересоздаёт панель, если ссылка ведёт на закрытый webview', async () => {
  class FakeLms { }
  attach(FakeLms);
  const lms = new FakeLms();
  lms.currentTask = { taskId: 1, taskTitle: 'Задача' };
  lms.panel = {
    set title(value) { throw new Error('Webview is disposed'); }
  };
  lms.output = () => ({ appendLine() { } });
  lms.closeLmsViewTabs = async () => { };
  let reopened = 0;
  lms.openPanel = () => { reopened++; };

  await lms.showTaskPanel({ title: 'Задача' });

  assert.strictEqual(lms.panel, null);
  assert.strictEqual(reopened, 1);
});
