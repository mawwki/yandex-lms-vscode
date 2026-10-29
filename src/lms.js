// Ядро расширения: сессия, задачи, отправка решений, статусы, файлы, PEP 8,
// текстовый вид условия. ИИ-функции подключаются из src/ai/features.js,
// задания с вариантами — из src/markers.js, панель — из src/panel.js,
// диагностика — из src/diagCommands.js.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { cfg } = require('./cfg');
const { CookieJar } = require('./cookies');
const { LmsClient } = require('./client');
const { LmsTreeProvider } = require('./tree');
const {
  VERDICTS, pick, safeName, sleep, escapeHtml, stripTemplate, latestSubmissionOf,
  statusBadge, htmlToMarkdown, runProcess, runProcessInput, asArray, mdToPlainText,
  normalizeOutput, parseExamples, isOkVerdict, verdictLabel, flattenLessonTasks
} = require('./util');
const { diagDir, submitLog } = require('./diag');
const { attach: attachPanel } = require('./panel');
const { attach: attachMarkers } = require('./markers');
const { attach: attachAi } = require('./ai/features');
const { attach: attachDiag } = require('./diagCommands');
const { attach: attachSettings } = require('./settings');
const { attach: attachLens } = require('./lens');
const { attach: attachMaterial } = require('./material');
const { attach: attachGrades } = require('./grades');

const SECRET_COOKIES = 'yandexLms.cookies';
const SECRET_LOGIN = 'yandexLms.login';

// Статусы, для которых нужен вердикт: список задач отдаёт только type, а вердикт
// («ok», «wrong-answer») лежит в latestSubmission решения. Если его не дотянуть,
// зачтённая задача рисуется как «на доработку».
const CHECKED_STATUS_TYPES = [
  'rework', 'wrong', 'not-solved', 'uploaded', 'review', 'auto-review',
  'accepted', 'accepted-after-deadline', 'samples-passed', 'partial-accepted',
  'assigned-to-p2p', 'on-clarifying'
];

// VS Code отдаёт viewType webview-вкладки с префиксом mainThreadWebview-.
// С WebviewPanel.viewType его нужно сравнивать без префикса, иначе панель
// материала попадает в список «закрыть всё остальное» и закрывается сама.
const WEBVIEW_TAB_PREFIX = 'mainThreadWebview-';
function normalizeTabViewType(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return s.indexOf(WEBVIEW_TAB_PREFIX) === 0 ? s.slice(WEBVIEW_TAB_PREFIX.length) : s;
}

class LmsContentProvider {
  constructor(lms) {
    this.lms = lms;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  provideTextDocumentContent(uri) {
    return this.lms.buildTaskDocText(uri);
  }
  refresh(uri) {
    this._onDidChange.fire(uri);
  }
}

class Lms {
  constructor(context) {
    this.context = context;
    this.jar = new CookieJar();
    this.client = new LmsClient(this.jar, cfg().get('apiBase'));
    this.profileJson = null;
    this.tree = new LmsTreeProvider(this);
    this.panel = null;
    this.currentTask = null;
    this.lastAttempts = [];
    this.statusMap = new Map();
    this.statusBusy = false;
    this.detailCache = new Map();
    // Прогресс и баллы: снимок ведомости («LMS: Мои оценки») в памяти и в
    // globalState — дерево рисует полоски сразу, без запросов к LMS.
    this.progressMap = new Map();    // lessonId → { passed, total, score, scoreMax, overdue, ts }
    this.courseProgress = new Map(); // courseId → { passed, total, score, scoreMax, title, ts }
    this.gradesPanel = null;
    this.gradesSnap = null;
    this.gradesReady = false;
    this.aiChatLog = new Map();     // taskId → [{role:'user'|'ai', text, ts}]
    this.aiChatDrafts = new Map();  // taskId → черновик ввода чата
    this.aiChatBusy = false;
    this.aiChatThinking = false;
    this.pep8Report = null;
    this.contestLogs = null;
    this.contestLogsSubmissionId = null;
    this.verdictReasonOpen = null;
    this.examples = null;
    this.webviewBroken = false;
    this.warnedHomeDir = false;
    // Панель материала (учебника) живёт отдельно от панели условия: можно
    // читать теорию и писать решение одновременно.
    this.materialPanel = null;
    this.currentMaterial = null;
    this.materialCache = new Map();
    this.materialReady = false;
    this.materialViewCounter = 0;
    this.materialWatchToken = null;
    this.materialFallback = false;
    this.materialTextMode = false;
    this.materialFallbackNotified = false;
    this.materialDocUri = null;
    this.prevCodePath = null;
    this.docProvider = new LmsContentProvider(this);
    this.taskDocUri = null;
    this.taskStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    this.taskStatusBar.command = 'yandexLms.taskMenu';
    this.taskStatusBar.hide();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusBar.command = 'yandexLms.loginMenu';
    this.statusBar.text = '$(circle-slash) LMS: не вход';
    this.statusBar.tooltip = 'Яндекс LMS — нажмите для входа (QR, пароль, cookie)';
    this.statusBar.show();
    this.client.onAttempt = (label, method, url, status, body, reqBody) => {
      const o = this.output();
      o.appendLine(`${method} ${url} → ${status}`);
      o.appendLine(`  [${label}] ${String(body).slice(0, 400)}`);
      submitLog({ label, method, url, status, req: reqBody || null, res: String(body).slice(0, 8000) });
    };
  }

  async init() {
    // Снимок оценок прошлой сессии — чтобы дерево показывало прогресс до
    // первого обращения к LMS (и офлайн, если сеть недоступна).
    try { await this.primeGrades(); } catch (e) { }
    const saved = await this.context.secrets.get(SECRET_COOKIES);
    if (saved) {
      this.jar.restore(saved);
      await this.refreshProfile(true);
    }
    // Состояние «webview сломан» переживает перезагрузку окна: пока кэш
    // service worker не очищен, панель не открываем и ошибку не показываем.
    try {
      this.webviewBroken = !!(await this.context.globalState.get('yandexLms.webviewBroken'));
    } catch (e) { }
  }

  setWebviewBroken(v) {
    this.webviewBroken = !!v;
    try { this.context.globalState.update('yandexLms.webviewBroken', this.webviewBroken); } catch (e) { }
  }

  async persist() {
    if (this.jar.isEmpty()) {
      await this.context.secrets.delete(SECRET_COOKIES);
    } else {
      await this.context.secrets.store(SECRET_COOKIES, this.jar.serialize());
    }
  }

  courseList() {
    if (!this.profileJson) return [];
    const summary = pick(this.profileJson, 'coursesSummary', 'courses_summary');
    const student = summary ? pick(summary, 'student') : null;
    return Array.isArray(student) ? student : [];
  }

  courseLabel(c) {
    const title = pick(c, 'title') || 'Курс';
    const group = pick(c, 'group');
    const gtitle = group ? pick(group, 'title') : null;
    return gtitle ? `${title} — ${gtitle}` : title;
  }

  async refreshProfile(silent) {
    const r = await this.client.profile();
    if (r.status === 200 && r.json) {
      this.profileJson = r.json;
      const name = pick(this.profileJson.profile, 'firstName', 'first_name', 'fullName', 'full_name', 'login');
      this.statusBar.text = '$(check) LMS: ' + (name || 'вход выполнен');
      this.statusBar.tooltip = 'Яндекс LMS — вход выполнен';
      this.refreshAllStatuses();
      this.tree.refresh();
      return true;
    }
    if (!silent) {
      vscode.window.showErrorMessage('LMS: не удалось получить профиль (HTTP ' + r.status + ').');
    }
    this.statusBar.text = '$(circle-slash) LMS: сессия истекла';
    return false;
  }

