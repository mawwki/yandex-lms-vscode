// Дерево заданий: в описании строки — только статус и баллы, без дедлайна.
// Дедлайн остаётся в подсказке при наведении.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
  }
}

const vscodeStub = new Proxy({
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } }
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
const { TaskNode } = require(path.join(root, 'src/tree.js'));

const lesson = { groupId: 54635, courseId: 1721, courseTitle: 'Программирование на Python', label: 'Прерывание циклов', lesson: { id: 13437 } };

function makeTask(extra) {
  return Object.assign({
    id: 88541,
    title: 'Сине-зелёные',
    scoreMax: 25,
    deadline: '2027-01-10T23:30:00+03:00'
  }, extra || {});
}

function fakeLms(status) {
  return { statusOf: () => status || null };
}

test('в описании задания нет дедлайна', () => {
  const node = new TaskNode(fakeLms({ badge: { icon: 'pass', color: 'testing.iconPassed', desc: 'Зачтено' }, score: 25 }), makeTask(), lesson, '');
  assert.strictEqual(node.description, 'Зачтено 25/25');
  assert.doesNotMatch(String(node.description), /до \d/);
  assert.doesNotMatch(String(node.description), /2027/);
});

test('дедлайн остался в подсказке и читается по-русски', () => {
  const node = new TaskNode(fakeLms(null), makeTask(), lesson, '');
  // Дата зависит от часового пояса машины (23:30 +03:00 → может быть 11-е).
  assert.match(String(node.tooltip), /Дедлайн: \d{1,2} января 2027/);
  assert.strictEqual(node.description, undefined);
});

test('без статуса и без баллов описание пустое', () => {
  const node = new TaskNode(fakeLms(null), { id: 1, title: 'Задача', deadline: '2027-01-10T23:30:00+03:00' }, lesson, '');
  assert.strictEqual(node.description, undefined);
});
