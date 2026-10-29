// Чистые утилиты без зависимости от vscode — тестируются напрямую (test/).
const VERDICTS = {
  'OK': 'Зачтено — решение верное',
  'wrong-answer': 'Неверный ответ',
  'time-limit-exceeded': 'Превышен лимит времени',
  'memory-limit-exceeded': 'Превышен лимит памяти',
  'runtime-error': 'Ошибка выполнения',
  'compilation-error': 'Ошибка оформления / компиляции',
  'presentation-error': 'Ошибка представления вывода',
  'precompile-check-failed': 'Код не прошёл предварительную проверку (PEP 8 и т.п.)',
  'crash': 'Сбой проверки',
  'judge-error': 'Сбой системы проверки'
};

// Вердикты LMS приходят в разном регистре: в задании — «ok», в старых ответах —
// «OK». Сравнивать строки напрямую нельзя: «ok» ≠ «OK», и зачтённое решение
// показывалось красным «на доработку».
function verdictKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function isOkVerdict(v) {
  const k = verdictKey(v);
  return k === 'ok' || k === 'accepted' || k === 'accepted-after-deadline' || k === 'samples-passed';
}

// Человеческая подпись вердикта без учёта регистра («ok» → «Зачтено…»).
function verdictLabel(v) {
  const k = verdictKey(v);
  if (!k) return '';
  for (const key of Object.keys(VERDICTS)) {
    if (key.toLowerCase() === k) return VERDICTS[key];
  }
  return String(v);
}

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asArray(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return null;
  for (const k of keys || []) {
    if (Array.isArray(json[k])) return json[k];
  }
  for (const k of Object.keys(json)) {
    if (Array.isArray(json[k])) return json[k];
  }
  return null;
}

function latestSubmissionOf(json) {
  if (!json) return null;
  const subs = pick(json, 'submissions');
  if (Array.isArray(subs) && subs.length) {
    return subs.slice().sort((a, b) => (pick(b, 'id') || 0) - (pick(a, 'id') || 0))[0] || null;
  }
  const sol = pick(json, 'solution') || json;
  return pick(sol, 'latestSubmission', 'latest_submission') || null;
}

// Причина сбоя из логов проверки (contest-logs). Возвращает список частей
// { label, text }: сначала то, что похоже на текст ошибки (traceback, stderr),
// потом остальное (ввод, ожидалось, получено). Нет текста — null.
const ERRORISH = /traceback|exception|error|ошибк|killed|segmentation fault|std::|panic:|undefined/i;

function verdictReason(logs) {
  if (!logs || typeof logs !== 'object') return null;
  const parts = [];
  const add = (label, value) => {
    if (value === undefined || value === null) return;
    const text = String(value).replace(/\r\n?/g, '\n').trim();
    if (!text) return;
    if (parts.some(p => p.text === text)) return;
    parts.push({ label: String(label), text });
  };
  add('Лог компиляции', pick(logs, 'compileLog', 'compile_log'));
  const info = pick(logs, 'testInfo', 'test_info');
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    for (const k of Object.keys(info)) add(k, info[k]);
  } else {
    add('Тест', info);
  }
  add('Ошибка', pick(logs, 'error', 'stderr', 'message'));
  if (!parts.length) return null;
  return parts.filter(p => ERRORISH.test(p.text)).concat(parts.filter(p => !ERRORISH.test(p.text)));
}

