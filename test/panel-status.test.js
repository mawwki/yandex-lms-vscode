// Плашка статуса в панели: вердикт «ok» от LMS должен быть зелёным «Зачтено»,
// а не красной плашкой с сырым «ok».
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return new Proxy({}, { get: () => function stub() { } });
  return origLoad.apply(this, arguments);
};

const root = path.join(__dirname, '..');
const { taskHtml } = require(path.join(root, 'src/panel.js'));

function fakeLms() {
  return {
    detailCache: new Map(),
    currentStatementHtml: '<p>Условие</p>',
    contestLogsData: () => null,
    contestLogsHtml: () => '',
    examplesHtml: () => '',
    pep8Html: () => '',
    markersPanelHtml: () => '',
    aiStateHtml: () => 'ИИ: тест',
    aiBlockHtml: () => '<div class="chat-log"></div>'
  };
}

function task(verdict) {
  return {
    taskId: 1,
    taskTitle: 'Сине-зелёные',
    isMarkers: false,
    filePath: 'C:\\work\\4213.py',
    verdictInfo: verdict === undefined ? null : { id: 1, verdict }
  };
}

test('вердикт ok — зелёная плашка «Зачтено»', () => {
  const html = taskHtml(fakeLms(), task('ok'), { description: '<p>x</p>' });
  assert.match(html, /class="pill ok"[^>]*><i class="dot"><\/i>Зачтено/);
  assert.doesNotMatch(html, /pill fail/);
  // Блок «почему не зачтено» для зачтённого решения не рисуется
  // (в CSS класс есть всегда — проверяем именно элемент).
  assert.doesNotMatch(html, /id="verdict-reason"/);
});

test('вердикт OK (старый регистр) — тоже зелёная плашка', () => {
  const html = taskHtml(fakeLms(), task('OK'), { description: '<p>x</p>' });
  assert.match(html, /class="pill ok"/);
});

test('вердикт wrong-answer — красная кликабельная плашка', () => {
  const html = taskHtml(fakeLms(), task('wrong-answer'), { description: '<p>x</p>' });
  assert.match(html, /pill fail clickable/);
  assert.match(html, /Неверный ответ/);
});

test('нет вердикта — «не отправлено»', () => {
  const html = taskHtml(fakeLms(), task(undefined), { description: '<p>x</p>' });
  assert.match(html, /pill wait/);
  assert.match(html, /не отправлено/);
});

test('решение отправлено, вердикта ещё нет — «На проверке»', () => {
  const html = taskHtml(fakeLms(), task(''), { description: '<p>x</p>' });
  assert.match(html, /pill wait/);
  assert.match(html, /На проверке/);
  assert.doesNotMatch(html, /не отправлено/);
});

test('статус uploaded из карты дерева — «На проверке» и в панели', () => {
  const lms = fakeLms();
  lms.statusMap = new Map([['1', {
    type: 'uploaded',
    verdict: '',
    badge: { icon: 'sync', color: 'charts.yellow', desc: 'На проверке' }
  }]]);
  const html = taskHtml(lms, task(undefined), { description: '<p>x</p>' });
  assert.match(html, /На проверке/);
  assert.doesNotMatch(html, /не отправлено/);
});

test('статус accepted из карты дерева — «Зачтено» в панели', () => {
  const lms = fakeLms();
  lms.statusMap = new Map([['1', { type: 'accepted', verdict: 'ok' }]]);
  const html = taskHtml(lms, task(undefined), { description: '<p>x</p>' });
  assert.match(html, /class="pill ok"/);
  assert.doesNotMatch(html, /не отправлено/);
});
