// Ведомость оценок: разбор lessonTasks, итоги по баллам, HTML панели
// и запасной текстовый вывод. Стаб vscode — как в test/tree.test.js.
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
  ThemeColor: class { constructor(id) { this.id = id; } },
  window: {},
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
const util = require(path.join(root, 'src/util.js'));
const grades = require(path.join(root, 'src/grades.js'));

const NOW = new Date('2026-10-29T12:00:00+03:00').getTime();

// ── утилиты прогресса ──

test('дедлайн: осталось три дня', () => {
  const d = util.deadlineInfo('2026-11-01T10:00:00+03:00', NOW);
  assert.strictEqual(d.state, 'soon');
  assert.match(d.hint, /^осталось 3 дня$/);
});

test('дедлайн: просрочено и далеко вперёд', () => {
  const past = util.deadlineInfo('2026-10-20T10:00:00+03:00', NOW);
  assert.strictEqual(past.state, 'overdue');
  assert.match(past.hint, /просрочено на 9 дней/);
  const far = util.deadlineInfo('2027-01-10T23:30:00+03:00', NOW);
  assert.strictEqual(far.state, 'open');
  assert.strictEqual(far.hint, '');
  assert.match(far.when, /^\d{1,2} января 2027 г\.$/);
  assert.deepStrictEqual(util.deadlineInfo(null), { state: 'none', when: '', hint: '', days: null });
});

test('плюрализация дней по-русски', () => {
  assert.strictEqual(util.ruPlural(1, 'день', 'дня', 'дней'), 'день');
  assert.strictEqual(util.ruPlural(2, 'день', 'дня', 'дней'), 'дня');
  assert.strictEqual(util.ruPlural(5, 'день', 'дня', 'дней'), 'дней');
  assert.strictEqual(util.ruPlural(11, 'день', 'дня', 'дней'), 'дней');
  assert.strictEqual(util.ruPlural(21, 'день', 'дня', 'дней'), 'день');
});

test('полоска прогресса: пустой знаменатель — пустая строка', () => {
  assert.strictEqual(util.progressBar(3, 10, 8), '▰▰▱▱▱▱▱▱');
  assert.strictEqual(util.progressBar(10, 10, 4), '▰▰▰▰');
  assert.strictEqual(util.progressBar(0, 0, 8), '');
});

test('flattenLessonTasks разбирает и группы по тегу, и плоский список', () => {
  const grouped = util.flattenLessonTasks([
    { id: 1, type: 'classwork', tasks: [{ id: 10, title: 'A' }, { id: 11, title: 'B' }] },
    { id: 2, type: 'homework', tasks: [{ id: 12, title: 'C' }] }
  ]);
  assert.strictEqual(grouped.length, 3);
  assert.deepStrictEqual(grouped.map(x => x.typeName), ['classwork', 'classwork', 'homework']);
  const flat = util.flattenLessonTasks([{ id: 20, title: 'X' }]);
  assert.strictEqual(flat.length, 1);
  assert.strictEqual(flat[0].task.id, 20);
  assert.deepStrictEqual(util.flattenLessonTasks(null), []);
});

test('gradeRow и итоги: зачтено, баллы, просрочка обязательных', () => {
  const PAST = '2026-10-20T10:00:00+03:00';
  const mk = (id, type, score, max, extra) => Object.assign({
    id, title: 'Задача ' + id, scoreMax: max, deadline: PAST,
    solution: { id: id * 10, score, status: { type } }
  }, extra || {});
  // Статус передаём такой же, как его видит дерево: lms.statusOf(task).
  const statusOf = (t) => ({
    type: t.solution.status.type,
    verdict: '',
    score: t.solution.score,
    badge: util.statusBadge(t.solution.status.type, '')
  });
  const tasks = [
    mk(1, 'accepted', 10, 10),
    mk(2, 'uploaded', 0, 10),
    mk(3, 'rework', 0, 10),
    mk(4, 'new', 0, 10),
    mk(5, 'accepted', 5, 5, { isOptional: true })
  ];
  const rows = tasks.map(t => util.gradeRow(t, statusOf(t), NOW));
  assert.deepStrictEqual(rows.map(r => r.state), ['passed', 'pending', 'rework', 'unsolved', 'passed']);
  assert.strictEqual(rows[0].label, 'Зачтено');
  assert.strictEqual(rows[4].optional, true);
  const s = util.summarizeGrades(rows);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.passed, 2);
  assert.strictEqual(s.optional, 1);
  assert.strictEqual(s.required, 4);
  assert.strictEqual(s.overdue, 3, 'просрочены только незачтённые обязательные');
  assert.strictEqual(s.score, 15);
  assert.strictEqual(s.scoreMax, 45);
  assert.strictEqual(util.progressLine(s, 6), '▰▰▱▱▱▱ 2/5 · 15/45 б. · просрочено 3');
});

