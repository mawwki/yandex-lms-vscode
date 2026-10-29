// «Мои оценки»: прогресс и баллы по курсу.
// Данные берём из того же lessonTasks, что и дерево: ответ уже содержит
// solution.score, scoreMax, deadline и isOptional, поэтому ведомость стоит
// один запрос на урок, а не по запросу на задачу.
const vscode = require('vscode');
const crypto = require('crypto');
const {
  pick, asArray, escapeHtml, gradeRow, summarizeGrades, progressLine,
  deadlineInfo, roundScore, flattenLessonTasks
} = require('./util');

const GRADES_VIEW = 'yandexLmsGrades';
const GRADES_SNAPSHOT_KEY = 'yandexLms.grades';
const CONCURRENCY = 4;
const WATCHDOG_MS = 4000;

// Теги заданий: API отдаёт служебный type (classwork), показываем по-русски.
const TAG_LABELS = {
  classwork: 'классная работа',
  homework: 'домашняя работа',
  additional: 'дополнительная',
  exam: 'экзамен',
  'control-work': 'контрольная'
};

function tagLabel(type) {
  const k = String(type || '').trim().toLowerCase();
  if (!k) return '';
  return TAG_LABELS[k] || k;
}

// Параллельно, но не больше CONCURRENCY уроков: курс из 30 уроков
// иначе срывается в залп запросов и ловит лимиты LMS.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

// Статус каждой задачи берём через lms.statusOf, чтобы ведомость и дерево
// никогда не расходились в вердиктах.
function lessonRows(lms, tasks) {
  return tasks.map(({ task, typeName }) => {
    const row = gradeRow(task, lms.statusOf ? lms.statusOf(task) : null);
    if (row && !row.typeName && typeName) row.typeName = typeName;
    return row;
  }).filter(Boolean);
}

// Снимок курса: уроки → строки ведомости → общие итоги.
async function collectCourse(lms, course, onProgress) {
  const courseId = pick(course, 'id');
  const group = pick(course, 'group');
  const groupId = group ? pick(group, 'id') : undefined;
  const lr = await lms.client.lessons(courseId, groupId);
  const lessons = (lr && lr.status === 200 ? asArray(lr.json, ['lessons', 'items', 'data', 'results']) : null) || [];
  const total = lessons.length;
  let done = 0;
  const items = await mapLimit(lessons, CONCURRENCY, async (lesson) => {
    const lessonId = pick(lesson, 'id');
    const title = pick(lesson, 'title') || pick(lesson, 'shortTitle', 'short_title') || 'Урок';
    let rows = [];
    let error = null;
    try {
      const r = await lms.client.lessonTasks(courseId, lessonId, groupId);
      if (r && r.status === 200) rows = lessonRows(lms, flattenLessonTasks(r.json));
      else error = 'HTTP ' + (r ? r.status : 'ERR');
    } catch (e) {
      error = String((e && e.message) || e);
    }
    const summary = summarizeGrades(rows);
    // Урок без единой задачи в ответе, но с известным числом задач из
    // списка уроков — показываем знаменатель, а не пустую строку.
    if (!rows.length && !error) {
      const t = Number(pick(lesson, 'numTasks', 'num_tasks'));
      if (Number.isFinite(t) && t > 0) summary.total = t;
    }
    done++;
    if (onProgress) onProgress(done, total, title);
    return { id: lessonId, title, deadline: deadlineInfo(pick(lesson, 'deadline')), rows, summary, error };
  });
  const all = [];
  for (const it of items) for (const r of it.rows) all.push(r);
  return {
    courseId,
    groupId,
    title: lms.courseLabel(course),
    rating: roundScore(pick(course, 'rating')),
    ts: Date.now(),
    lessons: items,
    summary: summarizeGrades(all)
  };
}

