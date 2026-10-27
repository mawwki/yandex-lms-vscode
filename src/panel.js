// Панель условия задачи: генерация HTML и управление webview-панелью.
// Панель одна на расширение, viewType статический, HTML ставится напрямую —
// без обходных трюков: обходы бага VS Code 1.142 (#342842) выпилены, при сбое
// есть ручные команды «показать текстом» и «перезагрузить webview».
const vscode = require('vscode');
const crypto = require('crypto');
const { pick, escapeHtml, mdToHtml, verdictReason, sanitizeStatementHtml, isOkVerdict } = require('./util');
const { webviewLog } = require('./diag');

const TASK_VIEW_TYPE = 'yandexLmsTask';

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Плашка статуса: цвет и текст по вердикту.
const SHORT_VERDICTS = {
  'wrong-answer': 'Неверный ответ',
  'time-limit-exceeded': 'Превышен лимит времени',
  'memory-limit-exceeded': 'Превышен лимит памяти',
  'runtime-error': 'Ошибка выполнения',
  'compilation-error': 'Ошибка компиляции',
  'presentation-error': 'Ошибка представления',
  'precompile-check-failed': 'Не прошёл PEP 8',
  'crash': 'Сбой проверки',
  'judge-error': 'Сбой системы проверки'
};

function shortVerdict(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  return SHORT_VERDICTS[k] || String(v);
}

function statusPill(t) {
  const v = t.verdictInfo ? pick(t.verdictInfo, 'verdict') : null;
  if (!t.verdictInfo || !v) {
    return '<span class="pill wait"><i class="dot"></i>не отправлено</span>';
  }
  // LMS отдаёт «ok» строчными — раньше это давало красную плашку «ok».
  if (isOkVerdict(v)) {
    return '<span class="pill ok" title="Решение верное"><i class="dot"></i>Зачтено</span>';
  }
  const label = shortVerdict(v);
  // Плашка кликабельна: причина (stderr, лог компиляции, ввод/вывод теста)
  // уже лежит в логах проверки — по клику раскрываем её прямо под шапкой.
  return '<button type="button" class="pill fail clickable" data-act="verdictReason" aria-expanded="false" title="Показать причину: ' + escapeHtml(String(v)) + '"><i class="dot"></i>' + escapeHtml(label) + '<span class="caret">▾</span></button>';
}

// Блок «почему не зачтено»: раскрывается кликом по плашке вердикта.
// Пусто, если логов проверки ещё нет (тогда клик сходит за ними в расширение).
function verdictReasonHtml(lms, t) {
  const v = t.verdictInfo ? pick(t.verdictInfo, 'verdict') : null;
  if (!v || isOkVerdict(v)) return '';
  const d = lms.contestLogsData ? lms.contestLogsData() : null;
  const parts = verdictReason(d);
  if (!parts) return '';
  const meta = [];
  const testNumber = pick(d, 'testNumber');
  if (testNumber !== undefined && testNumber !== null) meta.push('тест ' + testNumber);
  const usedTime = pick(d, 'usedTime');
  if (usedTime !== undefined && usedTime !== null) meta.push(usedTime + ' мс');
  const usedMemory = pick(d, 'usedMemory');
  if (usedMemory !== undefined && usedMemory !== null) meta.push(usedMemory + ' КБ');
  const body = parts.map(p =>
    '<div class="vr-part"><div class="vr-label">' + escapeHtml(p.label) + '</div><pre>' + escapeHtml(p.text) + '</pre></div>'
  ).join('');
  const open = lms.verdictReasonOpen !== undefined && lms.verdictReasonOpen !== null && String(lms.verdictReasonOpen) === String(t.taskId);
  return '<div class="verdict-reason" id="verdict-reason"' + (open ? '' : ' hidden') + '>' +
    '<div class="vr-head"><span class="vr-title">' + escapeHtml(shortVerdict(v)) + '</span>' +
    (meta.length ? '<span class="vr-meta">' + escapeHtml(meta.join(' · ')) + '</span>' : '') +
    '<button type="button" class="vr-close" data-act="verdictReason" title="Скрыть">✕</button></div>' +
    '<div class="vr-body">' + body + '</div>' +
    '<div class="vr-foot"><button type="button" class="vr-link" data-act="details">Все подробности проверки</button></div>' +
    '</div>';
}

