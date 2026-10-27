// ИИ-функции задачи: подсказки / проверка / решение / исправление, настройки и
// управление пулом ключей (включая OpenCode CLI). Подключается к прототипу Lms.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { cfg } = require('../cfg');
const { pick, escapeHtml, mdToHtml, htmlToText, aiLint, runProcess } = require('../util');
const { aiLog } = require('../diag');
const { aiChat, aiChatOnce, aiListModels } = require('./chat');
const pool = require('./pool');
const { AI_PROVIDERS, providerDef } = require('./providers');
const { openCodeVersion, resolveOpenCodeBin, openCodeProbeModel } = require('./opencode');
const { clineVersion, resolveClineBin, clineProbeModel } = require('./cline');

const OPENCODE_FALLBACK_MODELS = ['opencode/big-pickle', 'ollama/qwen3-mini-uncensored', 'ollama/qwen3-uncensored'];
const CLINE_FALLBACK_MODELS = ['poolside/laguna-s-2.1:free', 'cohere/north-mini-code:free', 'google/gemma-4-31b-it:free'];

const DEFAULT_COURSE_RULES = [
  'Ученик — новичок, прошедший только предыдущие уроки курса «Программирование на Python» (ввод-вывод, строки, списки, словари, циклы for и while, условия, вложенные циклы, работа с символами).',
  'СТРОГИЕ ОГРАНИЧЕНИЯ (нарушение = неверный ответ):',
  '- НЕЛЬЗЯ использовать модули и библиотеки: import, sys, os, math, random, collections, re, typing, itertools, datetime, json и любые другие. Никакого import вообще.',
  '- НЕЛЬЗЯ использовать классы и ООП, try/except/finally, raise, lambda, генераторы, декораторы, comprehensions (списковые/словарные/множественные), тернарные операторы, f-строки вида f"...", распаковку, *, nonlocal, async, декораторы, сортировку с ключем.',
  '- НЕЛЬЗЯ использовать bitwise-операции, побитовые сдвиги, степени через **, math-функции, random.',
  'РАЗРЕШЕНО: print() (в т.ч. с sep= и end=), input(), int(), float(), str(), bool(), len(), range(), abs(), round(), min(), max(), sum(), zip(), enumerate(), строки (upper, lower, strip, split, replace, find, index, count, startswith, endswith, isdigit, isalpha, isspace, join, ord, chr, title, capitalize, ljust, rjust), списки (append, insert, pop, remove, sort, reverse, count, index, len, срез[:]), словари (get, keys, values, items, in, len), циклы for/while, range, break/continue, if/elif/else, вложенные циклы, арифметика, конкатенация строк, форматирование через % и .format().',
  'Код должен читать ввод через input() и печатать ответ через print(). Никаких пояснений в коде.'
].join('\n');