test('summarizeGrades не падает на мусоре', () => {
  const s = util.summarizeGrades([null, undefined, {}]);
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.passed, 0);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(util.progressLine(util.summarizeGrades([])), '');
});

// ── сборка ведомости ──

function fakeLms(lessons, tasksByLesson) {
  return {
    client: {
      lessons: async () => ({ status: 200, json: lessons }),
      lessonTasks: async (courseId, lessonId) => ({
        status: 200,
        json: tasksByLesson[String(lessonId)] || []
      })
    },
    courseLabel: () => 'Программирование на Python — Сургут',
    statusOf: (task) => (task.solution ? {
      type: task.solution.status.type,
      verdict: '',
      score: task.solution.score,
      badge: util.statusBadge(task.solution.status.type, '')
    } : null)
  };
}

const T = (id, type, score, max, extra) => Object.assign({
  id, title: 'Задача ' + id, shortTitle: 'Z' + id, scoreMax: max,
  solution: { id: id * 7, score, status: { type } },
  deadline: '2026-10-20T10:00:00+03:00'
}, extra || {});

test('collectCourse: уроки → строки → общие итоги, один запрос на урок', async () => {
  const lms = fakeLms(
    [{ id: 13424, title: 'Знакомство', numTasks: 2 }, { id: 13437, title: 'Циклы', numTasks: 2 }],
    {
      13424: [{ id: 1, type: 'classwork', tasks: [T(101, 'accepted', 10, 10), T(102, 'new', 0, 5)] }],
      13437: [{ id: 2, type: 'homework', tasks: [T(103, 'uploaded', 0, 5), T(104, 'accepted', 25, 25)] }]
    }
  );
  const snap = await grades.collectCourse(lms, { id: 1721, group: { id: 54635 }, rating: 7.0089 });
  assert.strictEqual(snap.title, 'Программирование на Python — Сургут');
  assert.strictEqual(snap.courseId, 1721);
  assert.strictEqual(snap.groupId, 54635);
  assert.strictEqual(snap.rating, 7, 'рейтинг округлён, а не 7.008899143045485');
  assert.strictEqual(snap.lessons.length, 2);
  assert.strictEqual(snap.summary.total, 4);
  assert.strictEqual(snap.summary.passed, 2);
  assert.strictEqual(snap.summary.pending, 1);
  assert.strictEqual(snap.summary.score, 35);
  assert.strictEqual(snap.summary.scoreMax, 45);
  assert.strictEqual(snap.lessons[0].rows[0].state, 'passed');
  assert.strictEqual(snap.lessons[0].rows[0].typeName, 'classwork');
  assert.strictEqual(snap.lessons[1].rows[1].title, 'Задача 104');
});

test('collectCourse не плодит запросы сверх одного на урок', async () => {
  let tasksCalls = 0;
  const lms = fakeLms(
    [{ id: 1, title: 'A' }, { id: 2, title: 'B' }, { id: 3, title: 'C' }],
    { 1: [], 2: [], 3: [] }
  );
  lms.client.lessonTasks = async () => { tasksCalls++; return { status: 200, json: [] }; };
  await grades.collectCourse(lms, { id: 5, group: { id: 6 } });
  assert.strictEqual(tasksCalls, 3);
});

test('collectCourse помнит сбой урока и не молчит о нём', () => {
  const lms = {
    client: {
      lessons: async () => ({ status: 200, json: [{ id: 1, title: 'Урок' }] }),
      lessonTasks: async () => ({ status: 500, json: null })
    },
    courseLabel: () => 'Курс',
    statusOf: () => null
  };
  return grades.collectCourse(lms, { id: 9, group: { id: 1 } }).then(snap => {
    assert.strictEqual(snap.lessons[0].error, 'HTTP 500');
    const html = grades.gradesHtml(snap, { nonce: 'x', csp: '' });
    assert.match(html, /Не загрузились задания: HTTP 500/);
  });
});

// ── панель ──

function sampleSnap() {
  const lms = fakeLms(
    [{ id: 13424, title: 'Знакомство со средой' }],
    {
      13424: [{
        id: 1, type: 'classwork',
        tasks: [T(101, 'accepted', 10, 10), T(102, 'rework', 0, 5, { isOptional: true }), T(103, 'new', 0, 5)]
      }]
    }
  );
  let snap;
  return grades.collectCourse(lms, { id: 1721, group: { id: 54635 } }).then(s => {
    snap = s;
    snap.ts = NOW;
    return snap;
  });
}