function safeName(s) {
  return String(s || 'без-названия').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ── материалы уроков (учебники) ──
const MATERIAL_TYPES = {
  textbook: 'Учебник',
  article: 'Статья',
  video: 'Видео',
  audio: 'Аудио',
  presentation: 'Презентация',
  file: 'Файл'
};

function materialTypeLabel(type) {
  const k = String(type == null ? '' : type).trim().toLowerCase();
  return MATERIAL_TYPES[k] || 'Материал';
}

// LMS кладёт тип в заголовок: «Учебник | Оператор for…». В дереве и панели
// показываем только тему — тип виден отдельной подписью.
function materialDisplayTitle(material) {
  const raw = String(pick(material, 'title') || '').trim();
  if (!raw) return 'Материал';
  for (const label of Object.values(MATERIAL_TYPES)) {
    for (const sep of [' | ', ': ', ' — ', ' – ', ' - ']) {
      const prefix = label + sep;
      if (raw.toLowerCase().startsWith(prefix.toLowerCase())) {
        const rest = raw.slice(prefix.length).trim();
        if (rest) return rest;
      }
    }
  }
  return raw;
}

// Оценка времени чтения: 180 слов в минуту — средний темп для учебного текста.
function materialReadingMinutes(html) {
  const words = (htmlToText(html).match(/[A-Za-zА-Яа-яЁё0-9]+/g) || []).length;
  if (!words) return 0;
  return Math.max(1, Math.round(words / 180));
}

// Русская плюрализация: «1 день», «2 дня», «5 дней».
function ruPlural(n, one, few, many) {
  const v = Math.abs(Math.trunc(Number(n) || 0));
  const m10 = v % 10;
  const m100 = v % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const DAY_MS = 86400000;

function deadlineDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// «11 января 2027 г.» — в интерфейсе показываем дату, а не сырое ISO
// «2027-01-10T23:30:00+03:00», которое отдаёт API. Суффикс «г.» ru-RU
// добавляет сам, второй раз приписывать не надо.
function fmtDateRu(value) {
  const d = deadlineDate(value);
  if (!d) return '';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Дедлайн по-человечески: дата + короткий счётчик до него.
// state: none | overdue | soon | open (soon — осталось ≤ 3 суток).
function deadlineInfo(value, now) {
  const d = deadlineDate(value);
  if (!d) return { state: 'none', when: '', hint: '', days: null };
  const t = now === undefined ? Date.now() : now;
  const diff = d.getTime() - t;
  const when = fmtDateRu(d);
  if (diff < 0) {
    const days = Math.max(1, Math.floor(-diff / DAY_MS));
    return { date: d, state: 'overdue', when, days: -days, hint: 'просрочено на ' + days + ' ' + ruPlural(days, 'день', 'дня', 'дней') };
  }
  const days = Math.max(1, Math.ceil(diff / DAY_MS));
  if (days <= 3) {
    return { date: d, state: 'soon', when, days, hint: 'осталось ' + days + ' ' + ruPlural(days, 'день', 'дня', 'дней') };
  }
  return { date: d, state: 'open', when, days, hint: '' };
}

// Полоска прогресса: ▰▰▰▱▱▱▱▱. Пусто, если знаменателя нет — иначе
// дерево врёт про «0%» там, где задач просто нет.
function progressBar(done, total, width) {
  const w = Math.max(1, Number(width) || 8);
  const t = Number(total) || 0;
  if (!t) return '';
  const d = Math.max(0, Math.min(t, Number(done) || 0));
  const filled = Math.round((d / t) * w);
  return '▰'.repeat(filled) + '▱'.repeat(w - filled);
}

// ── оценки ──
// Иконка бейджа — тот же признак, что и в дереве: своё состояние задачи
// выводим из него, чтобы панель и дерево никогда не расходились.
const GRADE_STATES = {
  pass: 'passed',
  warning: 'partial',
  sync: 'pending',
  edit: 'rework',
  error: 'failed',
  code: 'unsolved'
};

const GRADE_LABELS = {
  passed: 'Зачтено',
  partial: 'Частично зачтено',
  pending: 'На проверке',
  rework: 'На доработку',
  failed: 'Ошибка',
  unsolved: 'Не решено'
};

const PASSED_STATES = ['passed', 'partial'];

// Одна строка ведомости: задача + её статус (статус передаём из
// lms.statusOf, чтобы не дублировать разбор solution/status).
function gradeRow(task, status, now) {
  if (!task) return null;
  const icon = status && status.badge ? status.badge.icon : 'code';
  const state = GRADE_STATES[icon] || 'unsolved';
  const scoreMax = Number(pick(task, 'scoreMax', 'score_max'));
  const rawScore = status ? pick(status, 'score') : undefined;
  const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : undefined;
  const tag = pick(task, 'tag');
  return {
    id: pick(task, 'id'),
    title: pick(task, 'title') || pick(task, 'shortTitle', 'short_title') || 'Задача',
    state,
    label: GRADE_LABELS[state] || 'Не решено',
    score,
    scoreMax: Number.isFinite(scoreMax) ? scoreMax : 0,
    optional: !!(pick(task, 'isOptional', 'is_optional')),
    typeName: pick(task, 'tagType') || (tag ? pick(tag, 'type') : '') || '',
    deadline: deadlineInfo(pick(task, 'deadline'), now)
  };
}

// Итог по списку строк: сколько зачтено, сколько баллов, что горит.
// Просроченными считаем только незачтённые обязательные задачи —
// дополнительная задача к дедлайну балл не теряет, а зачтённая уже сдана.
function summarizeGrades(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const s = {
    total: list.length, passed: 0, partial: 0, pending: 0, rework: 0, failed: 0, unsolved: 0,
    optional: 0, overdue: 0, score: 0, scoreMax: 0, hasScore: false
  };
  for (const r of list) {
    if (s[r.state] !== undefined) s[r.state]++;
    if (r.optional) s.optional++;
    if (Number.isFinite(r.score)) s.score += r.score;
    if (Number.isFinite(r.scoreMax)) { s.scoreMax += r.scoreMax; s.hasScore = true; }
    if (!r.optional && PASSED_STATES.indexOf(r.state) < 0 && r.deadline && r.deadline.state === 'overdue') s.overdue++;
  }
  s.required = list.filter(r => !r.optional).length;
  s.percent = s.total ? Math.round((s.passed / s.total) * 100) : 0;
  return s;
}

// Строка для дерева: «▰▰▱▱▱▱▱▱ 3/10 · 25/70 б.»
function progressLine(summary, width) {
  if (!summary || !summary.total) return '';
  const bar = progressBar(summary.passed, summary.total, width || 6);
  const parts = [bar + ' ' + summary.passed + '/' + summary.total];
  if (summary.hasScore && summary.scoreMax) parts.push(roundScore(summary.score) + '/' + summary.scoreMax + ' б.');
  if (summary.overdue) parts.push('просрочено ' + summary.overdue);
  return parts.filter(Boolean).join(' · ');
}

// Баллы приходят дробными (рейтинг 7.0088…); в интерфейсе — до целого,
// если дробная часть значима, оставляем один знак.
function roundScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : Math.round(v * 10) / 10;
}

// Задачи урока: API отдаёт и группы по тегу ([{type, tasks: […]}]), и
// плоский список. Разбор один на всех — дерево, ведомость и «следующая задача».
function flattenLessonTasks(json) {
  const arr = asArray(json, ['tasks', 'items', 'data', 'results']) || [];
  const groups = Array.isArray(json) ? json : (arr.length && arr[0] && arr[0].tasks ? arr : [json]);
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const tasks = pick(g, 'tasks') || pick(g, 'problems') || pick(g, 'items');
    if (Array.isArray(tasks)) {
      const typeName = pick(g, 'type') || pick(g, 'title') || '';
      for (const t of tasks) if (t) out.push({ task: t, typeName });
    } else if (pick(g, 'id') !== undefined) {
      out.push({ task: g, typeName: '' });
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadge(type, verdict) {
  const t = String(type || '').toLowerCase();
  if (t === 'accepted' || t === 'accepted-after-deadline' || t === 'samples-passed' || isOkVerdict(verdict)) {
    return { icon: 'pass', color: 'testing.iconPassed', desc: 'Зачтено' };
  }
  if (t === 'rework') {
    return { icon: 'edit', color: 'testing.iconFailed', desc: 'На доработку' };
  }
  if (t === 'wrong' || t === 'not-solved') {
    return { icon: 'error', color: 'testing.iconFailed', desc: 'Ошибка, на доработку' };
  }
  if (t === 'partial-accepted') {
    return { icon: 'warning', color: 'charts.yellow', desc: 'Частично зачтено' };
  }
  if (t === 'uploaded' || t === 'review' || t === 'auto-review' || t === 'assigned-to-p2p' || t === 'on-clarifying') {
    return { icon: 'sync', color: 'charts.yellow', desc: 'На проверке' };
  }
  if (t === 'new' || t === 'draft' || t === '') {
    return { icon: 'code', color: null, desc: '' };
  }
  // Незнакомый статус при существующем решении — почти наверняка «Ответ
  // принят / на проверке» (у LMS таких статусов больше, чем мы знаем).
  return { icon: 'sync', color: 'charts.yellow', desc: 'На проверке' };
}

const LMS_TEMPLATES = [
  'def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n',
  'def main():\n    pass\n\nif __name__ == "__main__":\n    main()\n',
  'def main():\n    pass\n'
];

function stripTemplate(code) {
  if (typeof code !== 'string') return code;
  let out = code;
  for (const tpl of LMS_TEMPLATES) {
    const esc = tpl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'g'), '');
  }
  return out.replace(/^\s*\n+/, '').replace(/\s+$/, '') + (out.trim() ? '\n' : '');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…').replace(/&laquo;/gi, '«').replace(/&raquo;/gi, '»')
    .replace(/&times;/gi, '×').replace(/&deg;/gi, '°')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/gi, '&');
}

function htmlToMarkdown(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<img[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, (m, src) => '![' + (m.match(/alt=["']([^"']*)["']/i) || [, ''])[1] + '](' + src + ')');
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (tbl) => {
    const rows = [...tbl.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
      .map(tr => [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => decodeEntities(c[1].replace(/<[^>]+>/g, ' ')).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()))
      .filter(r => r.length && r.some(c => c));
    if (!rows.length) return '\n\n';
    const width = Math.max.apply(null, rows.map(r => r.length));
    const norm = rows.map(r => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
    const out = ['| ' + norm[0].join(' | ') + ' |', '| ' + Array(width).fill('---').join(' | ') + ' |'];
    for (let i = 1; i < norm.length; i++) out.push('| ' + norm[i].join(' | ') + ' |');
    return '\n\n' + out.join('\n') + '\n\n';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|tr|h[1-6]|thead|tbody|pre)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|thead|tbody|pre)>/gi, '\n');
  s = s.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' | ');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[изображение: $1]');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function mdToHtml(md) {
  const esc = (s) => escapeHtml(s);
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const lines = String(md || '').split('\n');
  const out = [];
  let inCode = false;
  const codeBuf = [];
  let list = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inCode) { out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); codeBuf.length = 0; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      closeList();
      const lvl = Math.min(m[1].length + 2, 6);
      out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>');
      continue;
    }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      closeList();
      out.push('<blockquote>' + inline(m[1]) + '</blockquote>');
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    closeList();
    out.push('<p>' + inline(line) + '</p>');
  }
  if (inCode && codeBuf.length) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
  closeList();
  return out.join('\n');
}