// Иконки кнопок: inline SVG в духе codicon (не эмодзи, не внешние файлы —
// CSP не нужен, масштабируется с текстом).
const ICON_PATHS = {
  hints: '<path d="M8 1.8a4.3 4.3 0 0 1 2.5 7.8c-.4.3-.7.7-.7 1.2v.7H6.2v-.7c0-.5-.3-.9-.7-1.2A4.3 4.3 0 0 1 8 1.8z"/><path d="M6.4 13.2h3.2M7 14.8h2"/>',
  check: '<circle cx="8" cy="8" r="6.3"/><path d="M5.3 8.3l1.9 1.9 3.6-4.4"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  fix: '<path d="M11.3 2.2l2.5 2.5-7.6 7.6L2.5 13.5l1.2-3.7 7.6-7.6z"/><path d="M9.8 3.7l2.5 2.5"/>',
  answer: '<path d="M2.5 4.5h2M2.5 8h2M2.5 11.5h2M7 4.5h6.5M7 8h6.5M7 11.5h6.5"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.5h2"/>',
  key: '<circle cx="5" cy="10" r="2.7"/><path d="M7 8l6-6M10.5 4.5l1.8 1.8M8.8 6.2l1.5 1.5"/>',
  gear: '<path d="M2.2 4.6h11.6M2.2 8h11.6M2.2 11.4h11.6"/><circle cx="5.6" cy="4.6" r="1.7"/><circle cx="10.4" cy="8" r="1.7"/><circle cx="4.6" cy="11.4" r="1.7"/>',
  cookie: '<circle cx="8" cy="8" r="6.3"/><circle cx="6" cy="6.5" r=".4"/><circle cx="9.8" cy="7.5" r=".4"/><circle cx="7.5" cy="10.3" r=".4"/>'
};

function ic(name, size) {
  const s = Number(size) || 14;
  return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATHS[name] + '</svg>';
}