test('gradesHtml: карточки, фильтр и корректный скрипт', async () => {
  const snap = await sampleSnap();
  const html = grades.gradesHtml(snap, { nonce: 'abc123', csp: 'vscode-webview://x' });
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /Зачтено/);
  assert.match(html, /1\/3/);
  assert.match(html, /data-filter="problem"/, 'переключатель «Только проблемы»');
  assert.match(html, /st-passed/, 'зачтённая строка');
  assert.match(html, /st-unsolved/, 'не начатая строка');
  assert.match(html, /data-act="openTask"/, 'строка открывается кликом');
  assert.ok(!/undefined/.test(html), 'в разметке нет лезущих undefined');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.doesNotThrow(() => new Function(scripts[scripts.length - 1][1]));
});

test('gradesHtml: extra-символы в заголовках экранируются', async () => {
  const snap = await sampleSnap();
  snap.lessons[0].rows[0].title = '<img src=x onerror=alert(1)>';
  const html = grades.gradesHtml(snap, { nonce: 'a', csp: '' });
  assert.ok(!html.includes('<img src=x onerror'));
  assert.match(html, /&lt;img src=x onerror/);
});

test('gradesText: текстовая копия ведомости для сломанного webview', async () => {
  const snap = await sampleSnap();
  const text = grades.gradesText(snap);
  assert.match(text, /Оценки — Программирование на Python/);
  assert.match(text, /Зачтено: 1\/3/);
  assert.match(text, /Задача 103: Не решено/, 'незачтённые задачи перечислены');
  assert.ok(!/Задача 101/.test(text), 'зачтённые в список проблем не попадают');
});

test('tagLabel: служебные теги по-русски', () => {
  assert.strictEqual(grades.tagLabel('classwork'), 'классная работа');
  assert.strictEqual(grades.tagLabel('Homework'), 'домашняя работа');
  assert.strictEqual(grades.tagLabel('custom-7'), 'custom-7');
  assert.strictEqual(grades.tagLabel(''), '');
});

// ── кэш прогресса для дерева ──

test('mapLimit держит параллельность и порядок', async () => {
  let live = 0;
  let peak = 0;
  const items = Array.from({ length: 9 }, (_, i) => i);
  const out = await grades.mapLimit(items, 4, async (i) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5));
    live--;
    return i * 2;
  });
  assert.deepStrictEqual(out, items.map(i => i * 2));
  assert.ok(peak <= 4, 'одновременно не больше лимита, пик = ' + peak);
});

test('applySnapshot наполняет кэш дерева и помнит, что курс полный', () => {
  const lms = { progressMap: new Map(), courseProgress: new Map() };
  const snap = {
    title: 'Курс', ts: 1, lessonsTotal: 2,
    total: { passed: 3, total: 5, score: 20, scoreMax: 30, overdue: 1 },
    lessons: [{ id: 11, title: 'Урок 1', passed: 1, total: 2, score: 10, scoreMax: 20, overdue: 1 }]
  };
  grades.applySnapshot(lms, 1721, snap, 1, true);
  assert.strictEqual(lms.courseProgress.get('1721').full, true);
  assert.strictEqual(lms.courseProgress.get('1721').lessonsTotal, 2);
  assert.strictEqual(lms.progressMap.get('11').passed, 1);
});

test('noteLessonProgress: сумма по раскрытым урокам не перекрывает ведомость', () => {
  const Lms = class { };
  grades.attach(Lms);
  const lms = new Lms();
  lms.progressMap = new Map();
  lms.courseProgress = new Map();
  lms.output = () => ({ appendLine() { } });
  const row = (state) => ({ state, score: 10, scoreMax: 10, optional: false, deadline: { state: 'none' } });

  lms.noteLessonProgress(1721, { id: 11, title: 'Урок 1' }, [row('passed'), row('unsolved')]);
  const partial = lms.courseProgress.get('1721');
  assert.strictEqual(partial.full, false);
  assert.strictEqual(partial.total, 2);
  assert.strictEqual(lms.progressMap.get('11').total, 2);

  grades.applySnapshot(lms, 1721, {
    title: 'Курс', ts: 2, lessonsTotal: 9,
    total: { passed: 40, total: 90, score: 400, scoreMax: 900 },
    lessons: []
  }, 2, true);
  lms.noteLessonProgress(1721, { id: 12, title: 'Урок 2' }, [row('passed')]);
  const full = lms.courseProgress.get('1721');
  assert.strictEqual(full.full, true, 'полная ведомость не портится частичным раскрытием');
  assert.strictEqual(full.total, 90);
});