function card(label, value, sub, cls) {
  return '<div class="card' + (cls ? ' ' + cls : '') + '"><div class="c-label">' + escapeHtml(label) + '</div>' +
    '<div class="c-value">' + escapeHtml(value) + '</div>' +
    (sub ? '<div class="c-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>';
}

function rowHtml(lesson, r) {
  const scoreTxt = Number.isFinite(r.score) && r.scoreMax
    ? roundScore(r.score) + '/' + r.scoreMax
    : (r.scoreMax ? '0/' + r.scoreMax : '');
  const dl = r.deadline && r.deadline.state !== 'none'
    ? '<span class="r-dl ' + r.deadline.state + '">' + escapeHtml(r.deadline.hint || r.deadline.when) + '</span>'
    : '';
  const tag = tagLabel(r.typeName);
  const tip = (lesson.title ? lesson.title + ' — ' : '') + r.label + (scoreTxt ? ', ' + scoreTxt + ' б.' : '');
  return '<div class="row st-' + r.state + '" data-act="openTask" data-task="' + escapeHtml(String(r.id)) +
    '" data-lesson="' + escapeHtml(String(lesson.id)) + '" role="button" tabindex="0" title="' + escapeHtml(tip) + '">' +
    '<span class="r-title">' + escapeHtml(String(r.title)) + '</span>' +
    (r.optional ? '<span class="r-opt" title="Дополнительная задача">опц.</span>' : '') +
    (tag ? '<span class="r-tag">' + escapeHtml(tag) + '</span>' : '') +
    '<span class="r-state">' + escapeHtml(r.label) + '</span>' +
    (scoreTxt ? '<span class="r-score">' + escapeHtml(scoreTxt) + '</span>' : '') +
    dl + '</div>';
}

function lessonHtml(lesson) {
  const s = lesson.summary;
  const line = progressLine(s, 10);
  const clean = s.total > 0 && s.passed === s.total;
  const dlTxt = lesson.deadline && lesson.deadline.state !== 'none'
    ? (lesson.deadline.hint ? lesson.deadline.when + ' · ' + lesson.deadline.hint : 'до ' + lesson.deadline.when)
    : '';
  const meta = [line, dlTxt].filter(Boolean).join(' · ');
  const body = lesson.rows.length
    ? lesson.rows.map(r => rowHtml(lesson, r)).join('')
    : (lesson.error
      ? '<div class="row err">Не загрузились задания: ' + escapeHtml(String(lesson.error)) + '</div>'
      : '<div class="row empty">В уроке нет заданий</div>');
  return '<section class="lesson' + (clean ? ' clean' : '') + '">' +
    '<header class="l-head"><h2>' + escapeHtml(String(lesson.title)) + '</h2>' +
    (meta ? '<span class="l-meta">' + escapeHtml(meta) + '</span>' : '') + '</header>' +
    '<div class="rows">' + body + '</div></section>';
}

function gradesHtml(snap, opts) {
  const o = opts || {};
  const n = o.nonce || 'nonce';
  const csp = o.csp || '';
  const s = snap.summary;
  const waiting = s.pending + s.partial;
  const attention = s.rework + s.failed + s.unsolved;
  const updated = new Date(snap.ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const scoreCard = s.hasScore && s.scoreMax
    ? card('Баллы', roundScore(s.score) + '/' + s.scoreMax, s.percent + '% зачтённых задач', '')
    : card('Баллы', '—', 'LMS их не отдаёт', '');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, transparent); margin: 0; line-height: 1.5; }
  .topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 9px 18px; background: var(--vscode-editor-background, #1f1f1f); border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .tb-left { min-width: 0; }
  .tb-title { font-size: 1.02em; font-weight: 600; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tb-meta { font-size: 0.8em; opacity: 0.65; }
  .tb-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .btn { font-family: inherit; font-size: 0.88em; padding: 5px 12px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground, #313131);
    color: var(--vscode-button-secondaryForeground, #ccc); }
  .btn:hover { filter: brightness(1.15); }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 14px 20px 48px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 4px 0 14px; }
  .card { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-sideBar-background, rgba(127,127,127,0.06)); }
  .c-label { font-size: 0.76em; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }
  .c-value { font-size: 1.3em; font-weight: 600; margin: 2px 0; }
  .c-sub { font-size: 0.8em; opacity: 0.7; }
  .card.warn .c-value { color: var(--vscode-charts-orange, #d18616); }
  .card.bad .c-value { color: var(--vscode-errorForeground, #f85149); }
  .card.good .c-value { color: var(--vscode-testing-iconPassed, #3fb950); }
  .seg { display: inline-flex; padding: 2px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.16)); margin: 0 0 14px; }
  .seg-btn { font-family: inherit; font-size: 0.8em; line-height: 1; padding: 5px 12px; border: 0; border-radius: 999px;
    background: transparent; color: var(--vscode-foreground, #ccc); opacity: 0.7; cursor: pointer; }
  .seg-btn.on { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); opacity: 1; }
  .lesson { margin: 0 0 18px; }
  .l-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); padding-bottom: 3px; }
  .l-head h2 { font-size: 1em; margin: 0; }
  .l-meta { font-size: 0.82em; opacity: 0.7; font-family: var(--vscode-editor-font-family, monospace); }
  .rows { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 5px; font-size: 0.9em; cursor: pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.14)); }
  .row:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); }
  .r-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .r-tag, .r-opt { font-size: 0.8em; opacity: 0.6; white-space: nowrap; }
  .r-state { font-size: 0.86em; white-space: nowrap; }
  .r-score { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.88em; min-width: 58px; text-align: right; }
  .r-dl { font-size: 0.82em; opacity: 0.75; min-width: 120px; text-align: right; white-space: nowrap; }
  .r-dl.overdue { color: var(--vscode-errorForeground, #f85149); opacity: 1; }
  .r-dl.soon { color: var(--vscode-charts-orange, #d18616); opacity: 1; }
  .st-passed .r-state { color: var(--vscode-testing-iconPassed, #3fb950); }
  .st-partial .r-state, .st-pending .r-state { color: var(--vscode-charts-orange, #d18616); }
  .st-rework .r-state, .st-failed .r-state { color: var(--vscode-errorForeground, #f85149); }
  .st-unsolved .r-state { opacity: 0.6; }
  .row.empty, .row.err { cursor: default; opacity: 0.7; }
  .row.empty:hover, .row.err:hover { background: none; }
  /* Фильтр «только проблемы» — чистый CSS: скрываем зачтённые строки и
     целиком зачтённые уроки, чтобы не оставались пустые заголовки. */
  body[data-filter="problem"] .st-passed, body[data-filter="problem"] .lesson.clean { display: none; }
  .hint { font-size: 0.84em; opacity: 0.65; margin: 0 0 12px; }
</style>
</head>
<body data-filter="all">
<div class="topbar">
  <div class="tb-left">
    <span class="tb-title">Оценки — ${escapeHtml(String(snap.title || 'курс'))}</span>
    <span class="tb-meta">обновлено ${escapeHtml(updated)}</span>
  </div>
  <div class="tb-right">
    <button type="button" class="btn" data-act="refresh">Обновить</button>
    <button type="button" class="btn" data-act="browser">Открыть в LMS</button>
  </div>
</div>
<div class="wrap">
  <div class="cards">
    ${card('Зачтено', s.passed + '/' + s.total, s.optional ? 'из них дополнительных ' + s.optional : '', s.total && s.passed === s.total ? 'good' : '')}
    ${scoreCard}
    ${card('На проверке', String(waiting), 'ждут вердикта LMS', waiting ? 'warn' : '')}
    ${card('Требует внимания', String(attention), s.overdue ? 'из них просрочено ' + s.overdue : 'не сдано или на доработку', attention ? 'bad' : '')}
  </div>
  ${snap.rating ? '<p class="hint">Рейтинг курса в LMS: ' + escapeHtml(String(snap.rating)) + '</p>' : ''}
  <div class="seg">
    <button type="button" class="seg-btn on" data-filter="all">Все задачи</button>
    <button type="button" class="seg-btn" data-filter="problem">Только проблемы (${waiting + attention})</button>
  </div>
  ${snap.lessons.map(lessonHtml).join('') || '<p class="hint">Уроки не нашлись — нажмите «Обновить».</p>'}
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
function applyFilter(f) {
  document.body.dataset.filter = f;
  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('on', b.dataset.filter === f);
}
document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]');
  if (f) { applyFilter(f.dataset.filter); return; }
  const a = e.target.closest('[data-act]');
  if (a) vscode.postMessage({ type: a.dataset.act, taskId: a.dataset.task, lessonId: a.dataset.lesson });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const a = e.target.closest('[data-act]');
  if (a) { e.preventDefault(); a.click(); }
});
window.postMessage({ type: 'ready' }, '*');
</script>
</body>
</html>`;
}

// Запасной вывод, если webview окна не поднялся (#342842): тот же итог текстом.
function gradesText(snap) {
  const s = snap.summary;
  const out = ['Оценки — ' + snap.title, ''];
  out.push('Зачтено: ' + s.passed + '/' + s.total + (s.hasScore && s.scoreMax ? ' · Баллы: ' + roundScore(s.score) + '/' + s.scoreMax : ''));
  if (s.overdue) out.push('Просрочено обязательных задач: ' + s.overdue);
  out.push('');
  for (const l of snap.lessons) {
    out.push(l.title + ' — ' + (progressLine(l.summary, 10) || 'нет задач'));
    for (const r of l.rows) {
      if (r.state === 'passed') continue;
      out.push('  · ' + r.title + ': ' + r.label +
        (Number.isFinite(r.score) ? ' ' + roundScore(r.score) + '/' + r.scoreMax : '') +
        (r.deadline && r.deadline.hint ? ' (' + r.deadline.hint + ')' : ''));
    }
  }
  return out.join('\n');
}

// Компактный снимок для дерева: полоски прогресса рисуются без сети
// и после перезагрузки окна.
function toSnapshot(snap) {
  return {
    title: snap.title,
    ts: snap.ts,
    lessonsTotal: snap.lessons.length,
    total: snap.summary,
    lessons: snap.lessons.map(l => ({
      id: l.id,
      title: l.title,
      passed: l.summary.passed,
      total: l.summary.total,
      score: l.summary.score,
      scoreMax: l.summary.scoreMax,
      pending: l.summary.pending,
      overdue: l.summary.overdue
    }))
  };
}

function applySnapshot(lms, courseId, snap, ts, full) {
  if (!lms.courseProgress) lms.courseProgress = new Map();
  if (!lms.progressMap) lms.progressMap = new Map();
  const totals = snap.total || snap.summary || {};
  lms.courseProgress.set(String(courseId), Object.assign({ title: snap.title, ts }, totals, {
    full: full !== false,
    lessonsKnown: (snap.lessons || []).length,
    lessonsTotal: snap.lessonsTotal !== undefined ? snap.lessonsTotal : (snap.lessons || []).length
  }));
  for (const l of snap.lessons || []) {
    const s = l.summary || l;
    lms.progressMap.set(String(l.id), {
      courseId: String(courseId),
      title: l.title,
      passed: s.passed || 0,
      total: s.total || 0,
      score: s.score || 0,
      scoreMax: s.scoreMax || 0,
      pending: s.pending || 0,
      overdue: s.overdue || 0,
      ts
    });
  }
}

// Сумма по тем урокам курса, прогресс которых уже известен дереву.
function aggregateCourse(lms, courseId) {
  const agg = { passed: 0, total: 0, score: 0, scoreMax: 0, pending: 0, overdue: 0, lessonsKnown: 0 };
  for (const p of lms.progressMap.values()) {
    if (String(p.courseId) !== String(courseId)) continue;
    agg.passed += p.passed || 0;
    agg.total += p.total || 0;
    agg.score = roundScore(agg.score + (p.score || 0));
    agg.scoreMax += p.scoreMax || 0;
    agg.pending += p.pending || 0;
    agg.overdue += p.overdue || 0;
    agg.lessonsKnown++;
  }
  return agg;
}

function attach(Lms) {
  Lms.prototype.primeGrades = async function () {
    let stored = null;
    try { stored = this.context.globalState.get(GRADES_SNAPSHOT_KEY); } catch (e) { }
    if (!stored || typeof stored !== 'object') return;
    for (const [courseId, snap] of Object.entries(stored)) applySnapshot(this, courseId, snap, snap.ts, true);
  };

  // Дерево обновляет прогресс по мере раскрытия уроков: lessonTasks уже
  // пришёл для списка заданий, балльный итог считаем из него же — без
  // дополнительных запросов.
  Lms.prototype.noteLessonProgress = function (courseId, lesson, rows) {
    if (courseId === undefined || courseId === null) return;
    if (!this.progressMap) this.progressMap = new Map();
    if (!this.courseProgress) this.courseProgress = new Map();
    const id = lesson && pick(lesson, 'id') !== undefined ? pick(lesson, 'id') : lesson && lesson.id;
    if (id === undefined || id === null) return;
    const s = summarizeGrades(rows);
    const title = (lesson && (pick(lesson, 'title') || pick(lesson, 'shortTitle', 'short_title') || lesson.title)) || '';
    this.progressMap.set(String(id), Object.assign({ courseId: String(courseId), title, ts: Date.now() }, s));
    const cur = this.courseProgress.get(String(courseId));
    // Полная ведомость курса точнее суммы по раскрытым урокам — не трогаем её.
    if (!cur || !cur.full) {
      this.courseProgress.set(String(courseId), Object.assign(
        { title: cur && cur.title, full: false },
        aggregateCourse(this, courseId)
      ));
    }
  };

  Lms.prototype.saveGradesSnapshot = async function (snap) {
    if (!snap || snap.courseId === undefined || snap.courseId === null) return;
    try {
      const stored = Object.assign({}, this.context.globalState.get(GRADES_SNAPSHOT_KEY) || {});
      const compact = toSnapshot(snap);
      stored[String(snap.courseId)] = compact;
      await this.context.globalState.update(GRADES_SNAPSHOT_KEY, stored);
      applySnapshot(this, snap.courseId, compact, snap.ts, true);
    } catch (e) {
      this.output().appendLine('LMS grades: снимок не сохранён: ' + (e.message || e));
    }
  };

  Lms.prototype.collectCourse = function (course, onProgress) {
    return collectCourse(this, course, onProgress);
  };

  // Команда «LMS: Мои оценки»: курс из дерева либо выбор из списка.
  Lms.prototype.openGrades = async function (node) {
    if (!await this.ensureAuth()) return;
    const courses = this.courseList();
    if (!courses.length) {
      vscode.window.showWarningMessage('LMS: курсы не найдены — обновите список («LMS: Обновить список курсов»).');
      return;
    }
    let course = node && node.course ? node.course : null;
    if (!course && courses.length > 1) {
      const picked = await vscode.window.showQuickPick(
        courses.map(c => ({ label: this.courseLabel(c), course: c })),
        { placeHolder: 'По какому курсу показать оценки?', ignoreFocusOut: true }
      );
      if (!picked) return;
      course = picked.course;
    } else if (!course) {
      course = courses[0];
    }
    let snap = null;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LMS: собираю оценки…', cancellable: false },
        async (progress) => {
          snap = await collectCourse(this, course, (done, total, title) => {
            progress.report({ message: total > 1 ? done + '/' + total + ' — ' + title : title });
          });
        }
      );
    } catch (e) {
      vscode.window.showErrorMessage('LMS: не удалось собрать оценки: ' + ((e && e.message) || e));
      return;
    }
    await this.saveGradesSnapshot(snap);
    this.tree.refresh();
    this.showGradesPanel(snap);
  };

  Lms.prototype.showGradesPanel = function (snap) {
    const existing = this.gradesPanel;
    const panel = existing && !existing.__lmsDead
      ? existing
      : vscode.window.createWebviewPanel(
        GRADES_VIEW,
        'Оценки — ' + (snap.title || 'Яндекс LMS'),
        { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true, disableServiceWorker: true }
      );
    if (panel !== existing) {
      panel.onDidDispose(() => {
        panel.__lmsDead = true;
        if (this.gradesPanel === panel) this.gradesPanel = null;
      });
      panel.onDidReceiveMessage(async (msg) => {
        const type = msg && msg.type;
        if (type === 'ready') { this.gradesReady = true; return; }
        try {
          if (type === 'browser') await this.openCourseInBrowser();
          else if (type === 'refresh') await this.refreshGrades();
          else if (type === 'openTask') await this.openTaskFromGrades(msg);
        } catch (e) {
          this.output().appendLine('LMS grades: ' + type + ': ' + ((e && e.message) || e));
        }
      });
      this.gradesPanel = panel;
    }
    this.gradesSnap = snap;
    this.gradesReady = false;
    panel.title = 'Оценки — ' + (snap.title || 'Яндекс LMS');
    panel.webview.html = gradesHtml(snap, { nonce: crypto.randomBytes(16).toString('hex'), csp: panel.webview.cspSource });
    panel.reveal(vscode.ViewColumn.One, false);
    // Webview окна может не подняться (#342842) — тогда тот же итог в Output.
    setTimeout(() => {
      if (this.gradesPanel !== panel || this.gradesReady) return;
      const ch = this.output();
      ch.appendLine(gradesText(snap));
      ch.show(true);
      vscode.window.showWarningMessage('LMS: панель оценок не загрузилась (баг VS Code #342842) — итоги выведены в канал «Yandex LMS».');
    }, WATCHDOG_MS);
  };

  Lms.prototype.refreshGrades = async function () {
    const snap = this.gradesSnap;
    if (!snap) return this.openGrades(null);
    const course = this.courseList().find(c => String(pick(c, 'id')) === String(snap.courseId));
    if (!course) {
      vscode.window.showWarningMessage('LMS: курс не найден в списке — обновите профиль («LMS: Обновить список курсов»).');
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LMS: обновляю оценки…', cancellable: false },
        async (progress) => {
          const fresh = await collectCourse(this, course, (done, total, title) => {
            progress.report({ message: total > 1 ? done + '/' + total + ' — ' + title : title });
          });
          await this.saveGradesSnapshot(fresh);
          this.showGradesPanel(fresh);
        }
      );
      this.tree.refresh();
    } catch (e) {
      vscode.window.showErrorMessage('LMS: не удалось обновить оценки: ' + ((e && e.message) || e));
    }
  };

  // Клик по строке ведомости открывает задачу так же, как клик в дереве.
  Lms.prototype.openTaskFromGrades = async function (msg) {
    const snap = this.gradesSnap;
    if (!snap || !msg) return;
    const lesson = snap.lessons.find(l => String(l.id) === String(msg.lessonId));
    const row = lesson && lesson.rows.find(r => String(r.id) === String(msg.taskId));
    if (!row) return;
    await this.openTask({
      task: { id: row.id, title: row.title },
      groupId: snap.groupId,
      courseId: snap.courseId,
      lessonId: lesson.id,
      courseTitle: snap.title,
      lessonTitle: lesson.title
    });
  };

  Lms.prototype.openCourseInBrowser = async function () {
    const s = this.gradesSnap || {};
    const base = this.client.base;
    const group = s.groupId !== undefined && s.groupId !== null ? '/groups/' + s.groupId : '';
    const url = s.courseId !== undefined && s.courseId !== null ? base + '/courses/' + s.courseId + group : base + '/';
    await vscode.env.openExternal(vscode.Uri.parse(url));
  };
}

module.exports = {
  attach, gradesHtml, gradesText, collectCourse, toSnapshot, tagLabel, mapLimit,
  applySnapshot, aggregateCourse, lessonRows
};