function taskHtml(lms, t, detail) {
  let aiState = '';
  let aiBlock = '';
  try {
    aiState = lms.aiStateHtml();
    aiBlock = lms.aiBlockHtml();
  } catch (e) {
    webviewLog('taskhtml-ai-error', { error: String(e.message || e) });
  }
  const webview = lms.panel ? lms.panel.webview : null;
  const csp = webview ? webview.cspSource : '';
  const n = nonce();
  let statement = pick(detail, 'description', 'statement', 'content');
  if (lms.currentStatementHtml) statement = lms.currentStatementHtml;
  if (!statement) {
    const cached = lms.detailCache.get(String(t && t.taskId));
    if (cached) statement = pick(cached, 'description', 'statement', 'content');
  }
  statement = statement || '<p>Условие не пришло от API. Откройте задание в браузере кнопкой ниже.</p>';
  const scoreMax = pick(detail, 'scoreMax', 'score_max');
  const deadline = pick(detail, 'deadline');
  const safeStatement = sanitizeStatementHtml(statement);

  const metaBits = [];
  if (t.courseTitle) metaBits.push(escapeHtml(t.courseTitle));
  if (t.lessonTitle) metaBits.push(escapeHtml(t.lessonTitle));
  if (scoreMax !== undefined) metaBits.push(escapeHtml(String(scoreMax)) + ' баллов');
  if (deadline) {
    const d = new Date(deadline);
    const pretty = Number.isNaN(d.getTime())
      ? escapeHtml(String(deadline))
      : escapeHtml(d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    metaBits.push('до ' + pretty);
  }
  const metaLine = metaBits.join('<span class="sep">·</span>');

  const actions = t.isMarkers
    ? '<button data-act="next" class="btn secondary">Следующая задача →</button><button data-act="browser" class="btn secondary">Открыть в браузере</button>'
    : '<button data-act="pull" class="btn secondary">Забрать из LMS</button><button data-act="refresh" class="btn secondary">Обновить статус</button><button data-act="next" class="btn secondary">Следующая задача →</button><button data-act="browser" class="btn secondary">Открыть в браузере</button>';

  // Чипы — тонкий ряд действий внутри чата (настройки ИИ — в статус-баре и палитре).
  const aiChips = t.isMarkers
    ? '<button data-act="aiAnswer" class="chip">' + ic('answer') + 'AI: выбрать ответ</button>'
    : '<button data-act="aiSolve" class="chip">' + ic('code') + 'Решить</button>' +
      '<button data-act="aiCheck" class="chip">' + ic('check') + 'Проверить</button>' +
      '<button data-act="aiHints" class="chip">' + ic('hints') + 'Подсказки</button>' +
      '<button data-act="aiFix" class="chip">' + ic('fix') + 'Исправить по проверке</button>' +
      '<button data-act="pep8" class="chip">PEP 8</button>' +
      '<button data-act="localExamples" class="chip">Примеры</button>';

  const aiRow = '<div class="ai-block"><div class="ai-state">' + aiState + '</div>' +
    '<div class="ai-chat">' + aiBlock + '</div>' +
    '<div class="ai-chips">' + aiChips + '</div></div>';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground, #cccccc); background: var(--vscode-editor-background, transparent); margin: 0; line-height: 1.55; }

  /* ── липкая шапка: статус и главная кнопка всегда на виду ── */
  .topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 9px 18px; background: var(--vscode-editor-background, #1f1f1f); border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .tb-title { font-size: 1.02em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .tb-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

  .pill { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82em; padding: 3px 10px; border-radius: 999px; white-space: nowrap; border: 1px solid transparent; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .pill.ok { color: var(--vscode-testing-iconPassed, #3fb950); background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 12%, transparent); border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 40%, transparent); }
  .pill.ok .dot { background: var(--vscode-testing-iconPassed, #3fb950); }
  .pill.fail { color: var(--vscode-errorForeground, #f85149); background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 12%, transparent); border-color: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 40%, transparent); }
  .pill.fail .dot { background: var(--vscode-errorForeground, #f85149); }
  .pill.wait { color: var(--vscode-charts-orange, #d18616); background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 12%, transparent); border-color: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 40%, transparent); }
  .pill.wait .dot { background: var(--vscode-charts-orange, #d18616); }
  .pill.clickable { font-family: inherit; cursor: pointer; transition: filter .12s ease; }
  .pill.clickable:hover { filter: brightness(1.2); }
  .pill.clickable:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .pill.clickable .caret { font-size: 0.9em; opacity: 0.7; transition: transform .12s ease; }
  .pill.clickable[aria-expanded="true"] .caret { transform: rotate(180deg); }

  /* ── причина сбоя: раскрывается кликом по плашке вердикта ── */
  .verdict-reason { margin: 0 0 14px; border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f85149) 45%, transparent);
    border-radius: 8px; background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 7%, transparent); }
  .verdict-reason[hidden] { display: none; }
  .vr-head { display: flex; align-items: center; gap: 12px; padding: 7px 12px; font-size: 0.9em; font-weight: 600;
    color: var(--vscode-errorForeground, #f85149); border-bottom: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f85149) 25%, transparent); }
  .vr-meta { font-weight: 400; font-size: 0.88em; opacity: 0.8; }
  .vr-close { margin-left: auto; background: none; border: 0; padding: 0 2px; color: inherit; opacity: 0.65; cursor: pointer; font-size: 0.95em; font-family: inherit; }
  .vr-close:hover { opacity: 1; }
  .vr-body { display: flex; flex-direction: column; gap: 9px; padding: 9px 12px; }
  .vr-label { font-size: 0.78em; opacity: 0.65; margin-bottom: 3px; }
  .vr-part pre { margin: 0; max-height: 240px; overflow: auto; padding: 8px 10px; border-radius: 5px;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .vr-foot { padding: 0 12px 9px; }
  .vr-link { background: none; border: 0; padding: 0; font-family: inherit; font-size: 0.85em; cursor: pointer;
    color: var(--vscode-textLink-foreground, #3794ff); }
  .vr-link:hover { text-decoration: underline; }

  .wrap { max-width: 860px; margin: 0 auto; padding: 14px 20px 48px; }
  .meta { opacity: 0.7; font-size: 0.86em; margin: 2px 0 14px; }
  .meta .sep { margin: 0 7px; opacity: 0.6; }
  h1 { font-size: 1.25em; margin: 6px 0 2px; letter-spacing: 0.01em; }

  .btn { font-family: inherit; font-size: 0.9em; padding: 6px 12px; border-radius: 5px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #313131); color: var(--vscode-button-secondaryForeground, #cccccc);
    cursor: pointer; transition: filter .12s ease, transform .05s ease; display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
  .btn svg { flex-shrink: 0; }
  .btn:hover { filter: brightness(1.15); }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); font-weight: 600; }
  .btn.ai { font-size: 0.85em; padding: 5px 10px; }
  .btn.sm { font-size: 0.85em; padding: 5px 14px; }
  .btn.icon { padding: 5px 7px; }
  .btn.icon svg { width: 13px; height: 13px; }

  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }

  /* ── блок ИИ: чат ── */
  .ai-block { margin: 0 0 16px; padding: 12px 14px; border-radius: 8px; background: var(--vscode-sideBar-background, rgba(127,127,127,0.06)); border: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .ai-state { font-size: 0.85em; opacity: 0.85; margin: 0 0 10px; }
  .ai-ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .ai-bad { color: var(--vscode-charts-red, #f14c4c); }
  .ai-warn { color: var(--vscode-charts-orange, #d18616); }
  .chat-log { max-height: 42vh; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 4px; }
  .chat-log:empty { display: none; }
  .chat-msg { max-width: 92%; padding: 7px 10px; border-radius: 9px; font-size: 0.92em; overflow-wrap: break-word; }
  .chat-user { align-self: flex-end; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); white-space: pre-wrap; }
  .chat-ai { align-self: flex-start; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.12)); border: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .chat-ai p { margin: 4px 0; }
  .chat-ai ul, .chat-ai ol { margin: 4px 0 4px 18px; padding: 0; }
  .chat-ai pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 8px; overflow: auto; border-radius: 4px; }
  .chat-ai code { font-family: var(--vscode-editor-font-family, monospace); }
  .chat-thinking { opacity: 0.6; font-style: italic; }
  .chat-sys { align-self: flex-start; font-size: 0.84em; opacity: 0.7; padding: 2px 4px; }
  /* ── строка ввода: textarea + переключатель «Текст / Код» + отправка ── */
  .chat-composer { margin: 6px 0 10px; border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 8px;
    background: var(--vscode-input-background, #313131); transition: border-color .12s ease; }
  .chat-composer:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
  .chat-composer textarea { display: block; width: 100%; resize: none; min-height: 38px; max-height: 140px; font-family: inherit; font-size: 0.92em; line-height: 1.4;
    padding: 8px 10px 2px; border: 0; background: transparent; color: var(--vscode-input-foreground, #cccccc); outline: none; }
  .chat-composer textarea:disabled { opacity: 0.55; }
  .composer-foot { display: flex; align-items: center; gap: 8px; padding: 2px 6px 6px; }
  .seg { display: inline-flex; flex-shrink: 0; padding: 2px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.16)); }
  .seg-btn { font-family: inherit; font-size: 0.76em; line-height: 1; padding: 4px 11px; border: 0; border-radius: 999px; background: transparent;
    color: var(--vscode-foreground, #ccc); opacity: 0.72; cursor: pointer; transition: background .12s ease, opacity .12s ease; }
  .seg-btn:hover { opacity: 1; }
  .seg-btn.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); opacity: 1; font-weight: 600; }
  .seg-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .seg-hint { font-size: 0.76em; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-send { margin-left: auto; white-space: nowrap;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground, #cccccc) 20%, transparent); }
  .ai-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-family: inherit; font-size: 0.78em; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: transparent; color: var(--vscode-foreground, #ccc); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: background .1s ease; }
  .chip:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .chip svg { width: 11px; height: 11px; }
  .ex-item { margin: 10px 0; }
  .ex-item .pill { margin-bottom: 6px; }
  .ai-note { margin: 0 0 12px; padding: 10px 12px; border-radius: 6px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.12)); border-left: 3px solid var(--vscode-charts-purple, #b180d7); }
  .ai-title { font-weight: 600; margin-bottom: 6px; font-size: 0.95em; }
  .ai-note h3, .ai-note h4, .ai-note h5, .ai-note h6 { font-size: 1em; margin: 8px 0 4px; }
  .ai-note p { margin: 4px 0; }
  .ai-note ul, .ai-note ol { margin: 4px 0 4px 18px; padding: 0; }
  .ai-note code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,0.2); padding: 1px 4px; border-radius: 3px; }
  .ai-note pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 10px; overflow: auto; border-radius: 4px; }
  .ai-note pre code { background: none; padding: 0; }

  /* ── сворачиваемые подробности ── */
  details.panel { margin: 0 0 12px; border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 8px; background: var(--vscode-sideBar-background, rgba(127,127,127,0.04)); overflow: hidden; }
  details.panel > summary { cursor: pointer; padding: 8px 14px; font-size: 0.9em; font-weight: 600; user-select: none; list-style: none; }
  details.panel > summary::before { content: '▸ '; opacity: 0.6; }
  details.panel[open] > summary::before { content: '▾ '; }
  details.panel > summary:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  details.panel > .panel-body { padding: 4px 14px 12px; border-top: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .d-row { display: flex; gap: 8px; margin: 4px 0; font-size: 0.9em; }
  .d-label { min-width: 150px; opacity: 0.75; flex-shrink: 0; }
  .d-value { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-word; }
  .lessons ul { margin: 6px 0 2px 18px; padding: 0; }
  .lessons li { margin: 3px 0; font-size: 0.9em; }

  /* ── условие ── */
  .statement { font-size: 0.98em; }
  .statement h1, .statement h2, .statement h3 { font-size: 1.05em; margin: 14px 0 6px; }
  .statement p { margin: 8px 0; }
  .statement img { display: block; max-width: 100%; height: auto; margin: 10px 0; border-radius: 6px; border: 1px solid var(--vscode-panel-border, #2b2b2b); background: #fff; }
  .marker-text img { display: block; max-width: 100%; height: auto; margin: 10px 0; border-radius: 6px; border: 1px solid var(--vscode-panel-border, #2b2b2b); background: #fff; }
  .statement pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); border: 1px solid var(--vscode-panel-border, #2b2b2b); padding: 11px 13px; overflow: auto; border-radius: 6px; }
  .statement code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,0.18); padding: 1px 5px; border-radius: 3px; }
  .statement pre code { background: none; padding: 0; }
  .statement blockquote { margin: 10px 0; padding: 4px 14px; border-left: 3px solid var(--vscode-charts-blue, #3794ff); opacity: 0.9; }
  .statement ul, .statement ol { margin: 8px 0 8px 22px; padding: 0; }
  .statement li { margin: 3px 0; }
  table { border-collapse: collapse; margin: 10px 0; }
  td, th { border: 1px solid var(--vscode-panel-border, #2b2b2b); padding: 5px 10px; }
  th { background: rgba(127,127,127,0.1); }

  /* ── варианты ответа ── */
  .markers-question { margin: 4px 0 12px; }
  .marker-text { margin-bottom: 10px; }
  .marker-text p { margin: 6px 0; }
  .marker-text pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 10px; overflow: auto; border-radius: 6px; }
  .res-missing { padding: 10px 14px; border-radius: 6px; border: 1px dashed var(--vscode-charts-orange, #d18616); color: var(--vscode-charts-orange, #d18616); font-size: 0.92em; }
  .marker-options { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 14px; }
  .opt { display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px; border-radius: 7px; border: 1px solid var(--vscode-panel-border, #2b2b2b); cursor: pointer; transition: background .1s ease, border-color .1s ease; }
  .opt:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .opt:has(input:checked) { border-color: var(--vscode-focusBorder, #007fd4); background: color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 12%, transparent); }
  .opt input { margin-top: 3px; accent-color: var(--vscode-focusBorder, #007fd4); }
  .marker-textinput { display: flex; gap: 8px; align-items: center; margin: 8px 0 14px; }
  .marker-textinput input { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 1em; padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, #2b2b2b); background: var(--vscode-input-background, #313131); color: var(--vscode-input-foreground, #cccccc); outline: none; }
  .marker-textinput input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .ti-hint { font-size: 0.8em; opacity: 0.6; white-space: nowrap; }
  .send-row { display: flex; gap: 8px; margin: 4px 0 16px; }
  .send-row .btn { flex: 1; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="tb-title" title="${escapeHtml(t.taskTitle)}">${escapeHtml(t.taskTitle)}</div>
    <div class="tb-right">
      ${statusPill(t)}
      ${t.isMarkers ? '' : '<button data-act="submit" class="btn primary sm" title="Ctrl+Alt+S">Отправить решение</button>'}
      <button data-act="settings" class="btn secondary sm icon" title="Настройки (ключи, ИИ, папки)" aria-label="Настройки">${ic('gear')}</button>
    </div>
  </div>
  <div class="wrap">
    ${verdictReasonHtml(lms, t)}
    <h1>${escapeHtml(t.taskTitle)}</h1>
    ${metaLine ? '<div class="meta">' + metaLine + '</div>' : ''}
    <div class="actions">${actions}</div>
    ${aiRow}
    ${lms.contestLogsHtml()}
    ${lms.examplesHtml ? lms.examplesHtml() : ''}
    ${lms.pep8Html ? lms.pep8Html() : ''}
    ${t.isMarkers ? lms.markersPanelHtml() : `<div class="statement">${safeStatement}</div>`}
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  function collectAnswer() {
    const answer = {};
    document.querySelectorAll('input[type="text"][data-marker]').forEach(inp => {
      const v = inp.value.trim();
      if (v) answer[inp.getAttribute('data-marker')] = v;
    });
    document.querySelectorAll('input[data-marker]:not([type="text"])').forEach(inp => {
      const key = inp.getAttribute('data-marker');
      if (inp.type === 'checkbox') {
        if (inp.checked) { answer[key] = answer[key] ? answer[key] + ',' + inp.value : inp.value; }
      } else if (inp.checked) {
        answer[key] = inp.value;
      }
    });
    return answer;
  }
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    if (act === 'markersSubmit') {
      vscode.postMessage({ type: 'markersSubmit', answer: collectAnswer() });
      return;
    }
    // Плашка вердикта: причина уже в DOM — раскрываем без похода в расширение.
    if (act === 'verdictReason') {
      const box = document.getElementById('verdict-reason');
      const pill = document.querySelector('.pill[data-act="verdictReason"]');
      if (box) {
        const open = box.hidden;
        box.hidden = !open;
        if (pill) pill.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Свернули — сообщаем расширению, иначе после перерисовки блок вернётся.
        else vscode.postMessage({ type: 'verdictReasonClose' });
      } else {
        vscode.postMessage({ type: 'verdictReason' });
      }
      return;
    }
    // Переключатель «Текст / Код» в строке ввода: сначала отправляем черновик,
    // иначе перерисовка панели потеряет уже набранный текст.
    if (act === 'aiMode') {
      const inp = document.getElementById('chat-input');
      if (inp) vscode.postMessage({ type: 'aiChatDraft', value: inp.value });
      // Панель перерисуется — просим вернуть фокус в строку ввода.
      try { vscode.setState({ focusChat: true }); } catch (e) { }
      vscode.postMessage({ type: 'aiMode', mode: el.getAttribute('data-mode') || 'text' });
      return;
    }
    // Кнопка «Отправить» в чате: текст берём из textarea (в сообщении его нет).
    if (act === 'aiChatSend') {
      const inp = document.getElementById('chat-input');
      const text = inp ? inp.value.trim() : '';
      if (!text || (inp && inp.disabled)) {
        if (inp && !inp.disabled) inp.focus();
        return;
      }
      vscode.postMessage({ type: 'aiChatSend', text: text });
      inp.value = '';
      inp.style.height = 'auto';
      vscode.postMessage({ type: 'aiChatDraft', value: '' });
      return;
    }
    vscode.postMessage({ type: act });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || !ev.target || !ev.target.matches) return;
    if (ev.target.matches('input[type="text"][data-marker]')) {
      ev.preventDefault();
      vscode.postMessage({ type: 'markersSubmit', answer: collectAnswer() });
    }
  });
  // Чат: Enter — отправить, Shift+Enter — перенос строки. Черновик уходит в
  // расширение, чтобы пережить перерисовку панели после ответа ИИ.
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    let draftTimer = null;
    const autosize = () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px'; };
    chatInput.addEventListener('input', () => {
      autosize();
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => vscode.postMessage({ type: 'aiChatDraft', value: chatInput.value }), 300);
    });
    chatInput.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        const text = chatInput.value.trim();
        if (!text || chatInput.disabled) return;
        vscode.postMessage({ type: 'aiChatSend', text: text });
        chatInput.value = '';
        autosize();
        vscode.postMessage({ type: 'aiChatDraft', value: '' });
      }
    });
    autosize();
    // После переключения «Текст/Код» панель перерисовывается целиком —
    // возвращаем фокус в строку ввода, чтобы можно было сразу печатать.
    let saved = null;
    try { saved = vscode.getState(); } catch (e) { }
    if (saved && saved.focusChat) {
      chatInput.focus();
      try { vscode.setState({ focusChat: false }); } catch (e) { }
    }
  }
  const chatLog = document.getElementById('chat-log');
  if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function attachPanel(panel, lms) {
  webviewLog('created', { viewType: panel.viewType });
  panel.onDidDispose(() => {
    webviewLog('disposed', { viewType: panel.viewType });
    if (lms.panel === panel) lms.panel = null;
  });
  panel.webview.onDidReceiveMessage(async msg => {
    const type = msg && msg.type;
    // ready: webview загрузился — сигнал сторожевому таймеру openPanel
    if (type === 'ready') {
      lms.panelReady = true;
      lms.panelAttempt = 0;
      lms.setWebviewBroken(false);
      return;
    }
    if (!lms.currentTask) return;
    const map = {
      submit: () => lms.submitCurrent(),
      refresh: () => lms.reloadCurrentTask(),
      browser: () => lms.openCurrentInBrowser(),
      next: () => lms.openNextTask(),
      pull: () => lms.pullSolution(lms.currentTask),
      aiHints: () => lms.aiRun('hints'),
      aiSolve: () => lms.aiRun('solve'),
      aiCheck: () => lms.aiRun('check'),
      aiFix: () => lms.aiFix(),
      aiClear: () => lms.aiClear(),
      aiMode: () => lms.aiSetChatMode(msg.mode),
      markersSubmit: () => lms.markersAnswer(msg.answer || {}),
      pep8: () => lms.pep8Check(),
      aiAnswer: () => lms.aiChooseAnswer(),
      aiChatSend: () => lms.aiChatSend(msg.text),
      settings: () => lms.openSettings(),
      verdictReason: () => lms.showVerdictReason(),
      verdictReasonClose: () => { lms.verdictReasonOpen = null; },
      localExamples: () => lms.runLocalExamples(),
      aiChatDraft: () => {
        if (!lms.aiChatDrafts) lms.aiChatDrafts = new Map();
        if (lms.currentTask) lms.aiChatDrafts.set(String(lms.currentTask.taskId), String(msg.value || ''));
      },
      details: async () => {
        const d = await lms.refreshContestLogs();
        await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask.taskId)) || { title: lms.currentTask.taskTitle });
        if (!d) vscode.window.showInformationMessage('LMS: деталей проверки нет (задача ещё не проверялась).');
      }
    };
    const fn = map[type];
    if (fn) {
      try { await fn(); } catch (e) { lms.output().appendLine('panel action ' + type + ': ' + (e.message || e)); }
    }
  });
}

// Подключается к прототипу Lms (src/lms.js).
function attach(Lms) {
  // Баг VS Code #342842: первый webview окна срывается на регистрации service
  // worker. Лечение — пересоздание webview со СВЕЖИМ viewType (новый scope):
  // попытка 2 обычно грузится. Панель пробуем ВСЕГДА при открытии задачи
  // (пользователь хочет кнопки), текстовый режим — только если все попытки мимо.
  const MAX_ATTEMPTS = 5;
  const WATCHDOG_MS = 2500;

  Lms.prototype.openPanel = function (t, detail) {
    if (this.panelViewCounter === undefined) this.panelViewCounter = 0;
    this.panelViewCounter++;
    const attempt = this.panelAttempt || 0;
    const viewType = this.panelViewCounter === 1 ? TASK_VIEW_TYPE : TASK_VIEW_TYPE + '-' + this.panelViewCounter;
    const panel = vscode.window.createWebviewPanel(viewType, t.taskTitle, { viewColumn: vscode.ViewColumn.One, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Недокументированная опция: webview без service worker. Если VS Code
      // её игнорирует — спасают пересоздания ниже.
      disableServiceWorker: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    attachPanel(panel, this);
    this.panel = panel;
    this.panelReady = false;
    const token = (this.panelWatchToken = {});
    panel.webview.html = taskHtml(this, t, detail);
    setTimeout(async () => {
      if (token !== this.panelWatchToken || this.panel !== panel || this.panelReady) return;
      this.output().appendLine('LMS: webview не загрузился (#342842) — пересоздаю, попытка ' + (attempt + 2) + '/' + MAX_ATTEMPTS);
      try { panel.dispose(); } catch (e) { }
      if (this.panel === panel) this.panel = null;
      if (attempt + 1 < MAX_ATTEMPTS) {
        this.panelAttempt = attempt + 1;
        this.openPanel(t, detail);
      } else {
        this.panelAttempt = 0;
        await this.showTaskDoc();
        if (!this.fallbackNotified) {
          this.fallbackNotified = true;
          vscode.window.showInformationMessage('LMS: webview так и не загрузился (баг VS Code #342842) — условие показано текстом. Кнопки вернутся при следующем открытии задачи.');
        }
      }
    }, WATCHDOG_MS);
  };

  // Клик по плашке вердикта, когда логов ещё нет в памяти: забираем их и
  // перерисовываем панель с раскрытым блоком причины.
  Lms.prototype.showVerdictReason = async function () {
    const t = this.currentTask;
    if (!t) return;
    const v = t.verdictInfo ? pick(t.verdictInfo, 'verdict') : null;
    if (!v) {
      vscode.window.showInformationMessage('LMS: решения ещё не было — причины нет.');
      return;
    }
    if (isOkVerdict(v)) {
      vscode.window.showInformationMessage('LMS: решение зачтено — ошибки нет.');
      return;
    }
    if (!verdictReason(this.contestLogsData())) {
      const d = await this.refreshContestLogs();
      if (!verdictReason(d)) {
        vscode.window.showWarningMessage('LMS: логи проверки пусты или не пришли — причину показать нечем. Попробуйте «Обновить статус» или откройте задание в браузере.');
        return;
      }
    }
    this.verdictReasonOpen = String(t.taskId);
    await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
  };

  Lms.prototype.showTaskPanel = async function (detail) {
    const t = this.currentTask;
    if (!t) return;
    // forcePanel: команда «Условие — панелью» пробует панель даже при taskView=text
    const mode = this.forcePanel ? 'panel' : String(require('./cfg').cfg().get('taskView') || 'panel');
    if (mode === 'text') {
      await this.showTaskDoc();
      return;
    }
    // Панель живёт — временные текстовые вкладки условий не нужны, убираем.
    try { await this.closeLmsViewTabs(); } catch (e) { }
    if (!this.panel) {
      this.openPanel(t, detail);
      return;
    }
    this.panel.title = t.taskTitle;
    try {
      this.panel.webview.html = taskHtml(this, t, detail);
    } catch (e) {
      this.output().appendLine('Панель не обновилась: ' + (e.message || e));
    }
  };
}

module.exports = { attach, taskHtml, TASK_VIEW_TYPE, ic };
