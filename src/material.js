// Панель учебного материала: чтение учебников LMS прямо в VS Code.
// Отдельная от условия задачи панель: материал можно держать открытым, пока
// решение пишется в соседнем окне.
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  pick, asArray, escapeHtml, sanitizeStatementHtml,
  materialTypeLabel, materialDisplayTitle, materialReadingMinutes, safeName
} = require('./util');
const { ic } = require('./panel');
const { highlightCodeBlocks } = require('./highlight');
const { materialMarkdown, materialPlainText } = require('./material-md');

const MATERIAL_VIEW_TYPE = 'yandexLmsMaterial';
// Встроенный предпросмотр Markdown — единственный webview, который VS Code
// создаёт с disableServiceWorker: true. Поэтому он переживает баг #342842,
// когда панели расширения не могут зарегистрировать service worker.
const MARKDOWN_PREVIEW_VIEW_TYPE = 'markdown.preview';

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Короткий след открытия материала в канале «Yandex LMS». Пишем только id,
// viewType и состояние вкладок — без содержимого учебника.
function mlog(lms, msg) {
  try { lms.output().appendLine('LMS material: ' + msg); } catch (e) { }
}

// Контент материала — обычный HTML с классами material__*. Оставляем разметку,
// вырезаем активные элементы и добавляем подпись к оглавлению.
function prepareMaterialContent(html) {
  let out = sanitizeStatementHtml(html || '');
  out = highlightCodeBlocks(out);
  out = out.replace(
    /<section([^>]*\bclass\s*=\s*["'][^"']*\bmaterial__plan\b[^"']*["'][^>]*)>/i,
    '<section$1><div class="plan-title">Содержание</div>'
  );
  return out;
}

function pagerButton(dir, material) {
  const label = dir === 'prev' ? 'Предыдущий материал' : 'Следующий материал';
  const arrow = dir === 'prev' ? ic('left', 12) : ic('right', 12);
  return '<button type="button" class="pg ' + dir + '" data-act="' + dir + '">' +
    '<span class="pg-dir">' + (dir === 'prev' ? arrow : '') + '<span>' + label + '</span>' + (dir === 'next' ? arrow : '') + '</span>' +
    '<span class="pg-title">' + escapeHtml(materialDisplayTitle(material)) + '</span>' +
    '</button>';
}

function materialHtml(lms, current) {
  const webview = lms.materialPanel ? lms.materialPanel.webview : null;
  const csp = webview ? webview.cspSource : '';
  const n = nonce();
  const detail = (current && current.detail) || {};
  const material = (current && current.material) || {};
  const title = materialDisplayTitle(detail.title ? detail : material);
  const typeLabel = materialTypeLabel(pick(detail, 'type') || pick(material, 'type'));
  const content = pick(detail, 'content');
  const body = String(content || '').trim()
    ? prepareMaterialContent(content)
    : '<div class="empty">' + ic('book', 22) + '<p>Материал пуст или ещё не загружен в LMS.</p></div>';
  const minutes = materialReadingMinutes(String(content || ''));
  const list = current && Array.isArray(current.materials) ? current.materials : [];
  const idx = list.findIndex(m => String(pick(m, 'id')) === String(current && current.materialId));
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const pager = (prev || next)
    ? '<nav class="pager" aria-label="Материалы урока">' +
      (prev ? pagerButton('prev', prev) : '<span></span>') +
      (next ? pagerButton('next', next) : '<span></span>') +
      '</nav>'
    : '';
  const crumbs = [current && current.courseTitle, current && current.lessonTitle].filter(Boolean);
  const metaBits = [escapeHtml(typeLabel)];
  if (minutes) metaBits.push(minutes + ' мин чтения');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} https: data: blob:; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground, #cccccc); background: var(--vscode-editor-background, transparent); margin: 0; line-height: 1.55; }

  /* ── липкая шапка: тип, название и действия всегда на виду ── */
  .topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px;
    padding: 9px 18px; background: var(--vscode-editor-background, #1f1f1f); border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .progress-track { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: transparent; }
  .progress-fill { height: 100%; width: 0; background: var(--vscode-progressBar-background, #0e70c0); transition: width .1s linear; }
  .tb-left { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1; }
  .tb-title { font-size: 1.02em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .type-pill { flex-shrink: 0; font-size: 0.76em; line-height: 1; padding: 4px 9px; border-radius: 999px; white-space: nowrap;
    color: var(--vscode-charts-blue, #3794ff); background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 35%, transparent); }
  .tb-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

  .btn { font-family: inherit; font-size: 0.9em; padding: 6px 12px; border-radius: 5px; border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #313131); color: var(--vscode-button-secondaryForeground, #cccccc);
    cursor: pointer; transition: filter .12s ease, transform .05s ease; display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
  .btn svg { flex-shrink: 0; }
  .btn:hover { filter: brightness(1.15); }
  .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); font-weight: 600; }
  .btn.sm { font-size: 0.85em; padding: 5px 12px; }
  .btn.icon { padding: 5px 7px; }
  .btn.icon svg { width: 13px; height: 13px; }

  .wrap { max-width: 860px; margin: 0 auto; padding: 14px 20px 56px; }
  .crumb { font-size: 0.84em; opacity: 0.65; margin: 2px 0 4px; display: flex; flex-wrap: wrap; gap: 5px; }
  .crumb .sep { opacity: 0.55; }
  .meta { opacity: 0.7; font-size: 0.86em; margin: 0 0 16px; }
  .meta .sep { margin: 0 7px; opacity: 0.6; }

  /* ── текст материала ── */
  .material { font-size: 1em; line-height: 1.7; }
  .material > :first-child { margin-top: 0; }
  .material h1 { font-size: 1.5em; line-height: 1.25; margin: 0.2em 0 0.8em; letter-spacing: -0.01em; }
  .material h2 { font-size: 1.24em; line-height: 1.3; margin: 1.6em 0 0.5em; }
  .material h3 { font-size: 1.12em; line-height: 1.35; margin: 1.7em 0 0.5em; scroll-margin-top: 68px; }
  .material h4, .material h5, .material h6 { font-size: 1em; margin: 1.3em 0 0.4em; }
  .material p { margin: 0.7em 0; }
  .material ul, .material ol { margin: 0.7em 0 0.7em 1.45em; padding: 0; }
  .material li { margin: 0.28em 0; }
  .material li > p { margin: 0.2em 0; }
  .material strong { font-weight: 600; }
  .material em { font-style: italic; }
  .material a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
  .material a:hover { text-decoration: underline; }
  .material hr { border: 0; border-top: 1px solid var(--vscode-panel-border, #2b2b2b); margin: 1.8em 0; }

  .material code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em;
    background: rgba(127,127,127,0.18); padding: 1px 5px; border-radius: 3px; }
  .material pre { margin: 1em 0; padding: 12px 14px; overflow: auto; border-radius: 8px; font-size: 0.9em; line-height: 1.5;
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); border: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .material pre code { background: none; padding: 0; border: 0; font-size: 1em; color: var(--vscode-editor-foreground, #d4d4d4); }

  /* ── подсветка синтаксиса: палитра VS Code Dark+ / Light+ ── */
  .material .tok-kw { color: #c586c0; }
  .material .tok-kw2 { color: #569cd6; }
  .material .tok-const { color: #4fc1ff; }
  .material .tok-builtin, .material .tok-fn, .material .tok-dec { color: #dcdcaa; }
  .material .tok-cls { color: #4ec9b0; }
  .material .tok-str { color: #ce9178; }
  .material .tok-num { color: #b5cea8; }
  .material .tok-com { color: #6a9955; }
  .material .tok-op { color: var(--vscode-editor-foreground, #d4d4d4); }
  .material .tok-var { color: #9cdcfe; }
  body.vscode-light .material .tok-kw { color: #af00db; }
  body.vscode-light .material .tok-kw2 { color: #0000ff; }
  body.vscode-light .material .tok-const { color: #0070c1; }
  body.vscode-light .material .tok-builtin,
  body.vscode-light .material .tok-fn,
  body.vscode-light .material .tok-dec { color: #795e26; }
  body.vscode-light .material .tok-cls { color: #267f99; }
  body.vscode-light .material .tok-str { color: #a31515; }
  body.vscode-light .material .tok-num { color: #098658; }
  body.vscode-light .material .tok-com { color: #008000; }
  body.vscode-light .material .tok-var { color: #001080; }
  .material samp { font-family: inherit; }
  .material blockquote { margin: 1em 0; padding: 2px 16px; border-left: 3px solid var(--vscode-charts-blue, #3794ff); opacity: 0.92; }

  .material img { display: block; max-width: 100%; height: auto; margin: 1.1em auto; border-radius: 10px;
    border: 1px solid var(--vscode-panel-border, #2b2b2b); background: #fff; }
  .material__content-positioner { text-align: center; margin: 1.1em 0; }
  .material__content-positioner img { margin: 0 auto; }
  .material__illustration { width: auto; }

  .material table { border-collapse: collapse; margin: 1em 0; max-width: 100%; display: block; overflow-x: auto; }
  .material th, .material td { border: 1px solid var(--vscode-panel-border, #2b2b2b); padding: 6px 10px; vertical-align: top; }
  .material th { background: rgba(127,127,127,0.1); font-weight: 600; }

  .material__chapter + .material__chapter { margin-top: 2em; }

  .material__plan { margin: 1.2em 0 1.9em; padding: 12px 16px 14px; border-radius: 10px;
    border: 1px solid var(--vscode-panel-border, #2b2b2b); background: var(--vscode-sideBar-background, rgba(127,127,127,0.05)); }
  .plan-title { font-size: 0.78em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.6; margin-bottom: 4px; }
  .material__plan nav ol { margin: 0.2em 0 0.2em 1.3em; padding: 0; }
  .material__plan li { margin: 0.22em 0; }
  .material__plan a { opacity: 0.92; }
  .material__link { color: var(--vscode-textLink-foreground, #3794ff); }

  .material__note, .material__quote, .material__correction { margin: 1.3em 0; padding: 11px 15px; border-radius: 8px; border-left: 3px solid; }
  .material__note { border-left-color: var(--vscode-charts-blue, #3794ff); background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 8%, transparent); }
  .material__quote { border-left-color: var(--vscode-charts-purple, #b180d7); background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 8%, transparent); opacity: 0.95; }
  .material__correction { border-left-color: var(--vscode-charts-orange, #d18616); background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 8%, transparent); }
  .material__note > :first-child, .material__quote > :first-child, .material__correction > :first-child { margin-top: 0; }
  .material__note > :last-child, .material__quote > :last-child, .material__correction > :last-child { margin-bottom: 0; }

  .pre-wrap { position: relative; margin: 1em 0; }
  .pre-wrap pre { margin: 0; }
  .copy-btn { position: absolute; top: 7px; right: 7px; font-family: inherit; font-size: 0.74em; padding: 3px 9px;
    border-radius: 5px; border: 1px solid var(--vscode-panel-border, #2b2b2b);
    background: var(--vscode-button-secondaryBackground, #313131); color: var(--vscode-button-secondaryForeground, #cccccc);
    cursor: pointer; opacity: 0; transition: opacity .12s ease; }
  .pre-wrap:hover .copy-btn, .copy-btn:focus-visible { opacity: 0.95; }
  .copy-btn:hover { filter: brightness(1.15); }

  .empty { margin: 24px 0; padding: 22px; text-align: center; border: 1px dashed var(--vscode-panel-border, #2b2b2b);
    border-radius: 10px; opacity: 0.75; }
  .empty svg { opacity: 0.6; }
  .empty p { margin: 8px 0 0; }

  .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 30px 0 8px; }
  .pager .pg { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; padding: 10px 14px; min-width: 0;
    border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 9px; background: var(--vscode-sideBar-background, rgba(127,127,127,0.05));
    color: inherit; cursor: pointer; font-family: inherit; text-align: left; transition: border-color .12s ease, background .12s ease; }
  .pager .pg:hover { border-color: var(--vscode-focusBorder, #007fd4); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .pager .pg:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
  .pager .pg.next { align-items: flex-end; text-align: right; }
  .pg-dir { display: inline-flex; align-items: center; gap: 4px; font-size: 0.76em; opacity: 0.6; }
  .pg-title { font-size: 0.9em; font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  @media (max-width: 620px) {
    .topbar { padding: 8px 12px; gap: 8px; }
    .type-pill { display: none; }
    .tb-title { font-size: 0.95em; }
    .btn.primary span { display: none; }
    .wrap { padding: 12px 14px 40px; }
    .pager { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="topbar">
    <div class="progress-track"><div class="progress-fill" id="progress"></div></div>
    <div class="tb-left">
      <span class="type-pill">${escapeHtml(typeLabel)}</span>
      <div class="tb-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
    </div>
    <div class="tb-right">
      <button type="button" data-act="refresh" class="btn secondary sm icon" title="Обновить материал" aria-label="Обновить материал">${ic('refresh')}</button>
      <button type="button" data-act="browser" class="btn primary sm" title="Открыть материал на сайте LMS" aria-label="Открыть в LMS">${ic('external')}<span>Открыть в LMS</span></button>
    </div>
  </div>
  <div class="wrap">
    ${crumbs.length ? '<div class="crumb">' + crumbs.map((x, i) => (i ? '<span class="sep">›</span>' : '') + escapeHtml(x)).join('') + '</div>' : ''}
    <div class="meta">${metaBits.join('<span class="sep">·</span>')}</div>
    <article class="material">${body}</article>
    ${pager}
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const progress = document.getElementById('progress');
  function updateProgress() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const p = max > 0 ? Math.min(100, Math.max(0, window.scrollY / max * 100)) : 0;
    if (progress) progress.style.width = p + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);
  updateProgress();

  // Копирование кода: сама кнопка внутри блока, текст берём из pre.
  document.querySelectorAll('.material pre').forEach(function (pre) {
    const wrap = document.createElement('div');
    wrap.className = 'pre-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Копировать';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(btn);
    wrap.appendChild(pre);
    btn.addEventListener('click', function () {
      vscode.postMessage({ type: 'copy', text: pre.innerText.replace(/\\n$/, '') });
      btn.textContent = 'Скопировано';
      setTimeout(function () { btn.textContent = 'Копировать'; }, 1200);
    });
  });

  document.addEventListener('click', function (ev) {
    const a = ev.target.closest ? ev.target.closest('a[href]') : null;
    if (a) {
      const href = a.getAttribute('href') || '';
      if (href.charAt(0) === '#') {
        const id = decodeURIComponent(href.slice(1));
        const target = id ? document.getElementById(id) : null;
        if (target) {
          ev.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      ev.preventDefault();
      vscode.postMessage({ type: 'openLink', href: href });
      return;
    }
    const el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) return;
    vscode.postMessage({ type: el.getAttribute('data-act') });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function attachMaterialPanel(panel, lms) {
  // viewType нельзя читать после dispose — сохраняем заранее.
  const panelViewType = panel && panel.viewType;
  panel.onDidDispose(() => {
    // Только своя панель: поздний dispose старой панели не должен сбрасывать
    // сторож и состояние уже открытой новой.
    if (lms.materialPanel === panel) {
      lms.materialPanel = null;
      lms.materialWatchToken = null;
    }
    mlog(lms, 'panel disposed ' + panelViewType);
  });
  panel.webview.onDidReceiveMessage(async msg => {
    const type = msg && msg.type;
    if (type === 'ready') {
      mlog(lms, 'panel ready ' + panelViewType);
      if (lms.materialPanel !== panel) return;
      lms.materialReady = true;
      return;
    }
    if (type === 'openLink') {
      try { await lms.openMaterialLink(msg.href); } catch (e) { }
      return;
    }
    if (type === 'copy') {
      try { await vscode.env.clipboard.writeText(String(msg.text || '')); } catch (e) { }
      return;
    }
    const map = {
      refresh: () => lms.refreshMaterial(),
      browser: () => lms.materialInBrowser(),
      prev: () => lms.openAdjacentMaterial(-1),
      next: () => lms.openAdjacentMaterial(1)
    };
    const fn = map[type];
    if (fn) {
      try { await fn(); } catch (e) { lms.output().appendLine('material action ' + type + ': ' + (e.message || e)); }
    }
  });
}

// Подключается к прототипу Lms (src/lms.js).
function attach(Lms) {
  // Баг VS Code #342842: webview расширения не может зарегистрировать service
  // worker и не присылает ready. Один короткий заход, затем — встроенный
  // предпросмотр Markdown: он создаётся с disableServiceWorker и работает.
  const WATCHDOG_MS = 4000;

  // Контекст урока: из узла дерева, текущей задачи или открытого материала.
  Lms.prototype.materialContextFrom = function (node) {
    const n = node || {};
    const lesson = n.lesson || null;
    const fallback = this.currentMaterial || this.currentTask || {};
    return {
      courseId: n.courseId !== undefined ? n.courseId : fallback.courseId,
      lessonId: n.lessonId !== undefined ? n.lessonId : (lesson && lesson.id !== undefined ? lesson.id : fallback.lessonId),
      groupId: n.groupId !== undefined ? n.groupId : fallback.groupId,
      courseTitle: n.courseTitle || fallback.courseTitle,
      lessonTitle: n.lessonTitle || n.label || fallback.lessonTitle
    };
  };

  // Открываем материал «на весь редактор»: панель материала остаётся
  // единственной вкладкой, остальные (условие задачи, файл решения, чужие
  // файлы) закрываются с предварительным сохранением.
  // keepOtherTabs — не закрывать чужие вкладки (повторный клик по уже
  // открытому материалу: пользователь мог писать решение рядом).
  Lms.prototype.focusMaterialOnly = async function (keepOtherTabs) {
    if (!this.materialPanel) {
      if (this.currentMaterial && (this.materialFallback || this.materialTextMode)) {
        mlog(this, 'focus: панели нет — открываю запасной режим');
        if (this.materialTextMode) await this.openMaterialText(keepOtherTabs);
        else await this.openMaterialMarkdown(keepOtherTabs);
        return;
      }
      mlog(this, 'focus: панели нет');
      return;
    }
    const panel = this.materialPanel;
    try { panel.reveal(vscode.ViewColumn.One, false); } catch (e) { }
    if (keepOtherTabs) {
      mlog(this, 'focus: уже открыт, вкладки не трогаем');
      return;
    }
    // Даём VS Code создать вкладку материала и зарегистрировать её в tabGroups,
    // иначе можно закрыть её же «вместе с остальными» до первого отображения.
    await new Promise(resolve => setTimeout(resolve, 200));
    const tabs = [];
    try {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const inp = tab.input;
          tabs.push((inp && inp.viewType) || 'other');
        }
      }
    } catch (e) { }
    mlog(this, 'focus panel=' + panel.viewType + ' tabs=[' + tabs.join(', ') + ']');
    try {
      const closed = await this.closeTabsForMaterial(panel);
      mlog(this, 'focus closed=' + closed + ' panelAlive=' + !!this.materialPanel);
    } catch (e) {
      mlog(this, 'focus error: ' + (e && e.message || e));
    }
    // Если панель материала всё-таки закрылась вместе с остальными вкладками,
    // открываем её заново: остальные вкладки уже закрыты, ничего не мешает.
    if (!this.materialPanel && this.currentMaterial) {
      mlog(this, 'focus: панель исчезла — открываю заново');
      this.renderMaterialPanel();
    } else if (this.materialPanel) {
      try { this.materialPanel.reveal(vscode.ViewColumn.One, false); } catch (e) { }
    }
  };

  Lms.prototype.openMaterial = async function (node) {
    const src = node && node.material ? node.material : (node || null);
    const materialId = src ? pick(src, 'id') : (node && node.materialId);
    try { vscode.window.setStatusBarMessage('LMS: открываю материал…', 4000); } catch (e) { }
    mlog(this, 'open id=' + materialId + ' node=' + (node && node.contextValue ? node.contextValue : typeof node));
    if (materialId === undefined || materialId === null) {
      if (this.currentMaterial) {
        if (this.materialPanel) {
          await this.focusMaterialOnly();
        } else {
          const loaded = await this.loadMaterial(this.currentMaterial);
          if (loaded) await this.focusMaterialOnly();
        }
        return;
      }
      mlog(this, 'open: нет id материала');
      vscode.window.showWarningMessage('LMS: выберите материал в панели «Яндекс LMS».');
      return;
    }
    const ctx = this.materialContextFrom(node);
    mlog(this, 'open ctx lesson=' + ctx.lessonId + ' course=' + ctx.courseId + ' group=' + ctx.groupId);
    if (ctx.lessonId === undefined || ctx.lessonId === null) {
      vscode.window.showWarningMessage('LMS: не удалось определить урок материала.');
      return;
    }
    const authed = await this.ensureAuth();
    mlog(this, 'open auth=' + authed);
    if (!authed) return;
    if (this.currentMaterial &&
        String(this.currentMaterial.materialId) === String(materialId) &&
        (this.materialPanel || this.materialFallback || this.materialTextMode)) {
      mlog(this, 'open: этот материал уже открыт');
      if (node && Array.isArray(node.materials) && node.materials.length) {
        this.currentMaterial.materials = node.materials;
      }
      await this.focusMaterialOnly(true);
      return;
    }
    const loaded = await this.loadMaterial(Object.assign({}, ctx, {
      materialId,
      material: src || { id: materialId },
      materials: node && Array.isArray(node.materials) ? node.materials : ((this.currentMaterial && this.currentMaterial.materials) || [])
    }));
    mlog(this, 'open loaded=' + loaded);
    if (loaded) await this.focusMaterialOnly();
  };

  Lms.prototype.loadMaterial = async function (ctx) {
    const fetchAndShow = async () => {
      mlog(this, 'fetch material=' + ctx.materialId + ' lesson=' + ctx.lessonId);
      const r = await this.client.material(ctx.materialId, ctx.lessonId);
      mlog(this, 'fetch status=' + r.status + ' json=' + !!r.json);
      if (r.status !== 200 || !r.json) {
        const cached = this.materialCache.get(String(ctx.materialId));
        if (cached) {
          this.currentMaterial = Object.assign({}, ctx, { detail: cached, title: pick(cached, 'title'), type: pick(cached, 'type') });
          await this.renderMaterialPanel();
          vscode.window.showWarningMessage('LMS: материал не обновился (HTTP ' + r.status + '). Показана сохранённая копия.');
          return true;
        }
        vscode.window.showErrorMessage('LMS: не удалось загрузить материал (HTTP ' + r.status + ').');
        return false;
      }
      this.materialCache.set(String(ctx.materialId), r.json);
      this.currentMaterial = Object.assign({}, ctx, {
        detail: r.json,
        title: pick(r.json, 'title') || pick(ctx.material, 'title') || 'Материал',
        type: pick(r.json, 'type') || pick(ctx.material, 'type')
      });
      await this.renderMaterialPanel();
      return true;
    };
    if (this.materialPanel) return fetchAndShow();
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LMS: загружаю материал…' },
      fetchAndShow
    );
  };

  Lms.prototype.renderMaterialPanel = function () {
    const cur = this.currentMaterial;
    if (!cur) return Promise.resolve();
    const title = materialDisplayTitle(cur.detail && cur.detail.title ? cur.detail : (cur.material || {}));
    mlog(this, 'render panel=' + !!this.materialPanel + ' fallback=' + !!this.materialFallback + ' text=' + !!this.materialTextMode + ' title=' + title);
    if (this.materialTextMode) return this.openMaterialText();
    if (this.materialFallback) return this.openMaterialMarkdown();
    if (!this.materialPanel) {
      this.openMaterialPanel(title);
      return Promise.resolve();
    }
    const panel = this.materialPanel;
    this.materialReady = false;
    try {
      panel.title = title;
      panel.webview.html = materialHtml(this, cur);
    } catch (e) {
      this.output().appendLine('Панель материала не обновилась: ' + (e.message || e));
      // Ссылка на уже закрытую панель — пересоздаём, иначе материал не откроется.
      if (/disposed/i.test(String(e && e.message || e))) {
        this.materialPanel = null;
        return this.openMaterialPanel(title);
      }
    }
    return Promise.resolve();
  };

  Lms.prototype.hasMarkdownPreviewTab = function () {
    try {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const viewType = tab.input && tab.input.viewType;
          if (typeof viewType === 'string' && viewType.indexOf(MARKDOWN_PREVIEW_VIEW_TYPE) >= 0) return true;
        }
      }
    } catch (e) { }
    return false;
  };

  // Запасной режим: Markdown-файл во временном каталоге + встроенный
  // предпросмотр. Код подсвечивает сам VS Code (highlight.js), картинки и
  // таблицы остаются, а service worker не нужен.
  Lms.prototype.openMaterialMarkdown = async function (keepOtherTabs) {
    const cur = this.currentMaterial;
    if (!cur) return false;
    const title = materialDisplayTitle(cur.detail && cur.detail.title ? cur.detail : (cur.material || {}));
    const dir = this.viewDir();
    const file = path.join(dir, safeName(title) + '.md');
    try {
      fs.writeFileSync(file, materialMarkdown(cur, this.client.base), 'utf8');
    } catch (e) {
      mlog(this, 'markdown write error: ' + (e.message || e));
      return this.openMaterialText();
    }
    const uri = vscode.Uri.file(file);
    this.materialDocUri = uri;
    this.materialFallback = true;
    this.materialTextMode = false;
    mlog(this, 'markdown fallback file=' + path.basename(file) + ' title=' + title);
    try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch (e) { }
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch (e) {
      mlog(this, 'markdown preview error: ' + (e.message || e));
      return this.openMaterialText();
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!this.hasMarkdownPreviewTab()) {
      mlog(this, 'markdown preview tab missing — text fallback');
      return this.openMaterialText();
    }
    try {
      const closed = keepOtherTabs ? 0 : await this.closeTabsForMaterial({ viewType: MARKDOWN_PREVIEW_VIEW_TYPE });
      mlog(this, 'markdown tabs closed=' + closed);
    } catch (e) { }
    return true;
  };

  // Последний рубеж: обычный текстовый редактор. Не зависит от webview вообще.
  Lms.prototype.openMaterialText = async function (keepOtherTabs) {
    const cur = this.currentMaterial;
    if (!cur) {
      vscode.window.showWarningMessage('LMS: сначала откройте материал.');
      return false;
    }
    if (this.materialPanel) {
      try { this.materialPanel.dispose(); } catch (e) { }
      this.materialPanel = null;
    }
    this.materialWatchToken = null;
    this.materialFallback = true;
    this.materialTextMode = true;
    const title = materialDisplayTitle(cur.detail && cur.detail.title ? cur.detail : (cur.material || {}));
    const dir = this.viewDir();
    const file = path.join(dir, safeName(title) + '.txt');
    try {
      fs.writeFileSync(file, materialPlainText(cur), 'utf8');
    } catch (e) {
      mlog(this, 'text write error: ' + (e.message || e));
      vscode.window.showErrorMessage('LMS: не удалось сохранить материал: ' + (e.message || e));
      return false;
    }
    const uri = vscode.Uri.file(file);
    this.materialDocUri = uri;
    mlog(this, 'text fallback file=' + path.basename(file) + ' title=' + title);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false });
    } catch (e) {
      mlog(this, 'text open error: ' + (e.message || e));
      vscode.window.showErrorMessage('LMS: не удалось открыть материал текстом: ' + (e.message || e));
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      const closed = keepOtherTabs ? 0 : await this.closeTabsForUri(uri);
      mlog(this, 'text tabs closed=' + closed);
    } catch (e) { }
    return true;
  };

  // Повторная попытка открыть богатую панель (команда «Материал — панелью»).
  Lms.prototype.retryMaterialPanel = async function () {
    const cur = this.currentMaterial;
    if (!cur) {
      vscode.window.showWarningMessage('LMS: сначала откройте материал.');
      return;
    }
    this.materialFallback = false;
    this.materialTextMode = false;
    this.materialFallbackNotified = false;
    this.setWebviewBroken(false);
    if (this.materialPanel) {
      try { this.materialPanel.dispose(); } catch (e) { }
      this.materialPanel = null;
    }
    this.materialWatchToken = null;
    await this.loadMaterial(cur);
    if (this.materialPanel) await this.focusMaterialOnly();
  };

  Lms.prototype.notifyMaterialFallback = function () {
    if (this.materialFallbackNotified) return;
    this.materialFallbackNotified = true;
    const opened = this.materialTextMode
      ? 'Материал открыт текстом — без webview.'
      : 'Материал открыт в предпросмотре Markdown.';
    const buttons = ['Починить webview'];
    if (!this.materialTextMode) buttons.push('Открыть текстом');
    buttons.push('В браузере');
    let pending;
    try {
      pending = vscode.window.showWarningMessage(
        'LMS: панель материала не загрузилась (баг webview в VS Code). ' + opened,
        ...buttons
      );
    } catch (e) { return; }
    if (!pending || typeof pending.then !== 'function') return;
    pending.then(choice => {
      if (choice === 'Починить webview') {
        vscode.commands.executeCommand('yandexLms.fixWebviewProfile').then(undefined, () => { });
      } else if (choice === 'Открыть текстом') {
        this.openMaterialText().then(undefined, () => { });
      } else if (choice === 'В браузере') {
        this.materialInBrowser().then(undefined, () => { });
      }
    }, () => { });
  };

  Lms.prototype.openMaterialPanel = function (title) {
    if (this.materialTextMode) return this.openMaterialText();
    if (this.materialFallback) return this.openMaterialMarkdown();
    // Материал показываем панелью, значит прежний .md/.txt больше не материал:
    // иначе closeAllTabs будет считать чужие вкладки предпросмотра «своими».
    this.materialDocUri = null;
    if (this.materialViewCounter === undefined) this.materialViewCounter = 0;
    this.materialViewCounter++;
    const viewType = this.materialViewCounter === 1 ? MATERIAL_VIEW_TYPE : MATERIAL_VIEW_TYPE + '-' + this.materialViewCounter;
    const panel = vscode.window.createWebviewPanel(viewType, title || 'Материал', { viewColumn: vscode.ViewColumn.One, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      disableServiceWorker: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    attachMaterialPanel(panel, this);
    this.materialPanel = panel;
    this.materialReady = false;
    mlog(this, 'panel created viewType=' + viewType);
    try { panel.iconPath = new vscode.ThemeIcon('book'); } catch (e) { }
    const token = (this.materialWatchToken = {});
    try {
      const html = materialHtml(this, this.currentMaterial);
      panel.webview.html = html;
      mlog(this, 'panel html=' + html.length);
    } catch (e) {
      this.output().appendLine('Панель материала не создалась: ' + (e.message || e));
      if (this.materialPanel === panel) this.materialPanel = null;
      this.materialWatchToken = null;
      try { panel.dispose(); } catch (e2) { }
      this.materialFallback = true;
      return this.openMaterialMarkdown();
    }
    setTimeout(async () => {
      if (token !== this.materialWatchToken || this.materialPanel !== panel || this.materialReady) return;
      this.output().appendLine('LMS material: webview не загрузился за ' + WATCHDOG_MS + ' мс (#342842) — открываю предпросмотр Markdown');
      try { panel.dispose(); } catch (e) { }
      if (this.materialPanel === panel) this.materialPanel = null;
      this.materialWatchToken = null;
      // Глобальный yandexLms.webviewBroken здесь не трогаем: таймаут одного
      // материала не должен переключать условие задачи на текстовый режим.
      // Материал сам запомнит фолбэк в materialFallback до «Починить webview».
      await this.openMaterialMarkdown();
      this.notifyMaterialFallback();
    }, WATCHDOG_MS);
    return Promise.resolve();
  };

  Lms.prototype.refreshMaterial = async function () {
    const cur = this.currentMaterial;
    if (!cur) return;
    const r = await this.client.material(cur.materialId, cur.lessonId);
    if (r.status === 200 && r.json) {
      cur.detail = r.json;
      this.materialCache.set(String(cur.materialId), r.json);
      await this.renderMaterialPanel();
      vscode.window.setStatusBarMessage('LMS: материал обновлён', 2000);
    } else {
      vscode.window.showErrorMessage('LMS: не удалось обновить материал (HTTP ' + r.status + ').');
    }
  };

  Lms.prototype.openAdjacentMaterial = async function (delta) {
    const cur = this.currentMaterial;
    if (!cur) return;
    const list = Array.isArray(cur.materials) ? cur.materials : [];
    if (!list.length) {
      vscode.window.showInformationMessage('LMS: список материалов урока недоступен.');
      return;
    }
    const idx = list.findIndex(m => String(pick(m, 'id')) === String(cur.materialId));
    const target = idx >= 0 ? list[idx + delta] : null;
    if (!target) {
      vscode.window.showInformationMessage(delta < 0 ? 'LMS: это первый материал урока.' : 'LMS: это последний материал урока.');
      return;
    }
    await this.openMaterial({
      material: target,
      materials: list,
      courseId: cur.courseId,
      lessonId: cur.lessonId,
      groupId: cur.groupId,
      courseTitle: cur.courseTitle,
      lessonTitle: cur.lessonTitle
    });
  };

  Lms.prototype.materialUrl = function (ctx) {
    const cur = ctx || this.currentMaterial || {};
    const explicit = pick(cur.detail, 'url', 'link') || pick(cur.material, 'url', 'link');
    if (explicit) return String(explicit);
    const base = this.client.base;
    const materialId = cur.materialId;
    const lessonId = cur.lessonId;
    const courseId = cur.courseId;
    if (materialId === undefined || materialId === null || lessonId === undefined || lessonId === null || courseId === undefined || courseId === null) {
      return base + '/';
    }
    const group = cur.groupId !== undefined && cur.groupId !== null ? '/groups/' + cur.groupId : '';
    return base + '/courses/' + courseId + group + '/lessons/' + lessonId + '/materials/' + materialId;
  };

  Lms.prototype.materialInBrowser = async function (node) {
    let ctx = this.currentMaterial;
    if (node) {
      const material = node.material || (pick(node, 'id') !== undefined ? node : null);
      const materialId = material ? pick(material, 'id') : node.materialId;
      if (materialId !== undefined && materialId !== null) {
        ctx = Object.assign({}, this.materialContextFrom(node), { materialId, material });
      }
    }
    if (!ctx) {
      vscode.window.showWarningMessage('LMS: сначала откройте материал.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(this.materialUrl(ctx)));
  };

  Lms.prototype.openMaterialLink = async function (href) {
    let url;
    try {
      url = new URL(String(href || ''), this.client.base + '/');
    } catch (e) {
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  };

  Lms.prototype.openLessonMaterials = async function (node) {
    const ctx = this.materialContextFrom(node);
    if (ctx.lessonId === undefined || ctx.lessonId === null) {
      vscode.window.showWarningMessage('LMS: выберите урок в панели «Яндекс LMS».');
      return;
    }
    if (!(await this.ensureAuth())) return;
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LMS: загружаю материалы урока…' },
      () => this.client.lessonMaterials(ctx.courseId, ctx.lessonId, ctx.groupId)
    );
    const arr = r && r.status === 200 ? asArray(r.json, ['materials', 'items', 'data', 'results']) : null;
    if (!r || r.status !== 200) {
      vscode.window.showErrorMessage('LMS: не удалось загрузить материалы урока (HTTP ' + (r ? r.status : 'ERR') + ').');
      return;
    }
    const list = (Array.isArray(arr) ? arr : []).filter(m => m && pick(m, 'id') !== undefined);
    if (!list.length) {
      vscode.window.showInformationMessage('LMS: в этом уроке нет материалов.');
      return;
    }
    if (list.length === 1) {
      await this.openMaterial(Object.assign({}, ctx, { material: list[0], materials: list }));
      return;
    }
    const items = list.map(m => ({
      label: '$(book) ' + materialDisplayTitle(m),
      description: materialTypeLabel(pick(m, 'type')),
      material: m
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Материалы урока: ' + (ctx.lessonTitle || '') });
    if (picked) await this.openMaterial(Object.assign({}, ctx, { material: picked.material, materials: list }));
  };
}

module.exports = {
  attach,
  materialHtml,
  prepareMaterialContent,
  MATERIAL_VIEW_TYPE
};