// То же, но с подачей текста в stdin (примеры ввода для локальной проверки).
function runProcessInput(cmd, args, input, timeoutMs) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    let out = '';
    let err = '';
    let done = false;
    try {
      const cp = spawn(cmd, args, { windowsHide: true });
      const timer = setTimeout(() => { try { cp.kill(); } catch (e) { } }, timeoutMs || 10000);
      cp.stdout.on('data', d => { out += d.toString(); });
      cp.stderr.on('data', d => { err += d.toString(); });
      cp.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e) }); } });
      cp.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
      try {
        if (input) cp.stdin.write(String(input));
        cp.stdin.end();
      } catch (e) { }
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e.message || e) });
    }
  });
}

function runProcess(cmd, args, timeoutMs) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    let out = '';
    let done = false;
    try {
      const cp = spawn(cmd, args, { windowsHide: true });
      const timer = setTimeout(() => { try { cp.kill(); } catch (e) { } }, timeoutMs || 15000);
      cp.stdout.on('data', d => { out += d.toString(); });
      cp.stderr.on('data', d => { out += d.toString(); });
      cp.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out: String(e.message || e) }); } });
      cp.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }); } });
    } catch (e) {
      resolve({ code: -1, out: String(e.message || e) });
    }
  });
}

// Конструкции, которые проверка базового курса не принимает: ловим до отправки и правим.
// Курс-специфично; переопределяется настройкой yandexLms.ai.courseRules (текст правил для промпта).
const AI_FORBIDDEN = [
  { re: /^[ \t]*import[ \t]+/m, msg: 'import запрещён' },
  { re: /^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+/m, msg: 'from … import запрещён' },
  { re: /\bclass[ \t]+[A-Za-z_]\w*/m, msg: 'классы запрещены' },
  { re: /^[ \t]*try[ \t]*:/m, msg: 'try/except запрещён' },
  { re: /^[ \t]*except\b/m, msg: 'except запрещён' },
  { re: /\blambda\b/, msg: 'lambda запрещена' },
  { re: /\[[^\]\n]*\bfor\b[^\]\n]*\]/, msg: 'списковое включение запрещено' },
  { re: /\{[^}\n]*\bfor\b[^}\n]*\}/, msg: 'словарное/множественное включение запрещено' },
  { re: /\bf["']/, msg: 'f-строки запрещены' },
  { re: /\*\*/, msg: 'возведение в степень через ** запрещено' },
  { re: /\b(async|await|yield|nonlocal|global)\b/, msg: 'async/await/yield/nonlocal/global запрещены' }
];

function aiLint(code) {
  const src = String(code || '');
  const out = [];
  for (const f of AI_FORBIDDEN) {
    if (f.re.test(src) && out.indexOf(f.msg) < 0) out.push(f.msg);
  }
  return out;
}

// Markdown → читаемый простой текст (для вебвью-фри режима условия).
function mdToPlainText(md) {
  let s = String(md || '');
  s = s.replace(/```[a-z]*\r?\n?/gi, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');
  s = s.replace(/`([^`]+)`/g, '$1');
  // таблицы «| a | b |» → строки «a — b»; разделительные ряды из прочерков пропускаем
  s = s.replace(/^\|(.+)\|\s*$/gm, (m, row) => {
    const cells = row.split('|').map(c => c.trim()).filter(c => c.length);
    if (cells.length && cells.every(c => /^:?-{2,}:?$/.test(c))) return '';
    return cells.join(' — ');
  });
  s = s.replace(/^---\s*$/gm, '────────');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

function aiExtractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/, '').trim();
  const first = s.indexOf('{');
  if (first < 0) throw new Error('Модель не вернула JSON: ' + s.slice(0, 200));
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = first; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const raw = end > 0 ? s.slice(first, end + 1) : s.slice(first);
  return JSON.parse(raw);
}

// ── примеры из условия: локальная проверка решения без отправки ──

// Мягкое сравнение вывода — как чекеры LMS: хвостовые пробелы в строках
// и пустые строки в конце не влияют на вердикт.
function normalizeOutput(s) {
  const lines = String(s || '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map(l => l.replace(/\s+$/g, '')).join('\n');
}

// Условие приходит HTML-ом от LMS: вырезаем активные элементы, разметку
// (таблицы, картинки, код) оставляем. Правим только внутри тегов — иначе
// `onclick=` в примере кода в тексте условия превращался бы в кашу.
function sanitizeStatementHtml(html) {
  return String(html || '')
    .replace(/<(script|iframe|object|embed|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|style|meta|link|base)\b[^>]*>/gi, '')
    .replace(/<([a-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi, (m, tag, attrs) => {
      const clean = attrs
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\s(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
      return '<' + tag + clean + '>';
    });
}

// Текст из HTML-блока примера: <br> и границы абзацев → переводы строк.
function _blockText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|pre|li|h[1-6]|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, ''));
}

// Примеры «ввод → вывод» из HTML условия. Форматы у LMS разные, поэтому
// несколько стратегий: таблицы «ввод|вывод», затем пары подряд идущих <pre>
// (только если в условии явно есть слово «пример»).
// Не распознали — возвращаем пустой список, панель просто молчит.
const CONSTRAINTISH = /[≤≥]|секунд|\bмс\b|МБ|КБ|байт|балл/i;
const CONSTRAINT_HEADER = /ограничени|характеристик|параметр|время|память|балл/i;

function parseExamples(html) {
  const src = String(html || '');
  if (!src) return [];
  const out = [];
  const tables = src.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const cellsOf = row => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => _blockText(c[1]).trim());
    // Таблица ограничений («Ограничение | Значение», «Параметр | Время») —
    // не примеры: локальный прогон получал бы мусорный stdin и врал про FAIL.
    if (rows.length && cellsOf(rows[0]).some(c => CONSTRAINT_HEADER.test(c))) continue;
    for (const row of rows) {
      const cells = cellsOf(row);
      if (cells.length !== 2 || !cells[0] || !cells[1]) continue;
      if (/^(ввод|input|stdin)$/i.test(cells[0]) && /^(вывод|output|stdout|результат)$/i.test(cells[1])) continue;
      if (CONSTRAINTISH.test(cells[0]) || CONSTRAINTISH.test(cells[1])) continue;
      out.push({ input: cells[0], output: cells[1] });
    }
  }
  if (out.length) return out;
  const blocks = [...src.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => _blockText(m[1]).replace(/^\n+/, '').replace(/\s+$/, ''));
  if (blocks.length >= 2 && blocks.length % 2 === 0 && /пример|ввод|вывод|input|output/i.test(_blockText(src))) {
    for (let i = 0; i + 1 < blocks.length; i += 2) {
      if (blocks[i] || blocks[i + 1]) out.push({ input: blocks[i], output: blocks[i + 1] });
    }
  }
  return out;
}

module.exports = {
  VERDICTS, pick, asArray, latestSubmissionOf, verdictReason, safeName, sleep, escapeHtml,
  statusBadge, stripTemplate, LMS_TEMPLATES, decodeEntities, htmlToMarkdown,
  htmlToText, mdToHtml, mdToPlainText, runProcess, runProcessInput, AI_FORBIDDEN, aiLint, aiExtractJson,
  normalizeOutput, parseExamples, sanitizeStatementHtml, verdictKey, isOkVerdict, verdictLabel,
  MATERIAL_TYPES, materialTypeLabel, materialDisplayTitle, materialReadingMinutes,
  ruPlural, deadlineDate, fmtDateRu, deadlineInfo, progressBar,
  GRADE_STATES, GRADE_LABELS, PASSED_STATES, gradeRow, summarizeGrades, progressLine, roundScore, flattenLessonTasks
};
