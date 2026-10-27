// Тесты панели настроек: разметка (экранирование, разделы) и валидация полей.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const updates = {};
const values = {
  apiBase: 'https://lms.yandex.ru',
  folderName: 'yandex-lms',
  pythonPath: 'python',
  pollSeconds: 60,
  taskView: 'panel',
  'ai.autocomplete': true,
  'ai.hedge': true,
  'ai.courseRules': ''
};

const vscodeStub = new Proxy({
  workspace: {
    getConfiguration: () => ({
      get: k => values[k],
      update: async (k, v) => { updates[k] = v; }
    })
  },
  window: {
    createOutputChannel: () => ({ appendLine() { }, show() { }, dispose() { } })
  },
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: a => a, file: p => ({ fsPath: p }) },
  ViewColumn: { Active: -1 },
  commands: { executeCommand: async () => { } }
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
const settings = require(path.join(root, 'src/settings.js'));
const pool = require(path.join(root, 'src/ai/pool.js'));

function fakeLms() {
  return {
    context: { extension: { packageJSON: { version: '9.9.9' } } },
    settingsPanel: { webview: { cspSource: 'https://cdn.example', postMessage: () => { } } },
    output() { return { appendLine() { } }; }
  };
}

test('settingsHtml собирает все разделы и поля', () => {
  const html = settings.settingsHtml(fakeLms());
  for (const s of settings.SECTIONS) {
    assert.ok(html.includes('id="sec-' + s.id + '"'), 'нет раздела ' + s.id);
  }
  assert.ok(html.includes('data-key="ai.hedge"'));
  assert.ok(html.includes('data-key="pollSeconds"'));
  assert.ok(html.includes('yandexLms.apiBase'));
  assert.ok(html.includes('v9.9.9'));
  // CSP и nonce на месте
  assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.ok(!html.includes('${'), 'в шаблоне остались неподставленные выражения');
});

test('settingsHtml экранирует данные ключей', () => {
  pool.poolAdd({
    provider: 'custom',
    baseUrl: 'https://evil.example/v1',
    model: '"><script>alert(1)</script>',
    apiKey: 'sk-test-123456',
    label: '<img src=x onerror=alert(1)>'
  });
  const html = settings.settingsHtml(fakeLms());
  assert.ok(!html.includes('<img src=x'), 'label не экранирован');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'model не экранирован');
  assert.ok(html.includes('&lt;img src=x'), 'ожидалось экранирование label');
});

test('applyUpdate приводит типы и клампит числа', async () => {
  await settings.applyUpdate('pollSeconds', '5');
  assert.strictEqual(updates.pollSeconds, 10);
  await settings.applyUpdate('pollSeconds', 9999);
  assert.strictEqual(updates.pollSeconds, 600);
  await settings.applyUpdate('ai.hedge', false);
  assert.strictEqual(updates['ai.hedge'], false);
  await settings.applyUpdate('apiBase', 'https://lms.yandex.ru///');
  assert.strictEqual(updates.apiBase, 'https://lms.yandex.ru');
});

test('applyUpdate отклоняет мусор', async () => {
  await assert.rejects(() => settings.applyUpdate('pollSeconds', 'abc'), /число/i);
  await assert.rejects(() => settings.applyUpdate('taskView', 'hologram'), /Недопустимое/);
  await assert.rejects(() => settings.applyUpdate('no.such.key', 1), /Неизвестная/);
});

test('applyUpdate не трогает переводы строк в правилах курса', async () => {
  const rules = 'строка 1\n  отступ\n\nстрока 3';
  await settings.applyUpdate('ai.courseRules', rules);
  assert.strictEqual(updates['ai.courseRules'], rules);
});