  async ensureAuth() {
    if (this.profileJson && !this.jar.isEmpty()) return true;
    const saved = await this.context.secrets.get(SECRET_COOKIES);
    if (saved) {
      this.jar.restore(saved);
      if (await this.refreshProfile(true)) return true;
    }
    const choice = await vscode.window.showWarningMessage(
      'Нужно войти в Яндекс LMS.',
      'Войти по QR', 'Войти (логин/пароль)', 'Войти по cookie', 'Инструкция'
    );
    if (choice === 'Войти по QR') {
      await vscode.commands.executeCommand('yandexLms.loginQr');
      return !!this.profileJson;
    }
    if (choice === 'Войти (логин/пароль)') {
      await vscode.commands.executeCommand('yandexLms.login');
      return !!this.profileJson;
    }
    if (choice === 'Войти по cookie') {
      await vscode.commands.executeCommand('yandexLms.loginByCookie');
      return !!this.profileJson;
    }
    if (choice === 'Инструкция') {
      await vscode.commands.executeCommand('yandexLms.welcome');
    }
    return false;
  }

  // ── файлы решений ──
  baseDir() {
    const folderName = cfg().get('folderName') || 'yandex-lms';
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) return path.join(folders[0].uri.fsPath, folderName);
    // Без открытой папки пишем в домашнюю директорию — предупреждаем один раз.
    if (!this.warnedHomeDir) {
      this.warnedHomeDir = true;
      vscode.window.showInformationMessage('LMS: рабочая папка не открыта — решения складываются в ~/' + folderName + '. Откройте папку в VS Code, чтобы хранить их в проекте.');
    }
    return path.join(os.homedir(), folderName);
  }

  taskFileDir(courseTitle, lessonTitle) {
    return path.join(this.baseDir(), safeName(courseTitle), safeName(lessonTitle));
  }