function attach(Lms) {
  // ── данные для промптов ──
  Lms.prototype.aiStatement = function () {
    const t = this.currentTask;
    if (!t) return '';
    const cached = this.detailCache.get(String(t.taskId));
    const html = cached ? pick(cached, 'description', 'statement', 'content') : '';
    return htmlToText(html);
  };

  Lms.prototype.aiCurrentCode = function () {
    const t = this.currentTask;
    if (!t || !t.filePath) return '';
    try {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === t.filePath);
      if (doc) return doc.getText();
      if (fs.existsSync(t.filePath)) return fs.readFileSync(t.filePath, 'utf8');
    } catch (e) { }
    return '';
  };

  Lms.prototype.aiFileWrite = async function (text, task) {
    const t = task || this.currentTask;
    if (!t || !t.filePath) throw new Error('Нет открытого файла задачи.');
    // Пока модель думала (до 90 с), ученик мог открыть другую задачу: писать
    // чужое решение в её файл нельзя.
    if (task && this.currentTask !== task) {
      throw new Error('Задание переключилось — вставка отменена, чтобы не испортить другой файл. Вернитесь к задаче и повторите.');
    }
    const uri = vscode.Uri.file(t.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, text);
    await vscode.workspace.applyEdit(edit);
  };

  Lms.prototype.aiStudentRules = function () {
    const custom = String(cfg().get('ai.courseRules') || '').trim();
    return custom || DEFAULT_COURSE_RULES;
  };

  Lms.prototype.aiSystemPrompt = function () {
    return 'Ты — наставник курса Яндекс LMS «Программирование на Python». Пишешь по-русски, коротко и по делу, как методичка курса. Отвечаешь ТОЛЬКО на русском языке.';
  };

  // ── память о граблях ──
  Lms.prototype.aiLessonsList = function () {
    if (!this.aiLessons) {
      try { this.aiLessons = this.context.globalState.get('yandexLms.aiLessons', []) || []; } catch (e) { this.aiLessons = []; }
    }
    return this.aiLessons;
  };

  Lms.prototype.aiLessonsText = function () {
    const list = this.aiLessonsList();
    if (!list.length) return '';
    return 'ЧТО УЖЕ НАСТУПАЛО НА ГРАБЛИ (не повторяй эти ошибки, ученик их уже проходил):\n' +
      list.slice(-25).map(x => '- ' + x).join('\n') + '\n\n';
  };

  Lms.prototype.aiRememberLesson = async function (text) {
    if (!text) return;
    const s = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!s || /^нет$/i.test(s)) return;
    const list = this.aiLessonsList();
    if (list.some(x => x.toLowerCase() === s.toLowerCase())) return;
    list.push(s);
    while (list.length > 60) list.shift();
    this.aiLessons = list;
    try { await this.context.globalState.update('yandexLms.aiLessons', list); } catch (e) { }
  };

  Lms.prototype.splitLesson = function (text) {
    const s = String(text || '');
    const m = /^[ \t]*(?:\*\*)?УРОК(?:\*\*)?[ \t]*:[ \t]*(.+)$/mi.exec(s);
    if (!m) return { text: s, lesson: null };
    const lesson = m[1].trim();
    const cleaned = s.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleaned, lesson };
  };  Lms.prototype.aiLearnFromLogs = async function (data) {
    if (!data) return;
    const info = pick(data, 'testInfo');
    if (!info || typeof info !== 'object') return;
    for (const k of Object.keys(info)) {
      const v = info[k];
      if (typeof v !== 'string' || !v.trim()) continue;
      const low = v.toLowerCase();
      if (/позже|не прошли|не изучал|ещ[её] не|раньше|запрещ|использу|тема|курс/.test(low) || /сообщен|message/i.test(k)) {
        await this.aiRememberLesson('LMS: ' + v.trim());
      }
    }
  };

  Lms.prototype.aiRememberComments = async function (comments) {
    const t = this.currentTask;
    if (!t) return;
    const key = 'yandexLms.aiComments';
    const map = this.context.globalState.get(key, {}) || {};
    const list = map[t.filePath] || [];
    for (const c of comments) {
      if (c && list.indexOf(c) < 0) list.push(c);
    }
    map[t.filePath] = list;
    await this.context.globalState.update(key, map);
  };

  // ── чат с ИИ в панели задачи ──
  // Куда ИИ отвечает: 'text' — в чат панели, 'code' — в файл решения.
  // Выбор запоминается между сессиями (globalState).
  Lms.prototype.aiChatMode = function () {
    if (this._aiChatMode === undefined) {
      try { this._aiChatMode = this.context.globalState.get('yandexLms.aiChatMode', 'text'); } catch (e) { this._aiChatMode = 'text'; }
    }
    return this._aiChatMode === 'code' ? 'code' : 'text';
  };

  Lms.prototype.aiSetChatMode = async function (mode) {
    this._aiChatMode = mode === 'code' ? 'code' : 'text';
    try { await this.context.globalState.update('yandexLms.aiChatMode', this._aiChatMode); } catch (e) { }
    await this.refreshAiPanel();
  };

  // Сравнение текста файла без хвостовых пробелов и переводов строк.
  Lms.prototype.aiSameCode = function (a, b) {
    const norm = s => String(s == null ? '' : s).replace(/\r\n/g, '\n')
      .split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
    return norm(a) === norm(b);
  };

  // Ответ ИИ комментарием: в режиме «Код» файл обязан измениться даже на
  // вопрос, поэтому текст ответа превращается в строки «# …».
  // Снимаем только строки-ограждения ```python — содержимое блока остаётся
  // (иначе ответ, состоящий из одного блока кода, превращался в «не смог ответить»).
  Lms.prototype.aiCommentBlock = function (base, question, answer) {
    const body = String(answer || '')
      .replace(/^[ \t]*```[A-Za-z0-9_+-]*[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() || 'ИИ не смог ответить — переформулируйте вопрос.';
    // Метка времени гарантирует, что файл изменится даже при повторном
    // одинаковом вопросе (иначе правка была бы пустой и «ничего не произошло»).
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const head = '# ── ИИ ' + time + ': ' + (String(question || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'ответ') + ' ──';
    const lines = body.split('\n').map(l => (l.trim() ? '# ' + l.replace(/\s+$/, '') : '#'));
    const src = String(base || '').replace(/\s+$/, '');
    return (src ? src + '\n\n' : '') + head + '\n' + lines.join('\n') + '\n';
  };

  // Режим «Код»: модель возвращает новый файл целиком и обязана его изменить.
  // Если она вернула тот же код или просто текст — ответ уходит комментарием.
  Lms.prototype.aiChatToCode = async function (t, question, hist) {
    const before = this.aiCurrentCode();
    const prompt =
      'РЕЖИМ: КОД. Ты работаешь только с файлом решения ученика и пишешь только в него — в чат не отвечаешь.\n\n' +
      'УСЛОВИЕ ЗАДАЧИ:\n' + (this.aiStatement() || '(условие неизвестно)') + '\n\n' +
      'ФАЙЛ УЧЕНИКА ЦЕЛИКОМ:\n```python\n' + (before.trim() ? before : '(пока пусто)') + '\n```\n\n' +
      this.aiLessonsText() +
      this.aiStudentRules() + '\n\n' +
      (hist ? 'ИСТОРИЯ ДИАЛОГА:\n' + hist + '\n\n' : '') +
      'ВОПРОС ИЛИ ПРОСЬБА УЧЕНИКА:\n' + question + '\n\n' +
      'Верни ПОЛНЫЙ новый текст файла в одном блоке ```python ... ``` и больше ничего.\n' +
      'Правила:\n' +
      '1. Просят исправить, дописать или решить — измени код так, чтобы он стал верным.\n' +
      '2. Ученик просто спрашивает (объяснить, почему не работает, что не так) — код не переписывай, ' +
      'а добавь в файл комментарий с ответом по-русски: строки, начинающиеся с «# », или строку в тройных кавычках.\n' +
      '3. Файл ОБЯЗАН отличаться от текущего хотя бы одной строкой. Вернуть тот же код запрещено.\n' +
      '4. Только разрешённые в курсе конструкции, отступы 4 пробела, код должен компилироваться.\n' +
      '5. Без строки «УРОК:» и без пояснений вне блока кода.';
    const reply = await aiChat(
      prompt,
      this.aiSystemPrompt() + ' Ты пишешь код прямо в файл ученика и не отвечаешь в чат.',
      120000,
      this.statementImages,
      { maxTokens: 1800, temperature: 0.15 }
    );
    aiLog({ event: 'chat-code-response', raw: String(reply).slice(0, 4000) });
    const sp = this.splitLesson(reply);
    let next = this.extractCode(sp.text)
      .split('\n').filter(l => !/^\s*УРОК\s*:/i.test(l)).join('\n').trim();
    let how = 'code';
    if (!next || this.aiSameCode(before, next)) {
      next = this.aiCommentBlock(before, question, sp.text);
      how = 'comment';
    }
    if (!next.endsWith('\n')) next += '\n';
    await this.aiFileWrite(next, t);
    this.output().appendLine('=== AI: чат → файл (' + how + ') ===\n' + next);
    // Файл уже изменён — это главное. Дополнительно проверяем, что он хотя бы
    // компилируется: иначе ученик отправит на проверку заведомо битый код.
    let warn = '';
    try {
      const v = await this.aiValidateCode(next);
      const broken = v.problems.find(p => /не компилируется/.test(p));
      if (broken) warn = broken;
    } catch (e) { }
    return { how, warn };
  };

  Lms.prototype.aiChatMsgs = function (taskId) {
    if (!this.aiChatLog) this.aiChatLog = new Map();
    const key = String(taskId);
    if (!this.aiChatLog.has(key)) this.aiChatLog.set(key, []);
    return this.aiChatLog.get(key);
  };

  Lms.prototype.aiChatAdd = function (role, text) {
    const t = this.currentTask;
    if (!t) return;
    const list = this.aiChatMsgs(t.taskId);
    list.push({ role, text: String(text || ''), ts: Date.now() });
    while (list.length > 40) list.shift();
  };

  // Контекст, который подставляется под каждый вопрос автоматически.
  Lms.prototype.aiChatContext = function () {
    let ctx = 'УСЛОВИЕ ЗАДАЧИ:\n' + (this.aiStatement() || '(условие неизвестно)');
    const code = this.aiCurrentCode();
    ctx += '\n\nТЕКУЩИЙ КОД УЧЕНИКА:\n' + (code.trim() ? code : '(пока пусто)');
    const logs = this.contestLogsText();
    if (logs) ctx += '\n\nРЕЗУЛЬТАТ ПОСЛЕДНЕЙ ПРОВЕРКИ НА СЕРВЕРЕ:\n' + logs.slice(0, 2500);
    return ctx;
  };

  Lms.prototype.aiChatSend = async function (text) {
    const t = this.currentTask;
    const msg = String(text || '').trim();
    if (!t || !msg || this.aiChatBusy) return;
    if (!pool.aiHasConfig()) {
      this.aiChatAdd('ai', 'ИИ не настроен. Откройте «AI: ключи и провайдеры» (клик по статус-бару задачи снизу или палитра команд) и добавьте провайдера.');
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
      return;
    }
    // У задачи без файла кода режим «Код» невозможен — отвечаем в чат.
    const mode = this.aiChatMode() === 'code' && t.filePath ? 'code' : 'text';
    this.aiChatAdd('user', msg);
    this.aiChatBusy = true;
    this.aiChatThinking = true;
    const repaint = async () => {
      try { await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }); } catch (e) { }
    };
    try {
      await repaint();
      const list = this.aiChatMsgs(t.taskId);
      const hist = list.slice(-9, -1)
        .filter(m => m.role !== 'sys')
        .map(m => (m.role === 'user' ? 'Ученик: ' : 'ИИ: ') + String(m.text).slice(0, 2000))
        .join('\n\n');
      if (mode === 'code') {
        const r = await this.aiChatToCode(t, msg, hist);
        this.aiChatAdd('sys', (r.how === 'comment'
          ? 'Ответ записан комментарием в файл решения (Ctrl+Z — отменить).'
          : 'Изменения записаны в файл решения (Ctrl+Z — отменить).') +
          (r.warn ? ' ⚠ ' + r.warn : ''));
      } else {
        const prompt =
          this.aiChatContext() + '\n\n' +
          this.aiLessonsText() +
          (hist ? 'ИСТОРИЯ ДИАЛОГА:\n' + hist + '\n\n' : '') +
          'НОВЫЙ ВОПРОС УЧЕНИКА:\n' + msg;
        const reply = await aiChat(
          prompt,
          this.aiSystemPrompt() + ' Ты — наставник в чате: отвечай коротко и по делу, приводи фрагменты кода, где уместно. Полное решение давай, только если ученик прямо об этом попросил.',
          120000,
          this.statementImages,
          { maxTokens: 1600 }
        );
        const sp = this.splitLesson(reply);
        this.aiChatAdd('ai', sp.text);
        if (sp.lesson) await this.aiRememberLesson(sp.lesson);
        this.output().appendLine('=== AI: чат ===\n' + reply);
      }
    } catch (e) {
      this.aiChatAdd(mode === 'code' ? 'sys' : 'ai', '**Ошибка:** ' + (e.message || e));
    } finally {
      // Флаги снимаем всегда: иначе одно исключение вешает чат до перезагрузки.
      this.aiChatBusy = false;
      this.aiChatThinking = false;
    }
    await repaint();
  };

  // ── статус ИИ в панели ──
  Lms.prototype.aiStateHtml = function () {
    pool.aiPruneStates();
    const list = pool.aiEntries();
    if (!list.length) {
      return 'ИИ: <b>не настроен</b> — нажмите «AI: ключи», чтобы добавить провайдера, ключ или OpenCode CLI.';
    }
    const ready = list.filter(e => pool.aiCooldownLeft(e) === 0);
    const active = list.find(e => e.id === pool.AI_POOL_ACTIVE_REF()) || ready[0] || list[0];
    const kinds = {};
    for (const e of list) {
      const s = pool.stateOf(e) || {};
      if (pool.aiCooldownLeft(e) > 0) kinds[s.kind || 'error'] = (kinds[s.kind || 'error'] || 0) + 1;
    }
    let status;
    if (ready.length) {
      status = '<span class="ai-ok">готов</span>';
    } else if ((kinds.auth || 0) === list.length) {
      status = '<span class="ai-bad">ключи не приняты</span>';
    } else if (kinds.limit) {
      const min = Math.min.apply(null, list.map(e => pool.aiCooldownLeft(e)));
      status = '<span class="ai-warn">лимит ещё ' + Math.max(1, Math.ceil(min / 60000)) + ' мин</span>';
    } else {
      const min = Math.min.apply(null, list.map(e => pool.aiCooldownLeft(e)));
      status = '<span class="ai-warn">пауза ' + Math.max(1, Math.ceil(min / 1000)) + ' с</span>';
    }
    const tip = list.map(e => {
      const s = pool.stateOf(e) || {};
      const cd = pool.aiCooldownLeft(e);
      return pool.aiEntryLabel(e) + ' [' + pool.aiKeyTail(e.apiKey) + ']: ' +
        (cd ? (s.kind === 'limit' ? 'лимит' : (s.kind === 'auth' ? 'ключ не принят' : (s.kind === 'denied' ? 'доступ к модели закрыт' : 'пауза'))) +
          ' ещё ' + Math.ceil(cd / 1000) + ' с' + (s.lastError ? ' — ' + s.lastError : '') : 'работает');
    }).join('\n');
    // В строке — только используемый провайдер и модель; остальные ключи
    // пула и их состояния видны при наведении (tip) и в меню «AI: ключи».
    return '<span title="' + escapeHtml(tip).replace(/\n/g, '&#10;') + '">ИИ: <b>' + escapeHtml(active.label || providerDef(active.provider).label) + '</b> · ' + escapeHtml(active.model) +
      ' · ' + status +
      (ready.length < list.length ? ' · доступно ' + ready.length + '/' + list.length : '') +
      '</span>';
  };

  Lms.prototype.aiBlockHtml = function () {
    const t = this.currentTask;
    if (!t) return '';
    const list = this.aiChatMsgs(t.taskId);
    const msgs = list.map(m => {
      if (m.role === 'user') return '<div class="chat-msg chat-user">' + escapeHtml(m.text) + '</div>';
      if (m.role === 'sys') return '<div class="chat-sys">✎ ' + escapeHtml(m.text) + '</div>';
      return '<div class="chat-msg chat-ai">' + mdToHtml(m.text) + '</div>';
    }).join('');
    const thinking = this.aiChatThinking ? '<div class="chat-msg chat-ai chat-thinking">Набирает ответ…</div>' : '';
    const draft = this.aiChatDrafts ? (this.aiChatDrafts.get(String(t.taskId)) || '') : '';
    const locked = this.aiChatBusy ? ' disabled' : '';
    // Переключатель режима живёт прямо в строке ввода: «Текст» — ИИ отвечает
    // только в чат панели, «Код» — только в файл решения (и обязан его менять).
    // У заданий с вариантами ответа файла нет, поэтому переключатель не нужен.
    const mode = t.filePath ? this.aiChatMode() : 'text';
    const seg = t.filePath
      ? '<div class="seg" role="group" aria-label="Куда отвечает ИИ">' +
        '<button type="button" class="seg-btn' + (mode === 'text' ? ' active' : '') + '" data-act="aiMode" data-mode="text" aria-pressed="' + (mode === 'text') + '" title="ИИ работает только с этим чатом">Текст</button>' +
        '<button type="button" class="seg-btn' + (mode === 'code' ? ' active' : '') + '" data-act="aiMode" data-mode="code" aria-pressed="' + (mode === 'code') + '" title="ИИ работает только с файлом решения и каждый раз его меняет">Код</button>' +
        '</div>'
      : '';
    const hint = mode === 'code'
      ? 'ответ — в файл решения'
      : (t.filePath ? 'ответ — в чат' : '');
    const placeholder = mode === 'code'
      ? 'Спроси или попроси изменить код… (Enter — запишет в файл)'
      : 'Спроси ИИ о задаче… (Enter — отправить)';
    return '<div class="chat-log" id="chat-log">' + msgs + thinking + '</div>' +
      '<div class="chat-composer">' +
      '<textarea id="chat-input" rows="1" placeholder="' + placeholder + '"' + locked + '>' + escapeHtml(draft) + '</textarea>' +
      '<div class="composer-foot">' + seg +
      (hint ? '<span class="seg-hint">' + hint + '</span>' : '') +
      '<button data-act="aiChatSend" class="btn ai chat-send"' + locked + '>Отправить</button></div>' +
      '</div>';
  };

  Lms.prototype.aiStatusText = function () {
    const list = pool.aiEntries();
    if (!list.length) return 'не настроен';
    const active = list.find(e => e.id === pool.AI_POOL_ACTIVE_REF()) || list[0];
    const idx = list.indexOf(active) + 1;
    return (active.label || providerDef(active.provider).label) + ' · ' + active.model +
      ((active.provider === 'opencode' || active.provider === 'cline') ? ' · CLI' : ' · ключ ' + pool.aiKeyTail(active.apiKey)) +
      (list.length > 1 ? ' (' + idx + ' из ' + list.length + ')' : '');
  };

  // ── самопроверка и починка кода ──
  Lms.prototype.aiValidateCode = async function (code) {
    const problems = aiLint(code);
    const file = path.join(os.tmpdir(), 'yandex-lms-ai-check.py');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, code, 'utf8');
      const python = cfg().get('pythonPath') || 'python';
      const res = await runProcess(python, ['-m', 'py_compile', file], 15000);
      if (res.code !== 0) {
        const out = String(res.out || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        if (out && !/no module named|не найден|is not recognized|not found/i.test(out)) {
          problems.push('не компилируется: ' + out.slice(0, 200));
        }
      }
    } catch (e) { }
    return { ok: !problems.length, problems };
  };

  Lms.prototype.aiRepairCode = async function (code, problems, statement) {
    const prompt =
      'УСЛОВИЕ ЗАДАЧИ:\n' + String(statement || '').slice(0, 6000) + '\n\n' +
      'КОД, КОТОРЫЙ НАДО ПОЧИНИТЬ:\n```python\n' + code + '\n```\n\n' +
      'ЧТО НЕ ТАК:\n- ' + problems.join('\n- ') + '\n\n' +
      this.aiStudentRules() + '\n\n' +
      'Сохрани логику решения, но убери все нарушения: только материал курса, чтение через input(), вывод через print(). ' +
      'Ответь ТОЛЬКО кодом в одном блоке ```python, без пояснений.';
    const text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — автор эталонных решений курса.', 60000, null, { maxTokens: 1800, temperature: 0 });
    const m = /```(?:python)?\s*([\s\S]*?)```/i.exec(text);
    return (m ? m[1] : text).replace(/^\s*```.*$/gm, '').trim();
  };

  Lms.prototype.extractCode = function (text) {
    const m = /```(?:python)?\s*([\s\S]*?)```/i.exec(String(text || ''));
    return (m ? m[1] : String(text || '')).replace(/^\s*```.*$/gm, '').trim();
  };

  Lms.prototype.selfCheckAndRepair = async function (solution, statement, logPrefix) {
    let leftProblems = [];
    for (let round = 0; round < 2; round++) {
      const v = await this.aiValidateCode(solution);
      leftProblems = v.problems;
      if (v.ok) return { solution, leftProblems };
      aiLog({ event: logPrefix + '-selfcheck', round: round + 1, problems: v.problems });
      const fixed = await this.aiRepairCode(solution, v.problems, statement);
      if (!fixed || fixed === solution) break;
      solution = fixed;
    }
    const finalCheck = await this.aiValidateCode(solution);
    return { solution, leftProblems: finalCheck.problems };
  };

  // ── главный сценарий: hints / check / solve ──
  Lms.prototype.aiRun = async function (mode) {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      return;
    }
    if (!pool.aiHasConfig()) {
      const go = await vscode.window.showInformationMessage('ИИ не настроен. Добавить провайдера (API-ключ или OpenCode CLI) сейчас?', 'Настроить');
      if (go === 'Настроить') await this.aiKeysUI();
      return;
    }
    const statement = this.aiStatement();
    if (!statement) {
      vscode.window.showWarningMessage('LMS: не удалось получить условие задачи (откройте задание заново).');
      return;
    }
    const code = this.aiCurrentCode();
    aiLog({ event: 'start', mode, pool: pool.aiEntries().map(e => pool.aiEntryLabel(e)), filePath: t.filePath, codeLen: code.length, statementLen: statement.length });
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: ИИ думает… (' + this.aiStatusText() + ')' }, async () => {
      try {
        if (mode === 'check') {
          const prompt =
            'УСЛОВИЕ ЗАДАЧИ:\n' + statement + '\n\n' +
            'КОД УЧЕНИКА:\n' + (code || '(код пуст)') + '\n\n' +
            this.aiLessonsText() +
            this.aiStudentRules() + '\n\n' +
            'Проверь решение ученика: правильность логики, соответствие условию, граничные случаи, читаемость. ' +
            'Если ученик использовал запрещённые конструкции (import, sys, классы, try/except и т.п.) — прямо укажи это, такой код проверка не примет.\n' +
            'Ответь markdown-списком:\n' +
            '1. **Вердикт:** Верно / Есть ошибки / Не дописано.\n' +
            '2. **Что не так** — список конкретных замечаний (с указанием строк).\n' +
            '3. **Как исправить** — что дописать или заменить, без готового кода целиком.\n' +
            'Пиши по-русски, коротко. Без markdown-заголовков #, только жирные подписи и списки.\n' +
            'В самом конце добавь отдельную строку: УРОК: <одно предложение — какую ошибку ученик делает повторно и как её избежать>. Если повторяющихся ошибок нет — напиши «УРОК: нет».';
          const text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — строгий, но доброжелательный проверяющий.', 60000, this.statementImages, { maxTokens: 900 });
          const sp = this.splitLesson(text);
          this.aiChatAdd('ai', '**Проверка решения**\n\n' + sp.text);
          if (sp.lesson) await this.aiRememberLesson(sp.lesson);
          this.output().appendLine('=== AI: проверка решения ===\n' + text);
          await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
          vscode.window.showInformationMessage('LMS: проверка ИИ готова — в чате панели.');
          return;
        }
        if (mode === 'hints') {
          const prompt =
            'УСЛОВИЕ ЗАДАЧИ:\n' + statement + '\n\n' +
            'КОД УЧЕНИКА (может быть пустым):\n' + (code || '(код пуст)') + '\n\n' +
            this.aiLessonsText() +
            this.aiStudentRules() + '\n\n' +
            'Дай пошаговые ПОДСКАЗКИ, чтобы ученик дописал решение сам.\n' +
            'Правила:\n' +
            '1. Пиши по-русски, в императиве: «создай ...», «теперь ...», «посчитай ...».\n' +
            '2. 3–6 шагов, каждый — 1–2 предложения.\n' +
            '3. НЕ пиши готовый код: только что делать, какие переменные создать, какую формулу вывести, что напечатать.\n' +
            '4. Опирайся на конкретику условия (числа, названия, ограничения).\n' +
            '5. Учитывай, что ученик уже написал: не предлагай то, что уже сделано, — продолжай с текущего места.\n' +
            '6. Учитывай список ошибок выше: не подсказывай то, что ученик уже наступал.\n' +
            'Формат ответа: markdown-нумерованный список шагов, без заголовков #, без блоков кода.\n' +
            'В самом конце добавь строку: УРОК: <одно предложение о типичной ошибке в этом задании>. Если ошибок нет — «УРОК: нет».';
          const text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — наставник, который ведёт ученика за руку, но не даёт готового решения.', 60000, this.statementImages, { maxTokens: 900 });
          const sp = this.splitLesson(text);
          this.aiChatAdd('ai', '**Подсказки**\n\n' + sp.text);
          if (sp.lesson) await this.aiRememberLesson(sp.lesson);
          this.output().appendLine('=== AI: подсказки ===\n' + text);
          await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
          vscode.window.showInformationMessage('LMS: подсказки ИИ — в чате панели.');
          return;
        }
        // mode === 'solve'
        const prompt =
          'УСЛОВИЕ ЗАДАЧИ:\n' + statement + '\n\n' +
          this.aiLessonsText() +
          this.aiStudentRules() + '\n\n' +
          'Напиши полное решение задачи на Python.\n' +
          'Сначала молча (в уме, без вывода) разбери: что подаётся на вход, в каком формате, какие граничные случаи возможны ' +
          '(пустой ввод, ноль, отрицательные числа, одна строка, повторы), и есть ли в условии примеры — сверь свой код с ними.\n' +
          'Требования к коду:\n' +
          '1. Только разрешённые конструкции курса (см. выше), без import и sys.\n' +
          '2. Чтение через input(), вывод строго в формате из условия (лишних строк и подсказок не печатать).\n' +
          '3. Решение должно работать для всех допустимых входных данных, а не только для примера.\n' +
          '4. Отступы 4 пробела, код компилируется без ошибок.\n' +
          'В конце ответа добавь строку: УРОК: <одно предложение — на какую типичную граблю здесь можно наступить>. Если нет — «УРОК: нет».\n' +
          'Ответь ТОЛЬКО кодом в одном блоке ```python ... ```.';
        const text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — автор эталонных решений курса.', 90000, this.statementImages, { maxTokens: 1800, temperature: 0.15 });
        aiLog({ event: 'response', mode, raw: String(text).slice(0, 6000) });
        const sp = this.splitLesson(text);
        let solution = this.extractCode(sp.text);
        if (!solution) throw new Error('Модель вернула пустое решение.');
        let leftProblems = [];
        if (cfg().get('ai.selfCheck') !== false) {
          const r = await this.selfCheckAndRepair(solution, statement, 'solve');
          solution = r.solution;
          leftProblems = r.leftProblems;
        }
        if (sp.lesson) await this.aiRememberLesson(sp.lesson);
        await this.aiFileWrite(solution + '\n', t);
        let exLine = '';
        try {
          const ex = await this.runLocalExamples();
          if (ex.ran) exLine = '\n\nПримеры из условия: ' + (ex.ok === ex.ran ? 'все сошлись (' + ex.ok + '/' + ex.ran + ')' : 'сошлись ' + ex.ok + ' из ' + ex.ran + ' — подробности в блоке «Примеры» ниже');
        } catch (e) { }
        this.aiChatAdd('ai', 'Решение вставлено в файл:\n\n```python\n' + solution + '\n```' +
          (leftProblems.length ? '\n\n⚠ Не удалось убрать: ' + leftProblems.join('; ') : '') + exLine);
        this.output().appendLine('=== AI: решение ===\n' + solution);
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
        vscode.window.showInformationMessage('LMS: решение ИИ вставлено в файл (Ctrl+Z — отменить).');
      } catch (e) {
        aiLog({ event: 'error', mode, error: String(e.message || e) });
        vscode.window.showErrorMessage('LMS: ИИ: ' + (e.message || e));
        this.output().appendLine('AI error: ' + (e.message || e));
      }
    });
  };

  Lms.prototype.aiFix = async function () {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      return;
    }
    if (!pool.aiHasConfig()) {
      const go = await vscode.window.showInformationMessage('ИИ не настроен. Добавить провайдера (API-ключ или OpenCode CLI) сейчас?', 'Настроить');
      if (go === 'Настроить') await this.aiKeysUI();
      return;
    }
    const code = this.aiCurrentCode();
    if (!code.trim()) {
      vscode.window.showWarningMessage('LMS: файл пуст, нечего исправлять.');
      return;
    }
    const statement = this.aiStatement();
    let details = this.contestLogsText();
    if (!details) {
      await this.refreshContestLogs();
      details = this.contestLogsText();
    }
    if (!details) {
      vscode.window.showWarningMessage('LMS: нет данных о проверке. Сначала отправь решение.');
      return;
    }
    aiLog({ event: 'ai-fix-start', details: details.slice(0, 2000) });
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: ИИ разбирает ошибку…' }, async () => {
      try {
        const prompt =
          'УСЛОВИЕ ЗАДАЧИ:\n' + statement + '\n\n' +
          'КОД УЧЕНИКА:\n' + code + '\n\n' +
          'РЕЗУЛЬТАТ ПРОВЕРКИ НА СЕРВЕРЕ:\n' + details + '\n\n' +
          this.aiLessonsText() +
          this.aiStudentRules() + '\n\n' +
          'Код не засчитан. Найди ошибку и верни ИСПРАВЛЕННЫЙ код целиком.\n' +
          'ВАЖНО: если в сообщении проверки сказано, что ученик ещё не проходил какую-то тему (например «списки и индексы строк будут немного позже»), ' +
          'то решение обязано обходиться без этой темы — используй только строки, циклы и условия, которые ученик уже прошёл.\n' +
          'Не объясняй ошибку в тексте — просто дай рабочий код.\n' +
          'В конце ответа (после блока кода) добавь строку: УРОК: <одно предложение — в чём была ошибка и как её избежать в следующий раз>.\n' +
          'Ответь ТОЛЬКО кодом в одном блоке ```python ... ``` и этой строкой.';
        const text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — автор эталонных решений курса, исправляешь решения учеников.', 90000, this.statementImages, { maxTokens: 1800, temperature: 0.15 });
        aiLog({ event: 'ai-fix-response', raw: String(text).slice(0, 4000) });
        const sp = this.splitLesson(text);
        let fixed = this.extractCode(sp.text);
        if (!fixed) throw new Error('Модель вернула пустой код.');
        if (cfg().get('ai.selfCheck') !== false) {
          const r = await this.selfCheckAndRepair(fixed, statement, 'fix');
          fixed = r.solution;
        }
        await this.aiFileWrite(fixed + '\n', t);
        if (sp.lesson) await this.aiRememberLesson(sp.lesson);
        let fixExLine = '';
        try {
          const ex = await this.runLocalExamples();
          if (ex.ran) fixExLine = '\n\nПримеры из условия: ' + (ex.ok === ex.ran ? 'все сошлись (' + ex.ok + '/' + ex.ran + ')' : 'сошлись ' + ex.ok + ' из ' + ex.ran + ' — подробности в блоке «Примеры» ниже');
        } catch (e) { }
        this.aiChatAdd('ai', 'Исправленный код по ошибке проверки записан в файл.\n\n```python\n' + fixed + '\n```' + fixExLine);
        this.output().appendLine('=== AI: исправление ===\n' + fixed);
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
        vscode.window.showInformationMessage('LMS: исправленный код записан в файл (Ctrl+Z — отменить).');
      } catch (e) {
        aiLog({ event: 'ai-fix-error', error: String(e.message || e) });
        vscode.window.showErrorMessage('LMS: ИИ: ' + (e.message || e));
      }
    });
  };

  Lms.prototype.aiClear = async function () {
    const t = this.currentTask;
    let clearedPanel = false;
    const hadChat = !!(t && this.aiChatLog && (this.aiChatLog.get(String(t.taskId)) || []).length);
    if (hadChat || this.pep8Report) {
      if (this.aiChatLog) this.aiChatLog.delete(String(t && t.taskId));
      this.pep8Report = null;
      clearedPanel = true;
    }
    if (!t || !t.filePath) {
      if (clearedPanel) {
        await this.showTaskPanel(this.detailCache.get(String(t && t.taskId)) || { title: t && t.taskTitle });
        vscode.window.showInformationMessage('LMS: чат с ИИ очищен.');
      } else {
        vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      }
      return;
    }
    const key = 'yandexLms.aiComments';
    const map = this.context.globalState.get(key, {}) || {};
    const list = (map[t.filePath] || []).slice();
    if (!list.length) {
      if (clearedPanel) {
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
        vscode.window.showInformationMessage('LMS: чат с ИИ очищен.');
      } else {
        vscode.window.showInformationMessage('LMS: подсказок ИИ в файле нет.');
      }
      return;
    }
    let doc;
    try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.filePath)); } catch (e) { return; }
    const out = [];
    for (const line of doc.getText().split('\n')) {
      const idx = list.findIndex(c => c && c.trim() === line.trim());
      if (idx >= 0) { list.splice(idx, 1); continue; }
      out.push(line);
    }
    map[t.filePath] = list;
    await this.context.globalState.update(key, map);
    try {
      await this.aiFileWrite(out.join('\n'), t);
      vscode.window.showInformationMessage('LMS: подсказки ИИ удалены (Ctrl+Z — отменить).');
    } catch (e) {
      vscode.window.showErrorMessage('LMS: не удалось очистить подсказки: ' + (e.message || e));
    }
  };

  Lms.prototype.refreshAiPanel = async function () {
    if (!this.currentTask) return;
    try {
      await this.showTaskPanel(this.detailCache.get(String(this.currentTask.taskId)) || { title: this.currentTask.taskTitle });
    } catch (e) { }
  };

  // ── проверка ключей ──
  // opts.silent — не показывать уведомления (результат выводит сама панель настроек).
  Lms.prototype.aiTestEntry = async function (entry, opts) {
    const silent = !!(opts && opts.silent);
    entry = Object.assign({}, entry, { id: pool.aiEntryId(entry) });
    const t0 = Date.now();
    try {
      if (entry.provider === 'opencode') {
        const ver = await openCodeVersion(entry.bin);
        if (!ver) throw new Error('opencode не найден или не запустился (проверьте установку и путь)');
        const res = await aiChatOnce(entry, 'Ответь одним словом: работает?', 'Отвечай кратко.', 120000, null, {}, new AbortController());
        const s = ((Date.now() - t0) / 1000).toFixed(1);
        pool.aiMarkOk(entry, Date.now() - t0);
        this.output().appendLine('AI: ' + pool.aiEntryLabel(entry) + ' — opencode ' + ver + ', ответ за ' + s + ' с: ' + res.text.slice(0, 60));
        if (!silent) vscode.window.showInformationMessage('LMS: ' + pool.aiEntryLabel(entry) + ' — работает (opencode ' + ver + '), ' + s + ' с.');
        return true;
      }
      if (entry.provider === 'cline') {
        const ver = await clineVersion(entry.bin);
        if (!ver) throw new Error('cline не найден или не запустился (проверьте установку и путь)');
        const res = await aiChatOnce(entry, 'Ответь одним словом: работает? Файлы не создавай.', 'Отвечай кратко.', 120000, null, {}, new AbortController());
        const s = ((Date.now() - t0) / 1000).toFixed(1);
        pool.aiMarkOk(entry, Date.now() - t0);
        this.output().appendLine('AI: ' + pool.aiEntryLabel(entry) + ' — cline ' + ver + ', ответ за ' + s + ' с: ' + res.text.slice(0, 60));
        if (!silent) vscode.window.showInformationMessage('LMS: ' + pool.aiEntryLabel(entry) + ' — работает (cline ' + ver + '), ' + s + ' с.');
        return true;
      }
      const res = await aiChatOnce(entry, 'Ответь одним словом: работает?', 'Отвечай кратко.', 30000, null, { maxTokens: 20, temperature: 0 }, new AbortController());
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      pool.aiMarkOk(entry, Date.now() - t0);
      this.output().appendLine('AI: ' + pool.aiEntryLabel(entry) + ' [' + pool.aiKeyTail(entry.apiKey) + '] — ок за ' + s + ' с: ' + res.text.slice(0, 60));
      if (!silent) vscode.window.showInformationMessage('LMS: ' + pool.aiEntryLabel(entry) + ' — работает, ' + s + ' с.');
      return true;
    } catch (e) {
      pool.aiMarkFail(entry, e);
      const msg = String((e && e.message) || e).slice(0, 200);
      this.output().appendLine('AI: ' + pool.aiEntryLabel(entry) + ' — ошибка: ' + msg);
      // Модель opencode блокирована политикой приватности — пробуем подобрать
      // рабочую модель автоматически (big-pickle / локальная ollama).
      if (entry.provider === 'opencode' && /trains on request data|политикой приватности/i.test(msg)) {
        const picked = await this.aiPickOpenCodeModel(entry);
        if (picked) return true;
      }
      // Бесплатная модель cline снята с раздачи или перегружена — подбираем другую.
      if (entry.provider === 'cline' && /free promotion|no longer available|rate-limited upstream|usage limit/i.test(msg)) {
        const picked = await this.aiPickClineModel(entry);
        if (picked) return true;
      }
      if (!silent) vscode.window.showWarningMessage('LMS: ' + pool.aiEntryLabel(entry) + ' — ' + msg);
      return false;
    }
  };

  // Перебирает известные рабочие модели opencode и ставит первую отвечающую.
  Lms.prototype.aiPickOpenCodeModel = async function (entry) {
    const self = this;
    const picked = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LMS: подбираю рабочую модель opencode…' },
      async () => {
        for (const model of OPENCODE_FALLBACK_MODELS) {
          try {
            await openCodeProbeModel(entry, model);
            return model;
          } catch (e) {
            self.output().appendLine('AI: пробная модель ' + model + ' — не отвечает: ' + String((e && e.message) || e).slice(0, 120));
          }
        }
        return null;
      }
    );
    if (!picked) {
      vscode.window.showWarningMessage('LMS: ни одна из известных моделей opencode не ответила (opencode/big-pickle, ollama/*). Запустите Ollama: «ollama serve».');
      return false;
    }
    pool.poolSetModel(entry.id, picked);
    pool.aiMarkOk(entry, 0);
    await this.refreshAiPanel();
    vscode.window.showInformationMessage('LMS: рабочая модель подобрана автоматически — ' + picked);
    return true;
  };

  // Перебирает известные бесплатные модели cline и ставит первую отвечающую.
  Lms.prototype.aiPickClineModel = async function (entry) {
    const self = this;
    const picked = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LMS: подбираю рабочую модель cline…' },
      async () => {
        for (const model of CLINE_FALLBACK_MODELS) {
          try {
            await clineProbeModel(entry, model);
            return model;
          } catch (e) {
            self.output().appendLine('AI: пробная модель cline ' + model + ' — не отвечает: ' + String((e && e.message) || e).slice(0, 120));
          }
        }
        return null;
      }
    );
    if (!picked) {
      vscode.window.showWarningMessage('LMS: ни одна из известных бесплатных моделей cline не ответила. Проверьте «cline auth» в терминале или выберите модель вручную.');
      return false;
    }
    pool.poolSetModel(entry.id, picked);
    pool.aiMarkOk(entry, 0);
    await this.refreshAiPanel();
    vscode.window.showInformationMessage('LMS: рабочая модель подобрана автоматически — ' + picked);
    return true;
  };

  Lms.prototype.aiTest = async function () {
    const list = pool.aiEntries();
    if (!list.length) {
      vscode.window.showWarningMessage('LMS: ИИ не настроен — добавьте ключ или OpenCode CLI.');
      return;
    }
    const lines = [];
    for (const e of list) {
      const ok = await this.aiTestEntry(e);
      lines.push((ok ? '✓ ' : '✗ ') + pool.aiEntryLabel(e) + ' [' + pool.aiKeyTail(e.apiKey) + ']');
    }
    this.output().appendLine('=== AI: проверка ключей ===\n' + lines.join('\n'));
    const okCount = lines.filter(l => l.startsWith('✓')).length;
    vscode.window.showInformationMessage('LMS: ИИ — работает ' + okCount + ' из ' + list.length + '. Подробности в выводе «LMS».');
    await this.refreshAiPanel();
  };

  // ── настройки ──
  // Всё, что раньше собиралось цепочкой QuickPick/InputBox, живёт в одной
  // панели настроек (src/settings.js). Обёртки оставлены, чтобы старые
  // команды и вызовы «Настроить» открывали тот же экран.
  Lms.prototype.aiSettingsUI = async function () {
    return this.openSettings('aiBehavior');
  };

  Lms.prototype.aiKeysUI = async function () {
    return this.openSettings('ai');
  };

  Lms.prototype.aiAddOpenCode = async function () {
    return this.openSettings('ai', { provider: 'opencode' });
  };

  Lms.prototype.aiAddCline = async function () {
    return this.openSettings('ai', { provider: 'cline' });
  };
}

module.exports = { attach, DEFAULT_COURSE_RULES };