  findExistingTaskFile(ids) {
    const wanted = new Set((ids || []).filter(v => v !== undefined && v !== null).map(v => String(v)));
    if (!wanted.size) return null;
    const base = this.baseDir();
    if (!fs.existsSync(base)) return null;
    const stack = [[base, 0]];
    let best = null;
    while (stack.length) {
      const [dir, depth] = stack.pop();
      if (depth > 5) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          stack.push([path.join(dir, ent.name), depth + 1]);
          continue;
        }
        if (!ent.isFile() || !/\.py$/i.test(ent.name)) continue;
        const m = /^(\d+)[-_.]/.exec(ent.name);
        if (!m || !wanted.has(m[1])) continue;
        const full = path.join(dir, ent.name);
        try {
          const st = fs.statSync(full);
          if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
        } catch (e) { }
      }
    }
    return best ? best.path : null;
  }

  resolveTaskFile(courseTitle, lessonTitle, detail, treeTaskId) {
    const id = pick(detail, 'id') !== undefined ? pick(detail, 'id') : treeTaskId;
    const title = pick(detail, 'shortTitle', 'short_title') || pick(detail, 'title') || 'задача';
    const dir = this.taskFileDir(courseTitle, lessonTitle);
    const expected = path.join(dir, `${id}-${safeName(title)}.py`);
    if (fs.existsSync(expected)) return expected;
    const existing = this.findExistingTaskFile([id, treeTaskId]);
    if (existing) return existing;
    return expected;
  }

  // ── открытие задания ──
  async openTask(node) {
    if (!(await this.ensureAuth())) return;
    const task = node.task;
    const groupId = node.groupId;
    await this.saveActiveIfDirty();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: загружаю задание…' }, async () => {
      const det = await this.client.task(task.id, groupId);
      if (det.status !== 200 || !det.json) {
        vscode.window.showErrorMessage('LMS: не удалось загрузить задание (HTTP ' + det.status + ')');
        return;
      }
      const detail = det.json;
      this.detailCache.set(String(detail.id || task.id), detail);
      const isMarkers = this.isMarkersTask(detail);
      const solutionId = pick(detail, 'solutionId', 'solution_id');
      let serverCode = null;
      let verdictInfo = pick(detail, 'latestSubmission', 'latest_submission');
      let problemDefinition = null;
      let markersQuestion = '';
      this.currentStatementHtml = null;
      this.statementImages = [];
      this.inlinedText = new Map();
      this.examples = null;
      if (isMarkers) {
        const pd = await this.fetchProblemDefinition({ taskId: detail.id || task.id, solutionId, groupId });
        problemDefinition = pd.problem || null;
        const desc = pick(detail, 'description', 'statement', 'content');
        if (desc) markersQuestion = String(desc);
        else {
          const blocks = this.markersBlocks(problemDefinition);
          for (const b of blocks) {
            const c = pick(b, 'content') || {};
            const txt = pick(c, 'text');
            if (txt) markersQuestion += String(txt) + '\n';
          }
          markersQuestion = markersQuestion.trim();
        }
        this.output().appendLine('LMS: задание с вариантами ответа. Источник данных: ' + (pd.source || 'не найден'));
        const assetsM = await this.prepareStatement(detail);
        this.currentStatementHtml = assetsM.html;
        this.statementImages = assetsM.images;
        // Картинки-ресурсы ({resource:N}) могут лежать и в detail.storeContainer,
        // и в problemDefinition.storeContainer — сливаем оба источника.
        const resA = pick(detail, 'storeContainer') ? pick(pick(detail, 'storeContainer'), 'resources') : null;
        const pdSc = problemDefinition ? pick(problemDefinition, 'storeContainer') : null;
        const resB = pdSc ? pick(pdSc, 'resources') : null;
        const mergedRes = Object.assign({}, resA || {}, resB || {});
        const resMap = await this.loadResources(Object.keys(mergedRes).length ? mergedRes : null);
        if (resMap.size) this.output().appendLine('LMS: загружено ресурсов-картинок: ' + resMap.size);
        const qparts = [];
        for (const b of this.markersBlocks(problemDefinition)) {
          const c = pick(b, 'content') || {};
          const txt = pick(c, 'text');
          if (!txt) continue;
          let text = this.substituteResources(txt, resMap);
          this.collectStatementImages(text);
          if (/<img/i.test(text)) {
            const a2 = await this.inlineImages(text);
            this.inlinedText.set(txt, a2.html);
            for (const im of a2.images) this.statementImages.push(im);
            text = a2.html;
          }
          qparts.push(text);
        }
        if (qparts.length) markersQuestion = qparts.join('\n\n');
      } else if (solutionId) {
        const sol = await this.solutionState(solutionId);
        if (sol && sol.status === 200 && sol.json) {
          const file = pick(sol.json, 'file') || pick(pick(sol.json, 'solution'), 'file');
          serverCode = file ? pick(file, 'sourceCode', 'source_code') : null;
          verdictInfo = latestSubmissionOf(sol.json) || verdictInfo;
          if (!serverCode && file) {
            const url = pick(file, 'url');
            if (url) {
              try {
                const fr = await this.client.raw('GET', url, {});
                serverCode = await fr.text();
              } catch (e) { }
            }
          }
        }
      }
      if (!isMarkers) {
        // Картинки условия скачиваем с авторизацией и встраиваем как data-URI.
        const sc = pick(detail, 'storeContainer');
        const resMap = await this.loadResources(sc ? pick(sc, 'resources') : null);
        const descRaw = String(pick(detail, 'description', 'statement', 'content') || '');
        const descWithRes = this.substituteResources(descRaw, resMap);
        const assets = await this.inlineImages(descWithRes);
        this.currentStatementHtml = assets.html;
        this.statementImages = assets.images;
        this.collectStatementImages(assets.html);
      }
      let compilers = pick(detail, 'compilersIds', 'compilers_ids') || [];
      if (!compilers.length) {
        const byExt = pick(detail, 'taskCompilers', 'compilersTemplate') || {};
        for (const list of Object.values(byExt)) {
          if (Array.isArray(list)) compilers = compilers.concat(list);
        }
      }
      compilers = compilers.filter((v, i, a) => v && a.indexOf(v) === i);
      let filePath = null;
      let created = false;
      if (!isMarkers) {
        filePath = this.resolveTaskFile(node.courseTitle, node.lessonTitle, detail, task.id);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, stripTemplate(String(serverCode || '')), 'utf8');
          created = true;
        } else {
          try {
            const cur = fs.readFileSync(filePath, 'utf8');
            const clean = stripTemplate(cur);
            if (clean !== cur) {
              const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
              if (!open || !open.isDirty) {
                fs.writeFileSync(filePath, clean, 'utf8');
                this.output().appendLine('LMS: удалён шаблон main() из ' + path.basename(filePath));
              }
            } else if (!cur.trim() && serverCode && String(serverCode).trim()) {
              fs.writeFileSync(filePath, stripTemplate(String(serverCode)), 'utf8');
            }
          } catch (e) { }
        }
        // предыдущее окно кода закрываем — одна задача, одно окно
        if (this.prevCodePath && this.prevCodePath !== filePath) {
          await this.closeTabByPath(this.prevCodePath);
        }
        this.prevCodePath = filePath;
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two, false);
        if (created) {
          vscode.window.showInformationMessage('LMS: создан файл ' + path.basename(filePath));
        }
      } else {
        // заданию с вариантами ответа код не нужен — окно кода закрываем
        if (this.prevCodePath) {
          await this.closeTabByPath(this.prevCodePath);
          this.prevCodePath = null;
        }
      }
      this.currentTask = {
        taskId: detail.id || task.id,
        solutionId,
        groupId,
        compilerId: compilers[0],
        compilers,
        filePath,
        isMarkers,
        problemDefinition,
        markersQuestion,
        taskTitle: pick(detail, 'title') || String(task.id),
        courseTitle: node.courseTitle,
        lessonTitle: node.lessonTitle,
        courseId: node.courseId,
        lessonId: node.lessonId,
        taskUrl: pick(detail, 'url', 'link'),
        verdictInfo
      };
      // Логи проверки и раскрытая причина относятся к прошлой задаче — сбрасываем.
      this.contestLogs = null;
      this.contestLogsSubmissionId = null;
      this.verdictReasonOpen = null;
      this.pep8Report = null;
      // Примеры «ввод → вывод» из условия — для локальной проверки до отправки.
      try { this.examples = parseExamples(this.currentStatementHtml || ''); } catch (e) { this.examples = null; }
      await this.showTaskPanel(detail);
    });
  }

  verdictText(info) {
    if (!info) {
      // Решение могло быть отправлено, но LMS ещё не вернул сам submission:
      // в этом случае статус решения уже записан в общую карту.
      const t = this.currentTask;
      const st = t ? this.statusMap.get(String(t.taskId)) : null;
      if (st && st.badge && st.badge.desc) return st.badge.desc;
      return 'Решение ещё не отправлено';
    }
    const v = pick(info, 'verdict');
    if (!v) return 'На проверке';
    return verdictLabel(v);
  }

  // ── локальная проверка на примерах из условия (без отправки на сервер) ──
  async runLocalExamples() {
    const t = this.currentTask;
    const list = Array.isArray(this.examples) ? this.examples : [];
    if (!t || !t.filePath || !list.length) return { ran: 0, ok: 0 };
    const doc = await this.activeDocForTask(t);
    if (!doc) return { ran: 0, ok: 0 };
    if (doc.isDirty) await doc.save();
    if (!stripTemplate(doc.getText()).trim()) return { ran: 0, ok: 0 };
    const python = cfg().get('pythonPath') || 'python';
    let ok = 0;
    for (const ex of list) {
      const r = await runProcessInput(python, [t.filePath], ex.input, 10000);
      ex.actual = String(r.out || '');
      ex.err = String(r.err || '');
      ex.ok = r.code === 0 && normalizeOutput(ex.actual) === normalizeOutput(ex.output);
      if (ex.ok) ok++;
    }
    await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
    return { ran: list.length, ok };
  }

  examplesHtml() {
    const list = Array.isArray(this.examples) ? this.examples : [];
    if (!list.length) return '';
    const shown = s => '<pre><code>' + escapeHtml(String(s == null ? '' : s).slice(0, 800)) + '</code></pre>';
    const rows = list.map(ex => {
      const pill = ex.ok === true
        ? '<span class="pill ok"><i class="dot"></i>OK</span>'
        : (ex.ok === false ? '<span class="pill fail"><i class="dot"></i>FAIL</span>' : '<span class="pill wait"><i class="dot"></i>не запускался</span>');
      let body = '<div class="d-row"><span class="d-label">Ввод</span><span class="d-value">' + shown(ex.input) + '</span></div>' +
        '<div class="d-row"><span class="d-label">Ожидалось</span><span class="d-value">' + shown(ex.output) + '</span></div>';
      if (ex.ok === false) {
        body += '<div class="d-row"><span class="d-label">Получено</span><span class="d-value">' + shown(ex.actual) + '</span></div>';
        if (ex.err) body += '<div class="d-row"><span class="d-label">stderr</span><span class="d-value">' + shown(ex.err) + '</span></div>';
      }
      return '<div class="ex-item">' + pill + body + '</div>';
    }).join('');
    const passed = list.filter(e => e.ok === true).length;
    return '<details class="panel examples"><summary>Примеры из условия' + (passed ? ' — пройдено ' + passed + '/' + list.length : '') + '</summary><div class="panel-body">' + rows + '</div></details>';
  }

  // ── PEP 8 ──
  pep8Html() {
    const r = this.pep8Report;
    if (!r) return '';
    const rows = (r.errors || []).map(e =>
      '<div class="d-row"><span class="d-label">строка ' + e.line + (e.col ? ':' + e.col : '') + '</span><span class="d-value">' + escapeHtml(e.code + ' ' + e.text) + '</span></div>'
    ).join('');
    return '<details class="panel pep8"' + (rows ? '' : ' open') + '><summary>Проверка PEP 8' + (r.tool ? ' (' + escapeHtml(r.tool) + ')' : '') + '</summary><div class="panel-body">' +
      (rows || '<div class="d-row"><span class="d-value">Замечаний нет — код соответствует PEP 8.</span></div>') + '</div></details>';
  }

  async pep8Check() {
    const t = this.currentTask;
    const doc = t && t.filePath ? await this.activeDocForTask(t) : null;
    if (!doc) {
      vscode.window.showWarningMessage('LMS: откройте файл с решением.');
      return;
    }
    const code = doc.getText();
    if (!code.trim()) {
      vscode.window.showInformationMessage('LMS: файл пуст.');
      return;
    }
    // pycodestyle/flake8 читают файл с диска — иначе отчёт про старую версию.
    if (doc.isDirty) await doc.save();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: проверяю PEP 8…' }, async () => {
      const report = await this.runPep8(doc);
      this.pep8Report = report;
      this.output().appendLine('=== PEP 8 ===\n' + report.text);
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
      if (report.errors.length) {
        vscode.window.showWarningMessage('LMS: PEP 8 — найдено проблем: ' + report.errors.length + '.');
      } else {
        vscode.window.showInformationMessage('LMS: PEP 8 — замечаний нет.');
      }
    });
  }

  async runPep8(doc) {
    const errors = [];
    const filePath = doc.uri.fsPath;
    const code = doc.getText();
    const python = cfg().get('pythonPath') || 'python';
    // 1) внешние инструменты, если установлены
    for (const mod of ['pycodestyle', 'flake8']) {
      try {
        const res = await runProcess(python, ['-m', mod, '--max-line-length=100', filePath], 20000);
        if (res.code === 0 || (res.out && /:/.test(res.out))) {
          const lines = (res.out || '').split(/\r?\n/).filter(x => /:\d+:\d+:/.test(x));
          for (const l of lines) {
            const m = /^(.+?):(\d+):(\d+):\s+(\S+)\s+(.*)$/.exec(l);
            if (m) errors.push({ line: Number(m[2]), col: Number(m[3]), code: m[4], text: m[5] });
          }
          if (res.code === 0 || errors.length) {
            return { errors, text: errors.length ? errors.map(e => 'строка ' + e.line + ':' + e.col + ' ' + e.code + ' ' + e.text).join('\n') : 'Замечаний нет.', tool: mod };
          }
        }
      } catch (e) { }
    }
    // 2) синтаксис через компиляцию
    try {
      const comp = await runProcess(python, ['-m', 'py_compile', filePath], 20000);
      if (comp.code !== 0) {
        const out = (comp.out || '').trim();
        return { errors: [{ line: 0, col: 0, code: 'SyntaxError', text: out.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') }], text: 'Синтаксическая ошибка:\n' + out, tool: 'python' };
      }
    } catch (e) { }
    // 3) встроенные базовые проверки
    const lines = code.split(/\r?\n/);
    const push = (line, col, c, text) => errors.push({ line, col, code: c, text });
    lines.forEach((ln, i) => {
      const n = i + 1;
      if (ln.length > 100) push(n, 101, 'E501', 'строка длиннее 100 символов (' + ln.length + ')');
      if (/[ \t]+$/.test(ln)) push(n, ln.replace(/[ \t]+$/, '').length + 1, 'W291', 'лишние пробелы в конце строки');
      if (/^\t/.test(ln)) push(n, 1, 'W191', 'используются табы вместо пробелов');
      const ind = (ln.match(/^ */) || [''])[0].length;
      if (ln.trim() && ind % 4 !== 0) push(n, ind + 1, 'E111', 'отступ не кратен 4');
    });
    let blank = 0;
    lines.forEach((ln, i) => {
      if (!ln.trim()) { blank++; return; }
      if (/^(def |class |@)/.test(ln) && i > 0 && blank !== 2 && !/^@/.test(ln)) {
        push(i + 1, 1, 'E302', 'ожидаются 2 пустые строки перед определением');
      }
      blank = 0;
    });
    if (blank > 2) push(lines.length, 1, 'E303', 'слишком много пустых строк (' + blank + ')');
    if (code && !code.endsWith('\n')) push(lines.length, 1, 'W292', 'нет перевода строки в конце файла');
    return {
      errors,
      text: errors.length ? errors.map(e => 'строка ' + e.line + (e.col ? ':' + e.col : '') + ' ' + e.code + ' ' + e.text).join('\n') : 'Замечаний нет.',
      tool: 'встроенная проверка'
    };
  }

  // ── вкладки: рабочая область держится чистой (по запросу пользователя) ──
  async closeTabByPath(fsPath) {
    try {
      if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) return;
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs.slice()) {
          const inp = tab.input;
          const uri = inp && inp.uri;
          if (uri && uri.scheme === 'file' && uri.fsPath === fsPath) {
            await vscode.window.tabGroups.close(tab, true);
          }
        }
      }
    } catch (e) { }
  }

  // Временные md-вкладки условий (yandex-lms-view). keepFsPath — что оставить
  // (текущее условие в текстовом режиме); без аргумента закрываются все.
  async closeLmsViewTabs(keepFsPath) {
    try {
      if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) return;
      const base = path.join(os.tmpdir(), 'yandex-lms-view');
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs.slice()) {
          const inp = tab.input;
          const uri = inp && inp.uri;
          if (uri && uri.scheme === 'file' && uri.fsPath.indexOf(base) === 0 && uri.fsPath !== keepFsPath) {
            await vscode.window.tabGroups.close(tab, true);
          }
        }
      }
    } catch (e) { }
  }

  // Мусорные per-task папки от старых версий — на диске они не нужны.
  pruneViewDirs() {
    try {
      const base = path.join(os.tmpdir(), 'yandex-lms-view');
      const week = 7 * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(base)) {
        const full = path.join(base, name);
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
          else if (Date.now() - st.mtimeMs > week) fs.rmSync(full, { force: true });
        } catch (e) { }
      }
    } catch (e) { }
  }

  // Открытие учебника оставляет в рабочей области только его вкладку.
  // Перед закрытием сохраняем правки, а панель материала определяем по
  // viewType — её не закрываем даже при ошибке закрытия остальных вкладок.
  async closeTabsForMaterial(panel) {
    const viewType = normalizeTabViewType(panel && panel.viewType ? panel.viewType : '');
    if (!viewType) return 0;
    try { await vscode.workspace.saveAll(false); } catch (e) { }
    if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) return 0;
    const tabs = [];
    const seen = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const inp = tab.input;
        const tabViewType = normalizeTabViewType(inp && inp.viewType);
        seen.push(tabViewType || 'other');
        // Вкладка без input — обычно только что созданная панель, тип ещё не
        // проставлен; такую не закрываем, иначе можно закрыть сам материал.
        if (!inp) continue;
        if (tabViewType === viewType) continue;
        tabs.push(tab);
      }
    }
    this.output().appendLine('LMS material: keep=' + viewType + ' tabs=[' + seen.join(', ') + ']');
    if (!tabs.length) return 0;
    let closed = false;
    try { closed = await vscode.window.tabGroups.close(tabs, true); } catch (e) { closed = false; }
    this.output().appendLine('LMS material: closed=' + closed + ' count=' + (closed ? tabs.length : 0));
    if (!closed) {
      this.output().appendLine('LMS: не все вкладки закрылись при открытии материала (возможно, отменено сохранение).');
    } else {
      // Пустая группа после закрытия вкладок кода не должна занимать половину
      // экрана — материал раскрывается на всю ширину.
      try { await vscode.commands.executeCommand('workbench.action.closeEmptyEditors'); } catch (e) { }
    }
    return closed ? tabs.length : 0;
  }

  // Текстовый материал: оставляем только его вкладку. В отличие от
  // closeTabsForMaterial здесь нет webview-viewType, поэтому сверяем путь.
  async closeTabsForUri(keepUri) {
    const keep = keepUri && (keepUri.fsPath || keepUri.path);
    if (!keep) return 0;
    try { await vscode.workspace.saveAll(false); } catch (e) { }
    if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) return 0;
    const tabs = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const inp = tab.input;
        if (!inp) continue;
        const fsPath = inp.uri && (inp.uri.fsPath || inp.uri.path);
        if (fsPath && String(fsPath) === String(keep)) continue;
        tabs.push(tab);
      }
    }
    if (!tabs.length) return 0;
    let closed = false;
    try { closed = await vscode.window.tabGroups.close(tabs, true); } catch (e) { closed = false; }
    if (closed) {
      try { await vscode.commands.executeCommand('workbench.action.closeEmptyEditors'); } catch (e) { }
    }
    return closed ? tabs.length : 0;
  }

  // Клик по иконке LMS: все вкладки редактора закрываются (изменения сохраняются),
  // остаётся только панель условия. Поведение из 1.3.x, возвращено по запросу.
  async closeAllTabs() {
    try { await vscode.workspace.saveAll(false); } catch (e) { }
    const tabs = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const inp = tab.input;
        if (!inp) continue;
        const tabViewType = normalizeTabViewType(inp && inp.viewType);
        if (tabViewType.indexOf('yandexLmsTask') === 0 ||
            tabViewType.indexOf('yandexLmsMaterial') === 0) continue;
        const fsPath = inp.uri && (inp.uri.fsPath || inp.uri.path);
        const materialDoc = !!(this.materialDocUri && fsPath &&
            String(fsPath) === String(this.materialDocUri.fsPath || this.materialDocUri.path));
        // Предпросмотр Markdown — отдельная вкладка и может не отдавать uri,
        // поэтому держим его только когда материал реально открыт документом.
        if (materialDoc || (tabViewType.indexOf('markdown.preview') === 0 && this.materialDocUri)) continue;
        tabs.push(tab);
      }
    }
    if (!tabs.length) return;
    let closed = false;
    try { closed = await vscode.window.tabGroups.close(tabs, true); } catch (e) { closed = false; }
    if (closed) return;
    try { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); } catch (e) { }
    try { await vscode.commands.executeCommand('workbench.action.closeEmptyEditors'); } catch (e) { }
  }

  // ── текстовый вид условия (настройка taskView=text и запасной вариант) ──
  viewDir() {
    // Один стабильный каталог на все задачи: вкладка-превью «условие.md»
    // переиспользуется и обновляется на месте, а не множится на каждую задачу.
    const d = path.join(os.tmpdir(), 'yandex-lms-view');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
    return d;
  }

  saveImages(text) {
    // data-URI картинки сохраняем файлами и оставляем АБСОЛЮТНЫЙ путь —
    // текстовый режим не рендерит картинки, но файл можно открыть в один клик.
    if (!text || !/data:image\/[a-z+]+;base64,/i.test(text)) return text;
    const dir = this.viewDir();
    let n = 0;
    return String(text).replace(/data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)/gi, (m, ext, b64) => {
      n++;
      const name = 'img' + n + '.' + (ext === 'jpeg' ? 'jpg' : ext);
      try {
        fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
      } catch (e) { }
      return path.join(dir, name);
    });
  }

  buildTaskDocText(uri) {
    const t = this.currentTask;
    if (!t) return '# Задание не выбрано\n\nОткройте задачу в дереве слева.';
    const detail = this.detailCache.get(String(t.taskId)) || {};
    const L = [];
    L.push('# ' + (t.taskTitle || 'Задание'));
    L.push('');
    const meta = [];
    if (t.courseTitle) meta.push('**Курс:** ' + t.courseTitle);
    if (t.lessonTitle) meta.push('**Урок:** ' + t.lessonTitle);
    const scoreMax = pick(detail, 'scoreMax', 'score_max');
    if (scoreMax !== undefined) meta.push('**Баллов:** ' + scoreMax);
    const dl = pick(detail, 'deadline');
    if (dl) {
      const d = new Date(dl);
      if (!Number.isNaN(d.getTime())) meta.push('**Дедлайн:** ' + d.toLocaleDateString('ru-RU'));
    }
    if (meta.length) L.push(meta.join('  ·  '));
    const st = this.statusMap.get(String(t.taskId));
    const statusTxt = st && st.badge && st.badge.desc
      ? st.badge.desc + (st.score !== undefined && st.score !== null && scoreMax !== undefined ? ` (${st.score}/${scoreMax})` : '')
      : 'решение ещё не отправлено';
    L.push('**Статус:** ' + statusTxt);
    const chat = (t && this.aiChatLog) ? (this.aiChatLog.get(String(t.taskId)) || []) : [];
    if (chat.length) {
      L.push('');
      L.push('## Чат с ИИ');
      for (const m of chat) {
        L.push('');
        L.push((m.role === 'user' ? '**Ученик:** ' : '**Наставник:** ') + String(m.text));
      }
    }
    const logs = this.contestLogsText();
    if (logs) {
      L.push('');
      L.push('## Подробности проверки');
      L.push('');
      L.push('```');
      L.push(logs);
      L.push('```');
    }
    if (this.pep8Report) {
      L.push('');
      L.push('## Проверка PEP 8');
      L.push('');
      if (this.pep8Report.errors && this.pep8Report.errors.length) {
        L.push('```');
        L.push(this.pep8Report.errors.map(e => 'строка ' + e.line + (e.col ? ':' + e.col : '') + ' ' + e.code + ' ' + e.text).join('\n'));
        L.push('```');
      } else {
        L.push('Замечаний нет — код соответствует PEP 8.');
      }
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('## Условие');
    L.push('');
    if (t.isMarkers) {
      const problem = t.problemDefinition || null;
      const blocks = this.markersBlocks(problem);
      const map = this.markersMap(problem);
      let any = false;
      const desc = this.currentStatementHtml || '';
      if (desc && desc.trim()) {
        L.push(htmlToMarkdown(desc));
        any = true;
      }
      for (const b of blocks) {
        const content = pick(b, 'content') || {};
        if (pick(content, 'text')) {
          const raw = String(pick(content, 'text'));
          const inlined = this.inlinedText && this.inlinedText.get(raw);
          if (inlined) L.push(htmlToMarkdown(inlined));
          else if (/\{resource:\d+\}/.test(raw) || /<img/i.test(raw)) {
            L.push(htmlToMarkdown(raw));
          } else {
            L.push('```');
            L.push(raw.replace(/\r/g, ''));
            L.push('```');
          }
          any = true;
          continue;
        }
        const id = pick(content, 'id');
        const marker = (id !== undefined && map[id]) ? map[id] : content;
        const opts = this.markerOptions(marker);
        if (!opts.length) continue;
        any = true;
        opts.forEach((o, i) => L.push('- ' + (i + 1) + ') ' + o.label));
      }
      if (!any) L.push('Варианты ответа не пришли от API — откройте задание в браузере.');
    } else {
      const raw = this.currentStatementHtml || String(pick(detail, 'description', 'statement', 'content') || '');
      const statement = htmlToMarkdown(raw);
      L.push(statement || 'Условие не пришло от API — откройте задание в браузере (команда «LMS: Открыть в браузере»).');
    }
    L.push('');
    L.push('---');
    L.push('');
    L.push('**Действия:** `Ctrl+Alt+S` — отправить решение · `Ctrl+Alt+T` — открыть задачу · в палитре: `LMS: AI — подсказки / проверить / решение / исправить`, `LMS: Проверить код на PEP 8`, `LMS: Подробности проверки`.');
    return L.join('\n');
  }

  async showTaskDoc() {
    const t = this.currentTask;
    if (!t) return;
    const dir = this.viewDir();
    let text = this.buildTaskDocText(null);
    text = this.saveImages(text);
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[картинка: $2]');
    text = mdToPlainText(text);
    const txtPath = path.join(dir, 'условие.txt');
    try { fs.writeFileSync(txtPath, text, 'utf8'); } catch (e) { }
    const uri = vscode.Uri.file(txtPath);
    this.taskDocUri = uri;
    // ТОЛЬКО текстовый редактор — без markdown-превью и вообще без webview:
    // на машинах с багом #342842 любой webview (и встроенное превью тоже)
    // периодически падает с InvalidStateError. Текстовая вкладка ломаться не умеет.
    try { await this.closeLmsViewTabs(uri.fsPath); } catch (e) { }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true });
    } catch (e) {
      this.output().appendLine('Не удалось открыть условие: ' + (e.message || e));
    }
    this.updateTaskStatusBar();
  }

  // ── статус-бары и меню ──
  updateTaskStatusBar() {
    if (!this.taskStatusBar) return;
    const t = this.currentTask;
    if (!t) {
      this.taskStatusBar.hide();
      return;
    }
    const st = this.statusMap.get(String(t.taskId));
    const statusTxt = st && st.badge && st.badge.desc ? st.badge.desc : 'не отправлено';
    this.taskStatusBar.text = '$(code) LMS: ' + (t.taskTitle || 'задание') + ' — ' + statusTxt;
    this.taskStatusBar.tooltip = 'LMS: действия над задачей (клик)';
    this.taskStatusBar.show();
  }

  async taskMenu() {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      return;
    }
    const items = [
      { label: '$(book) Материалы урока', cmd: 'yandexLms.openLessonMaterials' },
      { label: '$(play) Отправить решение', cmd: 'yandexLms.submit' },
      { label: '$(sync) Обновить статус', cmd: 'yandexLms.refreshStatus' },
      { label: '$(sparkle) AI: подсказки', cmd: 'yandexLms.aiHints' },
      { label: '$(check) AI: проверить решение', cmd: 'yandexLms.aiCheck' },
      { label: '$(wand) AI: решение задачи', cmd: 'yandexLms.aiSolve' },
      { label: '$(clear-all) Очистить подсказки ИИ', cmd: 'yandexLms.aiClear' },
      { label: '$(gear) AI: настройки', cmd: 'yandexLms.aiSettings' },
      { label: '$(key) AI: ключи и провайдеры', cmd: 'yandexLms.aiKeys' },
      { label: '$(cloud-download) Забрать решение из LMS', cmd: 'yandexLms.pullSolution' },
      { label: '$(link-external) Открыть в браузере', cmd: 'yandexLms.openInBrowser' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Задание: ' + (t.taskTitle || '') });
    if (!picked) return;
    await vscode.commands.executeCommand(picked.cmd);
  }

  // ── подробности проверки ──
  contestLogsData() {
    const t = this.currentTask;
    const sid = t && t.verdictInfo ? pick(t.verdictInfo, 'id') : null;
    // Логи принадлежат конкретной посылке: сменился вердикт — старые не отдаём,
    // иначе причина от прошлой отправки выглядела бы как причина текущей.
    const cachedFor = this.contestLogsSubmissionId;
    if (cachedFor !== undefined && cachedFor !== null && sid !== null && sid !== undefined && String(cachedFor) !== String(sid)) {
      return null;
    }
    return this.contestLogs || null;
  }

  async refreshContestLogs() {
    const t = this.currentTask;
    if (!t || !t.solutionId) return null;
    let sub = t.verdictInfo;
    if (!sub || !pick(sub, 'id')) {
      try {
        const sol = await this.solutionState(t.solutionId);
        if (sol && sol.status === 200 && sol.json) {
          sub = latestSubmissionOf(sol.json);
          if (sub) t.verdictInfo = sub;
        }
      } catch (e) { }
    }
    const sid = sub ? pick(sub, 'id') : null;
    if (!sid) return null;
    try {
      const raw = await this.client.contestLogs(sid);
      if (!raw) return null;
      const data = pick(raw, 'contestLogs') || raw;
      this.contestLogs = data;
      this.contestLogsSubmissionId = sid;
      await this.aiLearnFromLogs(data);
      return data;
    } catch (e) { return null; }
  }

  contestLogsHtml() {
    const d = this.contestLogsData();
    if (!d) return '';
    const rows = [];
    const add = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      rows.push('<div class="d-row"><span class="d-label">' + escapeHtml(label) + '</span><span class="d-value">' + escapeHtml(String(value)) + '</span></div>');
    };
    add('Вердикт', pick(d, 'verdict'));
    add('Лог компиляции', pick(d, 'compileLog'));
    const t = pick(d, 'usedTime');
    const m = pick(d, 'usedMemory');
    if (t !== undefined || m !== undefined) add('Время / Память', (t !== undefined ? t + 'ms' : '-') + ' / ' + (m !== undefined ? m : '-'));
    add('Номер теста', pick(d, 'testNumber'));
    const info = pick(d, 'testInfo');
    if (info && typeof info === 'object') {
      for (const k of Object.keys(info)) add(k, info[k]);
    }
    if (!rows.length) return '';
    return '<details class="panel details"><summary>Подробности проверки</summary><div class="panel-body">' + rows.join('') + '</div></details>';
  }

  contestLogsText() {
    const d = this.contestLogsData();
    if (!d) return '';
    const L = [];
    const add = (label, value) => {
      if (value === undefined || value === null || value === '') return;
      L.push(label + ': ' + String(value));
    };
    add('Вердикт', pick(d, 'verdict'));
    add('Лог компиляции', pick(d, 'compileLog'));
    add('Время', pick(d, 'usedTime') !== undefined ? pick(d, 'usedTime') + 'ms' : '');
    add('Память', pick(d, 'usedMemory'));
    add('Номер теста', pick(d, 'testNumber'));
    const info = pick(d, 'testInfo');
    if (info && typeof info === 'object') {
      for (const k of Object.keys(info)) add(k, info[k]);
    }
    return L.join('\n');
  }

  // ── картинки условия ──
  absUrl(src) {
    if (!src) return null;
    if (/^data:/i.test(src)) return null;
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/')) return this.client.base + src;
    // относительный путь — тоже резолвим от базы (часть ресурсов лежит так)
    return this.client.base + '/' + String(src).replace(/^\.\//, '');
  }

  // data-URI картинки (ресурсы, уже встроенные в HTML) — для промптов ИИ.
  collectStatementImages(html) {
    const found = String(html || '').match(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi) || [];
    for (const u of found) {
      if (!this.statementImages.includes(u)) this.statementImages.push(u);
    }
  }

  async inlineImages(html) {
    const assets = { html: String(html || ''), images: [] };
    if (!assets.html) return assets;
    const imgs = [...assets.html.matchAll(/<img[^>]*?src\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
    if (!imgs.length) return assets;
    for (const src of imgs.slice(0, 6)) {
      const abs = this.absUrl(src);
      if (!abs) continue;
      try {
        const res = await this.client.raw('GET', abs, {});
        if (res.status !== 200) {
          this.output().appendLine('LMS: картинка не загрузилась (' + res.status + '): ' + abs);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > 4 * 1024 * 1024) continue;
        const ct = String(res.headers.get('content-type') || 'image/png').split(';')[0];
        const uri = 'data:' + ct + ';base64,' + buf.toString('base64');
        // Меняем только значение src — иначе короткий путь («1.png», «a»)
        // вырезался бы из всего HTML и ломал разметку условия.
        const esc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assets.html = assets.html.replace(new RegExp('(src\\s*=\\s*["\'])' + esc + '(["\'])', 'gi'), (m, p1, p2) => p1 + uri + p2);
        assets.images.push(uri);
      } catch (e) { }
    }
    return assets;
  }

  async prepareStatement(detail) {
    const html = String(pick(detail, 'description', 'statement', 'content') || '');
    if (!html) return { html: '', images: [] };
    const assets = await this.inlineImages(html);
    return assets;
  }

  async loadResources(resources) {
    const map = new Map();
    if (!resources || typeof resources !== 'object') return map;
    for (const id of Object.keys(resources)) {
      const r = resources[id] || {};
      const url = pick(r, 'url');
      if (!url) continue;
      const abs = this.absUrl(url);
      if (!abs) continue;
      try {
        const res = await this.client.raw('GET', abs, {});
        if (res.status !== 200) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > 6 * 1024 * 1024) continue;
        const ct = String(res.headers.get('content-type') || 'image/png').split(';')[0];
        map.set(String(id), { uri: 'data:' + ct + ';base64,' + buf.toString('base64'), width: pick(r, 'imageWidth'), height: pick(r, 'imageHeight') });
      } catch (e) { }
    }
    return map;
  }

  substituteResources(text, resources) {
    if (!text || !resources || !resources.size) return text;
    return String(text).replace(/\{resource:(\d+)\}/g, (m, id) => {
      const r = resources.get(String(id));
      if (!r) return m;
      const style = r.width ? ' style="max-width:100%; width:' + Math.min(Number(r.width), 700) + 'px;"' : ' style="max-width:100%;"';
      return '<img src="' + r.uri + '" alt="res' + id + '"' + style + '>';
    });
  }

  // ── статусы и решения ──
  async taskDetail(t) {
    const id = t && t.taskId;
    let detail = null;
    try {
      const r = await this.client.task(t.taskId, t.groupId);
      if (r.status === 200 && r.json) detail = r.json;
    } catch (e) { }
    if (detail && pick(detail, 'description', 'statement', 'content')) {
      this.detailCache.set(String(id), detail);
      return detail;
    }
    const cached = this.detailCache.get(String(id));
    if (cached) return cached;
    return detail || { title: (t && t.taskTitle) || 'Задание' };
  }

  async reloadCurrentTask() {
    const t = this.currentTask;
    if (!t) return;
    if (!t.solutionId) {
      this.currentTask.verdictInfo = null;
      await this.showTaskPanel(await this.taskDetail(t));
      vscode.window.showInformationMessage('LMS: у задания ещё нет решения на сервере.');
      return;
    }
    const sol = await this.solutionState(t.solutionId);
    if (sol && sol.status === 200 && sol.json) {
      this.currentTask.verdictInfo = latestSubmissionOf(sol.json) || null;
      const detail = await this.taskDetail(t);
      await this.showTaskPanel(detail);
      vscode.window.showInformationMessage('LMS: статус — ' + this.verdictText(this.currentTask.verdictInfo));
    } else {
      vscode.window.showErrorMessage('LMS: не удалось получить решение (HTTP ' + (sol ? sol.status : 'ERR') + ')');
    }
  }

  async reloadCurrentTaskSilently() {
    const t = this.currentTask;
    if (!t) return;
    if (t.solutionId) {
      const sol = await this.solutionState(t.solutionId);
      if (sol && sol.status === 200 && sol.json) {
        const info = latestSubmissionOf(sol.json);
        if (info) t.verdictInfo = info;
        const st = pick(sol.json, 'status');
        const type = typeof st === 'string' ? st : pick(st, 'type');
        // Известный вердикт не затираем пустым: в ответе решения его может не быть.
        const prev = this.statusMap.get(String(t.taskId));
        const verdict = (info ? pick(info, 'verdict') : undefined) || (prev && prev.verdict) || '';
        this.statusMap.set(String(t.taskId), { type, verdict, badge: statusBadge(type, verdict) });
        this.tree.refresh();
        this.updateTaskStatusBar();
      }
    }
    // Обновляем тот вид, который сейчас используется, без кражи фокуса.
    if (this.panel) {
      try { await this.showTaskPanel(await this.taskDetail(t)); } catch (e) { }
    } else {
      const mode = String(cfg().get('taskView') || 'panel');
      if (mode === 'text' || this.webviewBroken) await this.showTaskDoc(false);
    }
  }

  async openCurrentInBrowser() {
    const t = this.currentTask;
    if (!t) return;
    const url = t.taskUrl || `${this.client.base}/`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  // Следующая задача этого урока (кнопка в панели условия).
  async openNextTask() {
    const t = this.currentTask;
    if (!t) return;
    try {
      const r = await this.client.lessonTasks(t.courseId, t.lessonId, t.groupId);
      const flat = flattenLessonTasks(r.json).map(x => x.task);
      // Ответ бывает двух форм: группы по тегу с tasks и плоский список —
      // разбор общий с деревом и ведомостью (src/util.js).
      const idx = flat.findIndex(x => String(pick(x, 'id')) === String(t.taskId));
      const next = idx >= 0 ? flat[idx + 1] : null;
      if (!next) {
        vscode.window.showInformationMessage('LMS: это последняя задача урока.');
        return;
      }
      await this.openTask({
        task: next, groupId: t.groupId,
        courseTitle: t.courseTitle, lessonTitle: t.lessonTitle,
        courseId: t.courseId, lessonId: t.lessonId
      });
    } catch (e) {
      vscode.window.showErrorMessage('LMS: не удалось открыть следующую задачу: ' + (e.message || e));
    }
  }

  async saveActiveIfDirty() {
    try {
      const docs = [];
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.isDirty) docs.push(editor.document);
      // Клик по дереву забирает фокус у редактора: activeTextEditor пуст, и
      // несохранённый файл прошлой задачи иначе остался бы на диске старым.
      const t = this.currentTask;
      if (t && t.filePath) {
        const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === t.filePath);
        if (open && open.isDirty && docs.indexOf(open) < 0) docs.push(open);
      }
      for (const d of docs) await d.save();
    } catch (e) { }
  }

  async activeDocForTask(t) {
    const editor = vscode.window.activeTextEditor;
    if (editor && t && editor.document.uri.fsPath === t.filePath) return editor.document;
    if (t && t.filePath && fs.existsSync(t.filePath)) {
      return vscode.workspace.openTextDocument(t.filePath);
    }
    // Файл задачи известен, но пропал с диска — чужой открытый редактор не
    // подставляем, иначе можно отправить в LMS не тот код.
    if (t && t.filePath) return null;
    if (editor) return editor.document;
    return null;
  }

  async selectNode(node) {
    if (node && node.task) {
      await this.openTask(node);
      return true;
    }
    return false;
  }

  async submitCurrent() {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание (клик по задаче в списке слева).');
      return;
    }
    if (!(await this.ensureAuth())) return;
    const doc = await this.activeDocForTask(t);
    if (!doc) {
      vscode.window.showWarningMessage('LMS: нет файла с решением.');
      return;
    }
    if (doc.isDirty) await doc.save();
    const code = stripTemplate(doc.getText());
    t.lastCode = code;
    if (!code.trim()) {
      vscode.window.showWarningMessage('LMS: файл пустой, отправлять нечего.');
      return;
    }
    const pollSeconds = Number(cfg().get('pollSeconds')) || 60;
    const attemptsLog = [];
    let posted = false;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: отправляю решение…' }, async progress => {
      progress.report({ message: 'POST → checker' });
      const before = t.verdictInfo ? JSON.stringify(t.verdictInfo) : '';
      const out = await this.client.submitSolution({
        taskId: t.taskId,
        solutionId: t.solutionId,
        compilerId: t.compilerId,
        groupId: t.groupId
      }, code);
      this.lastAttempts = out.attempts;
      for (const a of out.attempts) {
        attemptsLog.push(`${a.status}  ${a.label}  ${a.detail}`);
      }
      this.output().appendLine('');
      this.output().appendLine('=== Отправка ' + new Date().toISOString() + ' ===');
      this.output().appendLine('taskId=' + t.taskId + ' solutionId=' + t.solutionId + ' compilerId=' + t.compilerId + ' groupId=' + t.groupId);
      this.output().appendLine('длина кода: ' + code.length);
      this.output().appendLine(attemptsLog.join('\n'));
      if (!out.result) {
        this.output().appendLine('Результат: ни одна ручка не ответила 2xx.');
      } else {
        posted = true;
        this.output().appendLine('Успешная ручка: ' + out.result.text.slice(0, 500));
      }
      if (out.solutionId && out.solutionId !== t.solutionId) {
        t.solutionId = out.solutionId;
      }
      if (!posted) {
        return;
      }
      progress.report({ message: 'жду вердикт проверки…' });
      const deadline = Date.now() + pollSeconds * 1000;
      while (Date.now() < deadline) {
        await sleep(3000);
        if (!t.solutionId) break;
        const sol = await this.solutionState(t.solutionId);
        if (sol && sol.status === 200 && sol.json) {
          const info = latestSubmissionOf(sol.json);
          const now = JSON.stringify(info || '');
          // Пишем в задачу, которую отправляли: currentTask мог смениться.
          t.verdictInfo = info;
          if (info && now !== before && pick(info, 'verdict')) {
            break;
          }
        }
      }
    });
    // Пока ждали вердикт, пользователь открыл другую задачу — её не трогаем.
    if (this.currentTask !== t) {
      this.tree.refresh();
      return;
    }
    if (!posted) {
      const list = this.lastAttempts || [];
      const failed = list.slice(0, 3).map(a => a.status + ' ' + a.label).join(' | ');
      // Все POST ответили 403 — сервер не принял сессию (CSRF/права). Токен
      // обновляется автоматически; если не помогло — нужен повторный вход.
      const all403 = list.length > 0 && list.every(a => Number(a.status) === 403);
      const hint = all403
        ? ' Сервер отклонил отправку (403): сессия не даёт прав. Войдите заново — QR или cookie.'
        : '';
      // Тело ответа сервера — чтобы при следующем сбое было видно причину,
      // а не только код. HTML-страницы не показываем, они бесполезны.
      const withBody = list.find(a => a.detail && !/^\s*</.test(String(a.detail)));
      const bodyHint = withBody
        ? ' Ответ сервера: ' + String(withBody.detail).replace(/\s+/g, ' ').trim().slice(0, 140)
        : '';
      const choice = await vscode.window.showWarningMessage(
        'LMS: решение не отправилось — ни одна ручка не ответила 2xx. Попытки: ' + (failed || 'нет') + '.' + hint + bodyHint,
        'Войти заново', 'Показать лог', 'Собрать отчёт'
      );
      if (choice === 'Войти заново') { await vscode.commands.executeCommand('yandexLms.loginMenu'); return; }
      if (choice === 'Показать лог') this.output().show(true);
      if (choice === 'Собрать отчёт') await this.collectReport('submit-failed');
      return;
    }
    const info = t.verdictInfo;
    const verdict = info ? pick(info, 'verdict') : null;
    // «ok» и «OK» — один и тот же вердикт: сравниваем без учёта регистра.
    const ok = isOkVerdict(verdict);
    if (verdict) {
      this.statusMap.set(String(t.taskId), { type: ok ? 'accepted' : 'uploaded', verdict, badge: statusBadge(ok ? 'accepted' : 'uploaded', verdict) });
      this.tree.refresh();
      this.updateTaskStatusBar();
      if (!ok) {
        // Подробности проверки — показать и дать ИИ починить код.
        await this.refreshContestLogs();
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
      }
    }
    if (ok) {
      vscode.window.showInformationMessage('LMS: решение зачтено!');
    } else if (verdict) {
      const msg = verdictLabel(verdict);
      const choice = await vscode.window.showWarningMessage('LMS: ' + msg, 'Открыть подробности в Output');
      if (choice) {
        this.output().show(true);
      }
    } else {
      const last = (this.lastAttempts || []).slice(0, 3).map(a => a.status + ' ' + a.label).join(' | ');
      const choice = await vscode.window.showWarningMessage(
        'LMS: вердикт не пришёл. Попытки: ' + (last || 'нет') + '.',
        'Показать лог', 'Собрать отчёт'
      );
      if (choice === 'Показать лог') this.output().show(true);
      if (choice === 'Собрать отчёт') await this.collectReport('submit-no-verdict');
    }
    await this.reloadCurrentTaskSilently();
    this.tree.refresh();
  }

  statusOf(task) {
    if (!task) return null;
    const id = String(pick(task, 'id'));
    let type = '';
    let verdict = '';
    let score;
    const sol = pick(task, 'solution');
    if (sol && typeof sol === 'object') {
      const st = pick(sol, 'status');
      type = typeof st === 'string' ? st : (pick(st, 'type') || '');
      const sub = pick(sol, 'latestSubmission', 'latest_submission');
      verdict = (sub && pick(sub, 'verdict')) || pick(sol, 'verdict') || '';
      score = pick(sol, 'score');
    }
    if (!type) {
      const st = pick(task, 'status');
      type = typeof st === 'string' ? st : (pick(st, 'type') || '');
    }
    if (!verdict) {
      const sub = pick(task, 'latestSubmission', 'latest_submission');
      verdict = (sub && pick(sub, 'verdict')) || pick(task, 'verdict') || '';
    }
    if (!type && !verdict) return this.statusMap.get(id) || null;
    return { type, verdict, score, badge: statusBadge(type, verdict) };
  }

  async refreshStatusFor(task) {
    if (!task) return;
    const id = String(pick(task, 'id'));
    const direct = this.statusOf(task);
    const sid = pick(task, 'solutionId', 'solution_id') || (pick(task, 'solution') && typeof pick(task, 'solution') === 'object' ? pick(pick(task, 'solution'), 'id') : undefined);
    // Тип статуса из списка задач и вердикт из решения — разные объекты: LMS
    // может отдать type «rework», а вердикт «ok» положить только в
    // latestSubmission. Без вердикта зачтённая задача показывалась красным
    // «на доработку», поэтому для проверенных статусов идём за вердиктом.
    const typeKey = String((direct && direct.type) || '').toLowerCase();
    const checkedType = CHECKED_STATUS_TYPES.indexOf(typeKey) >= 0;
    if (direct && (direct.verdict || !checkedType)) {
      this.statusMap.set(id, direct);
      return;
    }
    if (!sid) {
      // Решения нет — запоминаем «проверено, пусто». Иначе задача навсегда
      // остаётся в pending, ensureStatuses снова дёргает refresh, и дерево
      // уходит в бесконечный цикл запросов.
      if (direct && (direct.type || direct.verdict)) { this.statusMap.set(id, direct); return; }
      this.statusMap.set(id, { type: '', verdict: '', checked: true });
      return;
    }
    try {
      const sol = await this.solutionState(sid);
      if (!sol || sol.status !== 200 || !sol.json) {
        if (direct) this.statusMap.set(id, direct);
        return;
      }
      const st = pick(sol.json, 'status');
      const type = (typeof st === 'string' ? st : pick(st, 'type')) || (direct && direct.type) || '';
      const sub = pick(sol.json, 'latestSubmission', 'latest_submission');
      const verdict = (sub ? pick(sub, 'verdict') : undefined) || (direct && direct.verdict) || '';
      this.statusMap.set(id, { type, verdict, score: pick(sol.json, 'score'), badge: statusBadge(type, verdict) });
    } catch (e) {
      if (direct) this.statusMap.set(id, direct);
    }
  }

  ensureStatuses(nodes) {
    if (this.statusBusy) return;
    const pending = (nodes || []).filter(n => n && n.task && !this.statusMap.get(String(pick(n.task, 'id'))));
    if (!pending.length) return;
    this.statusBusy = true;
    (async () => {
      try {
        // По 4 задачи параллельно: проверенных заданий в уроке бывает много,
        // а последовательные запросы растягивали загрузку дерева на секунды.
        const queue = pending.slice();
        const worker = async () => {
          while (queue.length) {
            const n = queue.shift();
            await this.refreshStatusFor(n.task);
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
      } catch (e) {
      } finally {
        this.statusBusy = false;
      }
      this.tree.refresh();
    })();
  }

  refreshAllStatuses() {
    // «Обновить» должна перепроверять статусы: и «на проверке», и задачи,
    // которые в прошлый раз оказались без решения (sentinel checked).
    for (const [id, st] of this.statusMap) {
      if (st && (st.type === 'uploaded' || st.checked)) this.statusMap.delete(id);
    }
  }

  async solutionState(solutionId) {
    let r = null;
    try { r = await this.client.api('GET', `/api/proxy/student/solutions/${solutionId}`); } catch (e) { r = null; }
    if (!r || r.status !== 200 || !r.json) {
      try { r = await this.client.solution(solutionId); } catch (e) { r = null; }
    }
    return r;
  }

  async pullSolution(t) {
    if (!t || !t.solutionId) {
      vscode.window.showWarningMessage('LMS: на сервере нет сохранённого решения.');
      return;
    }
    const sol = await this.solutionState(t.solutionId);
    if (!sol || sol.status !== 200 || !sol.json) {
      vscode.window.showErrorMessage('LMS: не удалось получить решение (HTTP ' + (sol ? sol.status : 'ERR') + ')');
      return;
    }
    const latest = latestSubmissionOf(sol.json);
    const file = pick(sol.json, 'file') || pick(pick(sol.json, 'solution'), 'file') || pick(latest, 'file');
    let code = file ? pick(file, 'sourceCode', 'source_code') : null;
    if (!code && file) {
      const url = pick(file, 'url');
      if (url) {
        try {
          const fr = await this.client.raw('GET', url, {});
          // Без проверки кода ошибки/HTML страницы логина попадали в файл решения.
          if (fr.status !== 200) {
            vscode.window.showErrorMessage('LMS: не удалось скачать код решения (HTTP ' + fr.status + ').');
            return;
          }
          code = await fr.text();
        } catch (e) {
          vscode.window.showErrorMessage('LMS: не удалось скачать код решения: ' + (e.message || e));
          return;
        }
      }
    }
    if (!code) {
      vscode.window.showWarningMessage('LMS: код в решении не найден.');
      return;
    }
    const target = t.filePath;
    const exists = fs.existsSync(target);
    const openDoc = exists ? vscode.workspace.textDocuments.find(d => d.uri.fsPath === target) : null;
    if (openDoc && openDoc.isDirty) {
      const ans = await vscode.window.showWarningMessage(
        'LMS: в файле решения есть несохранённые правки — заменить их кодом из LMS?', 'Заменить', 'Отмена');
      if (ans !== 'Заменить') return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const clean = stripTemplate(code);
    let doc;
    if (exists) {
      // Пишем через WorkspaceEdit: открытый редактор не разъезжается с диском.
      doc = openDoc || await vscode.workspace.openTextDocument(target);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(vscode.Uri.file(target), new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), clean);
      if (await vscode.workspace.applyEdit(edit)) await doc.save();
      else fs.writeFileSync(target, clean, 'utf8');
    } else {
      fs.writeFileSync(target, clean, 'utf8');
      doc = await vscode.workspace.openTextDocument(target);
    }
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two, false);
    vscode.window.showInformationMessage('LMS: решение забрано из LMS.');
  }

  async runLocal() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('LMS: откройте файл с решением.');
      return;
    }
    if (editor.document.isDirty) await editor.document.save();
    const python = cfg().get('pythonPath') || 'python';
    const term = vscode.window.activeTerminal || vscode.window.createTerminal('LMS Python');
    term.show();
    term.sendText(`${python} "${editor.document.uri.fsPath}"`, true);
  }

  output() {
    if (!this._output) {
      this._output = vscode.window.createOutputChannel('Yandex LMS');
    }
    return this._output;
  }

  async dispose() {
    this.statusBar.dispose();
    this.taskStatusBar.dispose();
    if (this.materialPanel) {
      try { this.materialPanel.dispose(); } catch (e) { }
      this.materialPanel = null;
    }
    if (this.settingsPanel) {
      try { this.settingsPanel.dispose(); } catch (e) { }
      this.settingsPanel = null;
    }
    if (this.gradesPanel) {
      try { this.gradesPanel.dispose(); } catch (e) { }
      this.gradesPanel = null;
    }
    if (this._output) this._output.dispose();
  }
}

// Подключаем группы методов из модулей.
attachPanel(Lms);
attachMarkers(Lms);
attachAi(Lms);
attachDiag(Lms);
attachSettings(Lms);
attachLens(Lms);
attachMaterial(Lms);
attachGrades(Lms);

module.exports = { Lms, LmsContentProvider, SECRET_COOKIES, SECRET_LOGIN };
