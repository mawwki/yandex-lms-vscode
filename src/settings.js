// Единая панель настроек вместо цепочки QuickPick/InputBox из палитры команд.
// Одно окно: разделы слева, поля справа, сохранение на лету (change → update).
// Секреты (API-ключи) по-прежнему живут в SecretStorage пула, в HTML не попадают —
// в поле ключа только маска «••••abcd».
const vscode = require('vscode');
const crypto = require('crypto');
const { cfg } = require('./cfg');
const { escapeHtml } = require('./util');
const pool = require('./ai/pool');
const { AI_PROVIDERS, providerDef } = require('./ai/providers');
const { aiListModels } = require('./ai/chat');
const { openCodeVersion, resolveOpenCodeBin } = require('./ai/opencode');
const { clineVersion, resolveClineBin } = require('./ai/cline');

const VIEW_TYPE = 'yandexLmsSettings';

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

// JSON внутрь <script>: экранируем «<», чтобы данные не закрыли тег.
function jsData(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

const SECTIONS = [
  { id: 'account', title: 'Аккаунт и LMS' },
  { id: 'lens', title: 'Google Объектив' },
  { id: 'ai', title: 'ИИ: провайдеры' },
  { id: 'aiBehavior', title: 'ИИ: поведение' },
  { id: 'diag', title: 'Диагностика' }
];

const TASK_VIEW_OPTIONS = [
  { value: 'panel', label: 'Панель условия (с кнопками)' },
  { value: 'text', label: 'Текстом (надёжно, без кнопок)' },
  { value: 'auto', label: 'Авто: панель, при сбое — текст' }
];

const LENS_OPEN_OPTIONS = [
  { value: 'browser', label: 'В браузере по умолчанию' },
  { value: 'panel', label: 'В VS Code (снимок + ссылка)' }
];

// Описание полей настроек: одно место, откуда берутся и разметка, и валидация.
const FIELDS = [
  { key: 'apiBase', section: 'account', type: 'text', label: 'Адрес LMS', desc: 'Обычно менять не нужно', placeholder: 'https://lms.yandex.ru' },
  { key: 'folderName', section: 'account', type: 'text', label: 'Папка для решений', desc: 'Внутри рабочей области', placeholder: 'yandex-lms' },
  { key: 'pythonPath', section: 'account', type: 'text', label: 'Python', desc: 'Команда запуска для локального прогона и PEP 8', placeholder: 'python' },
  { key: 'pollSeconds', section: 'account', type: 'number', label: 'Ожидание вердикта', desc: 'Сколько секунд ждать проверку после отправки', min: 10, max: 600, step: 5, unit: 'с' },
  { key: 'taskView', section: 'account', type: 'enum', label: 'Условие задачи', desc: 'Как показывать текст задания', options: TASK_VIEW_OPTIONS },

  { key: 'lens.openIn', section: 'lens', type: 'enum', label: 'Где открывать результат', desc: 'Google не разрешает встраивать страницу результатов, поэтому в VS Code показывается снимок и ссылка', options: LENS_OPEN_OPTIONS },
  { key: 'lens.scale', section: 'lens', type: 'number', label: 'Качество снимка', desc: 'Масштаб растрирования условия: больше — чётче и тяжелее', min: 1, max: 3, step: 1, unit: '×' },

  { heading: 'Автодополнение', section: 'aiBehavior' },
  { key: 'ai.autocomplete', section: 'aiBehavior', type: 'bool', label: 'Подсказывать следующую строку', desc: 'ИИ-автодополнение прямо в редакторе Python' },
  { key: 'ai.autocompleteDelay', section: 'aiBehavior', type: 'number', label: 'Задержка подсказки', desc: 'Пауза перед запросом к ИИ', min: 200, max: 5000, step: 100, unit: 'мс' },
  { key: 'ai.autocompleteMaxCalls', section: 'aiBehavior', type: 'number', label: 'Лимит подсказок', desc: 'Максимум запросов в минуту', min: 1, max: 120, step: 1, unit: 'в мин' },

  { heading: 'Качество и скорость', section: 'aiBehavior' },
  { key: 'ai.selfCheck', section: 'aiBehavior', type: 'bool', label: 'Самопроверка кода', desc: 'Проверять ответ ИИ на запрещённые в курсе конструкции и компиляцию Python' },
  { key: 'ai.hedge', section: 'aiBehavior', type: 'bool', label: 'Второй ключ параллельно', desc: 'Если первый ключ тормозит — запросить следующий и взять первый ответ' },
  { key: 'ai.hedgeDelay', section: 'aiBehavior', type: 'number', label: 'Порог ускорения', desc: 'Через сколько ждать перед параллельным запросом', min: 1000, max: 30000, step: 500, unit: 'мс' },
  { key: 'ai.retries', section: 'aiBehavior', type: 'number', label: 'Попыток за запрос', desc: 'Сколько ключей пробовать, прежде чем сдаться', min: 1, max: 10, step: 1 },
  { key: 'ai.temperature', section: 'aiBehavior', type: 'number', label: 'Температура', desc: 'Меньше — точнее, больше — разнообразнее', min: 0, max: 2, step: 0.1 },
  { key: 'ai.courseRules', section: 'aiBehavior', type: 'textarea', label: 'Правила курса для ИИ', desc: 'Что разрешено ученику. Пусто — встроенные правила базового курса', rows: 6, placeholder: 'Пусто — использовать встроенные правила курса «Программирование на Python»' },

  { heading: 'Локальные агенты (CLI)', section: 'aiBehavior' },
  { key: 'ai.opencodeBin', section: 'aiBehavior', type: 'text', label: 'OpenCode', desc: 'Команда или путь к бинарнику', placeholder: 'opencode' },
  { key: 'ai.clineBin', section: 'aiBehavior', type: 'text', label: 'Cline', desc: 'Команда или путь к бинарнику', placeholder: 'cline' },

  { heading: 'Отладка', section: 'diag' },
  { key: 'debug', section: 'diag', type: 'bool', label: 'Писать диагностику в файлы', desc: 'Логи запросов, отправки и webview в %TEMP%\\yandex-lms-diag. Туда попадают условия задач и ваш код — включайте осознанно' }
];

const FIELD_BY_KEY = new Map(FIELDS.filter(f => f.key).map(f => [f.key, f]));

function rowHtml(f, value) {
  if (f.heading) {
    return '<h3 class="sub">' + escapeHtml(f.heading) + '</h3>';
  }
  const search = escapeHtml([f.label, f.desc || '', 'yandexLms.' + f.key].join(' '));
  const raw = value === undefined || value === null ? '' : String(value);
  let ctl = '';
  if (f.type === 'bool') {
    const on = value === true;
    ctl = '<button type="button" class="switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') +
      '" data-key="' + f.key + '" data-type="bool" title="' + (on ? 'Выключить' : 'Включить') + '"><span class="knob"></span></button>';
  } else if (f.type === 'enum') {
    ctl = '<select class="inp sel" data-key="' + f.key + '" data-type="enum">' +
      (f.options || []).map(o =>
        '<option value="' + escapeHtml(o.value) + '"' + (raw === o.value ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>'
      ).join('') + '</select>';
  } else if (f.type === 'textarea') {
    ctl = '<textarea class="inp ta" rows="' + (f.rows || 5) + '" data-key="' + f.key + '" data-type="text" placeholder="' +
      escapeHtml(f.placeholder || '') + '">' + escapeHtml(raw) + '</textarea>';
  } else if (f.type === 'number') {
    ctl = '<div class="num"><input class="inp" type="number" data-key="' + f.key + '" data-type="number" value="' + escapeHtml(raw) + '"' +
      (f.min !== undefined ? ' min="' + f.min + '"' : '') + (f.max !== undefined ? ' max="' + f.max + '"' : '') +
      (f.step !== undefined ? ' step="' + f.step + '"' : '') + '>' +
      (f.unit ? '<span class="unit">' + escapeHtml(f.unit) + '</span>' : '') + '</div>';
  } else {
    ctl = '<input class="inp" type="text" data-key="' + f.key + '" data-type="text" value="' + escapeHtml(raw) +
      '" placeholder="' + escapeHtml(f.placeholder || '') + '" spellcheck="false">';
  }
  return '<div class="row" data-search="' + search + '">' +
    '<div class="row-main"><div class="row-label">' + escapeHtml(f.label) + '</div>' +
    (f.desc ? '<div class="row-desc">' + escapeHtml(f.desc) + '</div>' : '') +
    '<div class="row-key">yandexLms.' + escapeHtml(f.key) + '</div></div>' +
    '<div class="row-ctl">' + ctl + '<span class="row-state" data-for="' + f.key + '"></span></div></div>';
}

function sectionRows(section, conf) {
  return FIELDS.filter(f => f.section === section).map(f => rowHtml(f, f.key ? conf.get(f.key) : undefined)).join('');
}

function statusPill(e) {
  const cd = pool.aiCooldownLeft(e);
  const st = pool.stateOf(e) || {};
  if (cd > 0) {
    return '<span class="pill warn" title="' + escapeHtml(st.lastError || '') + '">лимит ещё ' + Math.ceil(cd / 60000) + ' мин</span>';
  }
  if (st.ms) return '<span class="pill ok" title="Последний ответ">' + (st.ms / 1000).toFixed(1) + ' с</span>';
  return '<span class="pill">готов</span>';
}

function poolCardHtml(e, activeId) {
  const isCli = e.provider === 'opencode' || e.provider === 'cline';
  const def = providerDef(e.provider);
  const isPrimary = e.id === activeId;
  const st = pool.stateOf(e) || {};
  const cd = pool.aiCooldownLeft(e);
  const search = escapeHtml([e.label || '', e.model || '', e.provider, e.baseUrl || '', e.bin || ''].join(' '));

  const fields = [];
  fields.push('<label class="f"><span>Название</span><input class="inp" data-pool="label" value="' + escapeHtml(e.label || def.label) + '"></label>');
  fields.push('<label class="f"><span>Модель</span><span class="with-btn"><input class="inp" data-pool="model" list="models-' + e.id +
    '" value="' + escapeHtml(e.model || '') + '" spellcheck="false"><button class="btn xs" data-act="poolModels" title="Загрузить список моделей">Список</button></span>' +
    '<datalist id="models-' + e.id + '"></datalist></label>');
  if (isCli) {
    fields.push('<label class="f"><span>Команда / путь</span><input class="inp" data-pool="bin" value="' + escapeHtml(e.bin || e.provider) + '" spellcheck="false"></label>');
    if (e.provider === 'opencode') {
      fields.push('<label class="f"><span>Агент</span><input class="inp" data-pool="agent" value="' + escapeHtml(e.agent || '') +
        '" placeholder="пусто — обычный режим" spellcheck="false"></label>');
    }
  } else {
    fields.push('<label class="f"><span>Базовый URL</span><input class="inp" data-pool="baseUrl" value="' + escapeHtml(e.baseUrl || '') + '" spellcheck="false"></label>');
    fields.push('<label class="f"><span>API-ключ</span><span class="with-btn"><input class="inp" type="password" data-pool="apiKey" value="" placeholder="' +
      escapeHtml(pool.aiKeyTail(e.apiKey)) + '" autocomplete="off" spellcheck="false"><button class="btn xs" data-act="revealKey" title="Показать введённое" aria-label="Показать">' +
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M1.6 8s2.4-4.3 6.4-4.3S14.4 8 14.4 8s-2.4 4.3-6.4 4.3S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.8"/></svg></button></span></label>');
  }

  return '<div class="card" data-id="' + e.id + '" data-search="' + search + '">' +
    '<div class="card-h"><span class="prov">' + escapeHtml(def.label) + '</span>' + statusPill(e) +
    (isPrimary
      ? '<span class="star" title="Пробуется первым">★ основной</span>'
      : '<button class="btn xs" data-act="poolPrimary">Сделать основным</button>') +
    '</div>' +
    '<div class="grid">' + fields.join('') + '</div>' +
    '<div class="card-f">' +
    '<button class="btn xs" data-act="poolTest">Проверить</button>' +
    '<button class="btn xs danger" data-act="poolDelete">Удалить</button>' +
    (cd > 0 && st.lastError ? '<span class="muted err-text" title="' + escapeHtml(st.lastError) + '">' + escapeHtml(st.lastError) + '</span>' : '') +
    '</div></div>';
}

// Блок «Куки Google» в разделе Объектива: статус, авто-обновление и вставка
// строки Cookie из браузера. Сами куки живут в SecretStorage, в HTML их нет.
function lensCookieBlockHtml(lms) {
  let st = { count: 0 };
  try { if (lms && typeof lms.lensStatus === 'function') st = lms.lensStatus(); } catch (e) { }
  const count = Number(st.count) || 0;
  const when = st.at ? new Date(st.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const src = st.source === 'browser' ? 'из браузера' : st.source === 'auto' ? 'гостевые' : '';
  const pill = count
    ? '<span class="pill ok">' + count + ' шт' + (src ? ' · ' + src : '') + (when ? ' · ' + escapeHtml(when) : '') + '</span>'
    : '<span class="pill warn">кук нет</span>';

  return '<h3 class="sub">Куки Google</h3>' +
    '<div class="row" data-search="куки google cookie объектив робот проверка captcha">' +
    '<div class="row-main"><div class="row-label">Куки для запросов к Объективу</div>' +
    '<div class="row-desc">Без кук Google чаще включает проверку «я не робот». Гостевые куки забираются сами при первом снимке; кнопка «Обновить автоматически» делает это вручную. ' +
    'Куки своего аккаунта Chrome и Edge не отдают (шифруют ключом, привязанным к браузеру), поэтому их вставляют строкой из DevTools — ' +
    'они уходят в защищённое хранилище VS Code, а не в settings.json.</div></div>' +
    '<div class="row-ctl">' + pill + '</div></div>' +
    '<div class="actions">' +
    '<button class="btn" data-act="lensWarm">Обновить автоматически</button>' +
    '<button class="btn" data-act="lensTest">Проверить связь с Google</button>' +
    '<button class="btn" data-act="action" data-name="lensOpen">Открыть lens.google.com</button>' +
    (count ? '<button class="btn danger" data-act="lensClear">Удалить куки</button>' : '') +
    '</div>' +
    '<label class="f" data-search="куки google вставить строку браузер cookie"><span>Строка Cookie из браузера (F12 → Network → запрос к google.com → Cookie)</span>' +
    '<textarea class="inp ta" id="lens-cookies" rows="3" spellcheck="false" placeholder="NID=...; SID=...; HSID=...; SSID=...; APISID=...; SAPISID=..."></textarea></label>' +
    '<div class="actions"><button class="btn primary" data-act="lensSave">Сохранить куки</button>' +
    '<span class="hint" id="lens-hint"></span></div>';
}

function providersJson() {
  const out = {};
  for (const k of Object.keys(AI_PROVIDERS)) {
    if (k === 'none') continue;
    const d = AI_PROVIDERS[k];
    out[k] = { label: d.label, baseUrl: d.baseUrl || '', model: d.model || '', bin: d.bin || '', cli: k === 'opencode' || k === 'cline' };
  }
  return out;
}

function settingsHtml(lms) {
  const panel = lms.settingsPanel;
  const csp = panel ? panel.webview.cspSource : '';
  const n = nonce();
  const conf = cfg();
  const pkg = (lms.context && lms.context.extension && lms.context.extension.packageJSON) || {};
  const entries = pool.aiEntries();
  const activeId = pool.AI_POOL_ACTIVE_REF();

  const nav = SECTIONS.map((s, i) =>
    '<button class="nav-btn' + (i === 0 ? ' active' : '') + '" data-act="goto" data-section="' + s.id + '">' + escapeHtml(s.title) + '</button>'
  ).join('');

  const aiSection = '<section class="sec" id="sec-ai">' +
    '<h2>ИИ: провайдеры и ключи</h2>' +
    '<p class="lead">Ключи хранятся в защищённом хранилище VS Code, не в settings.json. При лимите или ошибке ключ временно «остывает», запрос уходит к следующему.</p>' +
    '<div class="actions">' +
    '<button class="btn primary" data-act="toggleAdd">Добавить провайдера</button>' +
    '<button class="btn" data-act="testAll"' + (entries.length ? '' : ' disabled') + '>Проверить все</button>' +
    '<button class="btn" data-act="resetLimits">Сбросить лимиты</button>' +
    '</div>' +
    (entries.length
      ? '<div class="cards">' + entries.map(e => poolCardHtml(e, activeId)).join('') + '</div>'
      : '<div class="empty">Пока ни одного ключа. Добавьте API-ключ (OpenRouter, OpenAI, Mistral, Ollama) или подключите локальный агент OpenCode / Cline — он работает без ключа.</div>') +
    addFormHtml() +
    '</section>';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5;
    color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); }

  /* ── шапка с поиском ── */
  .hdr { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 10px 24px; background: var(--vscode-editor-background, #1e1e1e);
    border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); }
  .hdr-title { font-size: 1.15em; font-weight: 600; }
  .hdr-sub { font-size: .85em; opacity: .6; margin-left: 8px; }
  .hdr-r { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .q { width: 240px; font-family: inherit; font-size: .92em; padding: 5px 10px; border-radius: 5px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #2b2b2b));
    background: var(--vscode-input-background, #313131); color: var(--vscode-input-foreground, #ccc); outline: none; }
  .q:focus { border-color: var(--vscode-focusBorder, #007fd4); }

  /* ── каркас: навигация + содержимое ── */
  .layout { display: flex; align-items: flex-start; gap: 28px; max-width: 1140px; margin: 0 auto; padding: 20px 24px 90px; }
  .nav { position: sticky; top: 62px; flex: 0 0 208px; display: flex; flex-direction: column; gap: 2px; }
  .nav-btn { text-align: left; font-family: inherit; font-size: .92em; padding: 7px 11px; border-radius: 6px;
    border: 1px solid transparent; background: none; color: var(--vscode-foreground, #ccc); cursor: pointer; opacity: .82; }
  .nav-btn:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.1)); opacity: 1; }
  .nav-btn.active { background: var(--vscode-list-activeSelectionBackground, rgba(127,127,127,.18));
    color: var(--vscode-list-activeSelectionForeground, #fff); opacity: 1; font-weight: 600; }
  .main { flex: 1; min-width: 0; }
  .sec { margin: 0 0 40px; scroll-margin-top: 72px; }
  .sec h2 { font-size: 1.12em; margin: 0 0 4px; }
  .sec .lead { margin: 0 0 14px; opacity: .72; font-size: .9em; max-width: 70ch; }
  h3.sub { font-size: .8em; text-transform: uppercase; letter-spacing: .07em; opacity: .55;
    margin: 24px 0 2px; font-weight: 600; }

  /* ── строки настроек ── */
  .row { display: flex; gap: 20px; align-items: flex-start; padding: 11px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.18)); }
  .row-main { flex: 1; min-width: 0; }
  .row-label { font-weight: 500; }
  .row-desc { font-size: .86em; opacity: .65; margin-top: 2px; }
  .row-key { font-size: .76em; opacity: .35; margin-top: 3px; font-family: var(--vscode-editor-font-family, monospace); }
  .row-ctl { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding-top: 2px; }
  .inp { font-family: inherit; font-size: .92em; padding: 5px 9px; width: 260px; border-radius: 5px; outline: none;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #2b2b2b));
    background: var(--vscode-input-background, #313131); color: var(--vscode-input-foreground, #ccc); }
  .inp:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .inp.ta { width: 100%; min-height: 90px; resize: vertical; line-height: 1.45; font-family: var(--vscode-editor-font-family, monospace); font-size: .86em; }
  .sel { width: 260px; }
  .num { display: flex; align-items: center; gap: 6px; }
  .num .inp { width: 92px; }
  .unit { font-size: .82em; opacity: .55; }
  .row-state { font-size: .8em; min-width: 62px; opacity: 0; transition: opacity .15s ease; }
  .row-state.show { opacity: 1; }
  .row-state.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .row-state.err { color: var(--vscode-errorForeground, #f85149); }

  /* ── переключатель ── */
  .switch { position: relative; width: 38px; height: 20px; padding: 0; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border, #3c3c3c); background: var(--vscode-input-background, #3a3a3a); transition: background .15s ease; }
  .switch .knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--vscode-foreground, #ccc); opacity: .75; transition: transform .15s ease, opacity .15s ease; }
  .switch.on { background: var(--vscode-button-background, #0e639c); border-color: transparent; }
  .switch.on .knob { transform: translateX(18px); background: var(--vscode-button-foreground, #fff); opacity: 1; }
  .switch:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }

  /* ── кнопки ── */
  .btn { font-family: inherit; font-size: .88em; padding: 5px 12px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #313131); color: var(--vscode-button-secondaryForeground, #ccc); }
  .btn:hover { filter: brightness(1.18); }
  .btn:disabled { opacity: .45; cursor: default; filter: none; }
  .btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font-weight: 600; }
  .btn.xs { font-size: .8em; padding: 3px 9px; }
  .btn.danger { color: var(--vscode-errorForeground, #f85149); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }

  /* ── карточки ключей ── */
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .card { border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 9px; padding: 11px 13px;
    background: var(--vscode-sideBar-background, rgba(127,127,127,.05)); }
  .card-h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .prov { font-weight: 600; }
  .star { font-size: .82em; color: var(--vscode-charts-yellow, #d7ba7d); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(252px, 1fr)); gap: 9px 14px; }
  .f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  /* подпись поля; .with-btn — обёртка «поле + кнопка», ей уменьшать шрифт нельзя */
  .f > span:not(.with-btn) { font-size: .78em; opacity: .62; }
  .f .inp { width: 100%; }
  .with-btn { display: flex; gap: 5px; align-items: center; min-width: 0; }
  .with-btn .inp { flex: 1 1 auto; width: auto; min-width: 0; }
  .with-btn .btn { flex: 0 0 auto; white-space: nowrap; }
  .card-f { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .muted { font-size: .8em; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
  .err-text { color: var(--vscode-errorForeground, #f85149); opacity: .85; }
  .pill { font-size: .76em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--vscode-panel-border, #3c3c3c); opacity: .85; }
  .pill.ok { color: var(--vscode-testing-iconPassed, #3fb950); border-color: currentColor; }
  .pill.warn { color: var(--vscode-charts-orange, #d18616); border-color: currentColor; }
  .empty { padding: 14px 16px; border-radius: 8px; border: 1px dashed var(--vscode-panel-border, #3c3c3c); opacity: .8; font-size: .9em; }

  /* ── форма добавления ── */
  details.add { margin-top: 16px; border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 9px; overflow: hidden; }
  details.add > summary { cursor: pointer; padding: 9px 13px; font-weight: 600; font-size: .92em; user-select: none; list-style: none; }
  details.add > summary::-webkit-details-marker { display: none; }
  details.add > summary::before { content: '＋ '; opacity: .6; }
  details.add[open] > summary::before { content: '－ '; }
  details.add > summary:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.08)); }
  .add-body { padding: 6px 13px 14px; border-top: 1px solid var(--vscode-panel-border, #2b2b2b); display: grid; grid-template-columns: repeat(auto-fit, minmax(232px, 1fr)); gap: 10px 14px; }
  .add-body .f .inp { width: 100%; }
  .add-actions { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
  .hint { font-size: .82em; opacity: .7; }
  .hint.ok { color: var(--vscode-testing-iconPassed, #3fb950); opacity: 1; }
  .hint.err { color: var(--vscode-errorForeground, #f85149); opacity: 1; }

  /* ── тост ── */
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translate(-50%, 14px); z-index: 60;
    max-width: 70vw; padding: 9px 15px; border-radius: 7px; font-size: .88em; opacity: 0; pointer-events: none;
    background: var(--vscode-notifications-background, #252526); color: var(--vscode-notifications-foreground, #ccc);
    border: 1px solid var(--vscode-panel-border, #3c3c3c); box-shadow: 0 6px 20px rgba(0,0,0,.35); transition: opacity .16s ease, transform .16s ease; }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.ok { border-color: var(--vscode-testing-iconPassed, #3fb950); }
  .toast.err { border-color: var(--vscode-errorForeground, #f85149); }
  .toast.warn { border-color: var(--vscode-charts-orange, #d18616); }

  @media (max-width: 720px) {
    .layout { flex-direction: column; gap: 12px; padding: 14px 16px 80px; }
    .nav { position: static; flex-direction: row; flex-wrap: wrap; flex: none; }
    .inp, .sel { width: 100%; }
    .row { flex-direction: column; gap: 8px; }
    .q { width: 150px; }
  }
</style>
</head>
<body data-scroll="${Number(lms.settingsScroll) || 0}" data-section="${escapeHtml(lms.settingsSection || '')}">
<div class="hdr">
  <div><span class="hdr-title">Настройки</span><span class="hdr-sub">Яндекс LMS${pkg.version ? ' · v' + escapeHtml(pkg.version) : ''}</span></div>
  <div class="hdr-r">
    <input id="q" class="q" type="search" placeholder="Поиск по настройкам" autocomplete="off">
    <button class="btn xs" data-act="action" data-name="settingsJson" title="Открыть settings.json">settings.json</button>
  </div>
</div>
<div class="layout">
  <nav class="nav">${nav}</nav>
  <main class="main">
    <section class="sec" id="sec-account">
      <h2>Аккаунт и LMS</h2>
      <p class="lead">Вход в LMS, папка с решениями и как показывать условие задачи.</p>
      ${sectionRows('account', conf)}
      <div class="actions">
        <button class="btn" data-act="action" data-name="login">Войти…</button>
        <button class="btn" data-act="action" data-name="logout">Выйти</button>
        <button class="btn" data-act="action" data-name="refresh">Обновить курсы</button>
      </div>
    </section>
    ${aiSection}
    <section class="sec" id="sec-lens">
      <h2>Google Объектив</h2>
      <p class="lead">Ctrl+Alt+G — снимок условия задания уходит в Google Объектив, результат открывается в браузере или карточкой в VS Code.</p>
      ${sectionRows('lens', conf)}
      ${lensCookieBlockHtml(lms)}
    </section>
    <section class="sec" id="sec-aiBehavior">
      <h2>ИИ: поведение</h2>
      <p class="lead">Подсказки в редакторе, проверка ответов модели и правила курса.</p>
      ${sectionRows('aiBehavior', conf)}
    </section>
    <section class="sec" id="sec-diag">
      <h2>Диагностика</h2>
      <p class="lead">Логи и служебные действия. Обычно не нужны.</p>
      ${sectionRows('diag', conf)}
      <div class="actions">
        <button class="btn" data-act="action" data-name="log">Показать лог</button>
        <button class="btn" data-act="action" data-name="diagnose">Диагностика API</button>
        <button class="btn" data-act="action" data-name="collect">Собрать отчёт</button>
        <button class="btn" data-act="action" data-name="repair">Починить панель условия</button>
        <button class="btn" data-act="action" data-name="forget">Забыть ошибки ИИ</button>
      </div>
    </section>
  </main>
</div>
<div class="toast" id="toast"></div>
<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const PROVIDERS = ${jsData(providersJson())};
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  // Состояние переживает перерисовку html: позиция прокрутки, раздел, открытая форма.
  function saveState(patch) {
    const st = Object.assign({}, vscode.getState() || {}, patch);
    vscode.setState(st);
    try { sessionStorage.setItem('lms-settings-scroll', String(st.scroll || 0)); } catch (e) { }
  }

  let toastTimer = null;
  function toast(text, kind) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'toast show ' + (kind || '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, kind === 'err' ? 6000 : 2800);
  }

  function markRow(key, ok, text) {
    const el = $('.row-state[data-for="' + key + '"]');
    if (!el) return;
    el.textContent = ok ? 'сохранено' : (text || 'ошибка');
    el.className = 'row-state show ' + (ok ? 'ok' : 'err');
    setTimeout(function () { el.className = 'row-state'; }, 2200);
  }

  // ── навигация и поиск ──
  function goto(section, scroll) {
    const sec = document.getElementById('sec-' + section);
    if (!sec) return;
    if (scroll !== false) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-section') === section); });
  }

  function activeFromScroll() {
    const y = window.scrollY + 90;
    let current = null;
    $$('.sec').forEach(function (s) { if (s.offsetTop <= y) current = s.id.replace('sec-', ''); });
    if (!current) current = 'account';
    $$('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-section') === current); });
  }

  function applySearch() {
    const q = String(($('#q') || {}).value || '').trim().toLowerCase();
    $$('[data-search]').forEach(function (el) {
      el.hidden = !!q && el.getAttribute('data-search').toLowerCase().indexOf(q) < 0;
    });
    $$('.sec').forEach(function (sec) {
      const items = $$('[data-search]', sec);
      sec.hidden = items.length > 0 && items.every(function (el) { return el.hidden; });
    });
  }

  // ── форма добавления провайдера ──
  function addForm() { return $('#add-provider'); }
  function npVal(id) { const el = $('#' + id); return el ? el.value : ''; }

  function syncProviderFields() {
    const prov = npVal('np-provider');
    const def = PROVIDERS[prov] || {};
    const baseUrl = $('#np-baseUrl') ? $('#np-baseUrl').closest('.f') : null;
    const bin = $('#np-bin') ? $('#np-bin').closest('.f') : null;
    const key = $('#np-key') ? $('#np-key').closest('.f') : null;
    const model = $('#np-model') ? $('#np-model').closest('.f') : null;
    if (baseUrl) baseUrl.hidden = !!def.cli;
    if (bin) bin.hidden = !def.cli;
    if (key) key.hidden = prov === 'opencode' || prov === 'cline';
    if (model) model.hidden = false;
    const b = $('#np-baseUrl');
    if (b && !def.cli) b.value = def.baseUrl || '';
    const bn = $('#np-bin');
    if (bn && def.cli) bn.value = def.bin || prov;
    const m = $('#np-model');
    if (m && def.model && !m.value) m.value = def.model;
    const hint = $('#np-hint');
    if (hint) { hint.textContent = ''; hint.className = 'hint'; }
  }

  function collectNew() {
    const prov = npVal('np-provider');
    const def = PROVIDERS[prov] || {};
    const entry = {
      provider: prov,
      label: def.label || prov,
      baseUrl: String(npVal('np-baseUrl') || '').trim().replace(/\\/+$/, ''),
      model: String(npVal('np-model') || '').trim(),
      apiKey: String(npVal('np-key') || '').trim(),
      bin: String(npVal('np-bin') || '').trim()
    };
    if (def.cli) entry.baseUrl = '';
    else entry.bin = '';
    return entry;
  }

  function newHint(text, kind) {
    const el = $('#np-hint');
    if (!el) return;
    el.textContent = text;
    el.className = 'hint ' + (kind || '');
  }

  // ── события ──
  document.addEventListener('change', function (ev) {
    const el = ev.target;
    if (!el || !el.matches) return;
    if (el.id === 'np-provider') { syncProviderFields(); saveState({ addProvider: el.value }); return; }
    if (el.matches('[data-key]')) {
      const type = el.getAttribute('data-type');
      let value = el.value;
      if (type === 'number') value = Number(el.value);
      vscode.postMessage({ type: 'update', key: el.getAttribute('data-key'), value: value });
      return;
    }
    if (el.matches('[data-pool]')) {
      const card = el.closest('.card');
      if (!card) return;
      const field = el.getAttribute('data-pool');
      // Пустой ключ = «не менять»: не гоняем в расширение пустое значение.
      if (field === 'apiKey' && !String(el.value).trim()) return;
      vscode.postMessage({
        type: 'poolUpdate',
        id: card.getAttribute('data-id'),
        field: field,
        value: el.value
      });
    }
  });

  document.addEventListener('click', function (ev) {
    const target = ev.target;
    if (!target || !target.closest) return;

    const sw = target.closest('.switch');
    if (sw) {
      const on = !sw.classList.contains('on');
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.title = on ? 'Выключить' : 'Включить';
      vscode.postMessage({ type: 'update', key: sw.getAttribute('data-key'), value: on });
      return;
    }

    const el = target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    const card = el.closest('.card');
    const id = card ? card.getAttribute('data-id') : null;

    if (act === 'goto') {
      vscode.postMessage({ type: 'section', name: el.getAttribute('data-section') });
      return goto(el.getAttribute('data-section'));
    }
    if (act === 'poolPrimary') return vscode.postMessage({ type: 'poolPrimary', id: id });
    if (act === 'poolTest') return vscode.postMessage({ type: 'poolTest', id: id });
    if (act === 'poolDelete') return vscode.postMessage({ type: 'poolDelete', id: id });
    if (act === 'poolModels') return vscode.postMessage({ type: 'models', id: id });
    if (act === 'revealKey') {
      const inp = card ? card.querySelector('[data-pool="apiKey"]') : null;
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
      return;
    }
    if (act === 'testAll') return vscode.postMessage({ type: 'testAll' });
    if (act === 'resetLimits') return vscode.postMessage({ type: 'resetLimits' });
    if (act === 'toggleAdd') {
      const d = addForm();
      if (!d) return;
      d.open = !d.open;
      saveState({ addOpen: d.open });
      if (d.open) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    if (act === 'np-models') {
      const e = collectNew();
      vscode.postMessage({ type: 'models', target: 'new', provider: e.provider, baseUrl: e.baseUrl, apiKey: e.apiKey, bin: e.bin });
      return;
    }
    if (act === 'np-check') {
      const e = collectNew();
      newHint('Проверяю…');
      vscode.postMessage({ type: 'check', provider: e.provider, baseUrl: e.baseUrl, apiKey: e.apiKey, bin: e.bin });
      return;
    }
    if (act === 'np-add') {
      const e = collectNew();
      if (!e.model) return newHint('Укажите модель', 'err');
      if (!PROVIDERS[e.provider].cli && !e.apiKey && e.provider !== 'ollama') return newHint('Нужен API-ключ', 'err');
      if (!PROVIDERS[e.provider].cli && !e.baseUrl) return newHint('Нужен базовый URL', 'err');
      newHint('Добавляю…');
      vscode.postMessage({ type: 'poolAdd', entry: e });
      return;
    }
    // ── Объектив: куки Google ──
    if (act === 'lensSave') {
      const ta = document.getElementById('lens-cookies');
      const v = ta ? String(ta.value || '').trim() : '';
      if (!v) return toast('Вставьте строку Cookie из браузера', 'warn');
      if (ta) ta.value = '';
      vscode.postMessage({ type: 'lensCookies', value: v });
      return;
    }
    if (act === 'lensWarm') return vscode.postMessage({ type: 'lensWarm' });
    if (act === 'lensClear') return vscode.postMessage({ type: 'lensClear' });
    if (act === 'lensTest') return vscode.postMessage({ type: 'lensTest' });
    if (act === 'action') return vscode.postMessage({ type: 'action', name: el.getAttribute('data-name') });
  });

  // ── сообщения от расширения ──
  window.addEventListener('message', function (ev) {
    const m = ev.data || {};
    if (m.type === 'toast') return toast(m.text, m.kind);
    if (m.type === 'saved') {
      // Значение могло измениться на стороне расширения (обрезка пробелов,
      // ограничение диапазона) — показываем то, что реально сохранилось.
      const inp = document.querySelector('[data-key="' + m.key + '"]');
      if (inp && m.ok !== false && m.value !== undefined && String(inp.value) !== String(m.value)) inp.value = m.value;
      return markRow(m.key, m.ok !== false, m.error);
    }
    if (m.type === 'goto') return goto(m.section);
    if (m.type === 'hint') return newHint(m.text, m.kind);
    if (m.type === 'models') {
      const list = Array.isArray(m.list) ? m.list : [];
      const target = m.id ? document.getElementById('models-' + m.id) : document.getElementById('np-models');
      if (target) {
        target.innerHTML = '';
        list.forEach(function (name) {
          const opt = document.createElement('option');
          opt.value = name;
          target.appendChild(opt);
        });
      }
      if (m.target === 'new') {
        newHint(list.length ? 'Моделей: ' + list.length + ' — начните вводить название' : 'Список моделей не пришёл, введите вручную', list.length ? 'ok' : '');
      } else {
        toast(list.length ? 'Моделей: ' + list.length : 'Список моделей не пришёл', list.length ? 'ok' : 'warn');
      }
      return;
    }
    if (m.type === 'prefill') {
      const d = addForm();
      const sel = $('#np-provider');
      if (d) d.open = true;
      if (sel && m.provider && PROVIDERS[m.provider]) { sel.value = m.provider; syncProviderFields(); }
      if (d) d.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  });

  // ── восстановление состояния ──
  // Позицию прокрутки и раздел хранит расширение (data-атрибуты body): полная
  // перерисовка html не должна возвращать пользователя в начало страницы.
  const st = vscode.getState() || {};
  const fromBody = Number(document.body.getAttribute('data-scroll') || 0);
  let scroll = fromBody || Number(st.scroll || 0);
  if (!scroll) {
    try { scroll = Number(sessionStorage.getItem('lms-settings-scroll') || 0); } catch (e) { }
  }
  if (st.addOpen) {
    const d = addForm();
    if (d) d.open = true;
    if (st.addProvider) {
      const sel = $('#np-provider');
      if (sel) { sel.value = st.addProvider; }
    }
  }
  const bodySection = document.body.getAttribute('data-section');
  if (bodySection) goto(bodySection, false);
  else if (st.section) goto(st.section, false);
  window.requestAnimationFrame(function () { if (scroll) window.scrollTo(0, scroll); });

  const q = $('#q');
  if (q) q.addEventListener('input', applySearch);

  let scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      saveState({ scroll: window.scrollY });
      vscode.postMessage({ type: 'scroll', y: window.scrollY });
      activeFromScroll();
    }, 180);
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

// Форма добавления провайдера. Поля показываются/скрываются по типу провайдера.
function addFormHtml() {
  const opts = Object.keys(AI_PROVIDERS)
    .filter(k => k !== 'none')
    .map(k => '<option value="' + k + '">' + escapeHtml(AI_PROVIDERS[k].label) + '</option>')
    .join('');
  return '<details class="add" id="add-provider">' +
    '<summary>Добавить провайдера или ключ</summary>' +
    '<div class="add-body">' +
    '<label class="f"><span>Провайдер</span><select class="inp sel" id="np-provider">' + opts + '</select></label>' +
    '<label class="f"><span>Базовый URL</span><input class="inp" id="np-baseUrl" spellcheck="false" placeholder="https://openrouter.ai/api/v1"></label>' +
    '<label class="f" hidden><span>Команда / путь к CLI</span><input class="inp" id="np-bin" spellcheck="false" placeholder="opencode"></label>' +
    '<label class="f"><span>API-ключ</span><input class="inp" type="password" id="np-key" autocomplete="off" spellcheck="false"></label>' +
    '<label class="f"><span>Модель</span><input class="inp" id="np-model" list="np-models" spellcheck="false"></label>' +
    '<datalist id="np-models"></datalist>' +
    '<div class="add-actions">' +
    '<button class="btn primary" data-act="np-add">Добавить и проверить</button>' +
    '<button class="btn" data-act="np-models">Список моделей</button>' +
    '<button class="btn" data-act="np-check">Проверить подключение</button>' +
    '<span class="hint" id="np-hint"></span>' +
    '</div></div></details>';
}

// ── запись настроек ──

async function applyUpdate(key, raw) {
  const f = FIELD_BY_KEY.get(key);
  if (!f) throw new Error('Неизвестная настройка: ' + key);
  let value = raw;
  if (f.type === 'bool') {
    value = raw === true || raw === 'true';
  } else if (f.type === 'number') {
    if (raw === '' || raw === null || raw === undefined) throw new Error('Укажите число');
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new Error('Нужно число');
    value = num;
    if (f.min !== undefined && value < f.min) value = f.min;
    if (f.max !== undefined && value > f.max) value = f.max;
  } else if (f.type === 'enum') {
    const ok = (f.options || []).some(o => o.value === String(raw));
    if (!ok) throw new Error('Недопустимое значение');
    value = String(raw);
  } else if (key === 'ai.courseRules') {
    value = String(raw == null ? '' : raw);
  } else {
    value = String(raw == null ? '' : raw).trim();
    if (key === 'apiBase') {
      value = value.replace(/\/+$/, '');
      if (!value) throw new Error('Адрес LMS не может быть пустым');
    }
    if (!value && (key === 'pythonPath' || key === 'folderName')) {
      throw new Error('Поле не может быть пустым');
    }
  }
  await cfg().update(key, value, vscode.ConfigurationTarget.Global);
  return value;
}

function render(lms) {
  const panel = lms.settingsPanel;
  if (!panel) return;
  try {
    panel.webview.html = settingsHtml(lms);
  } catch (e) {
    lms.output().appendLine('Настройки: не удалось перерисовать — ' + (e.message || e));
  }
}

function post(panel, msg) {
  if (!panel) return;
  try { panel.webview.postMessage(msg); } catch (e) { }
}

function findEntry(id) {
  return pool.aiEntries().find(e => e.id === id);
}

async function handlePoolUpdate(lms, panel, msg) {
  const e = findEntry(msg.id);
  if (!e) throw new Error('Ключ не найден — обновите панель');
  const field = String(msg.field || '');
  const raw = msg.value == null ? '' : String(msg.value);
  const next = Object.assign({}, e);

  if (field === 'label') {
    next.label = raw.trim() || providerDef(e.provider).label;
  } else if (field === 'model') {
    const model = raw.trim();
    if (!model) throw new Error('Модель не может быть пустой');
    next.model = model;
  } else if (field === 'baseUrl') {
    const url = raw.trim().replace(/\/+$/, '');
    if (!url) throw new Error('Базовый URL не может быть пустым');
    next.baseUrl = url;
  } else if (field === 'bin') {
    next.bin = raw.trim() || e.provider;
  } else if (field === 'agent') {
    if (raw.trim()) next.agent = raw.trim();
    else delete next.agent;
  } else if (field === 'apiKey') {
    const key = raw.trim();
    if (!key) return; // пустое поле — «не менять»
    next.apiKey = key;
  } else {
    return;
  }

  pool.poolReplace(e.id, next);
  // Модель/ключ/адрес поменялись — старые замеры и кулдаун больше не актуальны.
  if (field !== 'label' && field !== 'agent') pool.poolClearState(e.id);
  // Перерисовываем только при смене ключа: маску в поле иначе не обновить, а
  // обычная правка не должна сбивать фокус и прокрутку посреди заполнения.
  if (field === 'apiKey') render(lms);
}

async function handleAdd(lms, panel, entry) {
  const provider = String(entry && entry.provider || '');
  const def = providerDef(provider);
  if (!provider || provider === 'none') throw new Error('Выберите провайдера');
  const isCli = provider === 'opencode' || provider === 'cline';
  const draft = {
    provider,
    label: def.label.replace(/\s*\(.*\)\s*$/, ''),
    apiKey: '',
    model: String(entry.model || '').trim()
  };
  if (!draft.model) throw new Error('Укажите модель');
  if (isCli) {
    draft.bin = String(entry.bin || '').trim() || String(cfg().get(provider === 'opencode' ? 'ai.opencodeBin' : 'ai.clineBin') || provider);
    draft.baseUrl = '';
  } else {
    draft.baseUrl = String(entry.baseUrl || '').trim().replace(/\/+$/, '');
    draft.apiKey = String(entry.apiKey || '').trim();
    if (!draft.baseUrl) throw new Error('Укажите базовый URL');
    if (!draft.apiKey && provider !== 'ollama') throw new Error('Укажите API-ключ');
  }

  pool.poolAdd(draft);
  const added = pool.aiEntries().find(x => x.provider === provider && x.model === draft.model && (x.baseUrl || '') === (draft.baseUrl || '') && (x.bin || '') === (draft.bin || ''));
  post(panel, { type: 'hint', text: 'Ключ добавлен, проверяю…' });
  render(lms);
  if (!added) return;
  const ok = await lms.aiTestEntry(added, { silent: true });
  const st = pool.stateOf(added) || {};
  post(panel, {
    type: 'toast',
    kind: ok ? 'ok' : 'err',
    text: ok
      ? 'Готово: ' + pool.aiEntryLabel(added) + ' работает' + (st.ms ? ' (' + (st.ms / 1000).toFixed(1) + ' с)' : '')
      : 'Добавлено, но не отвечает: ' + (st.lastError || 'ошибка подключения')
  });
  render(lms);
}

async function handleModels(lms, panel, msg) {
  const list = [];
  if (msg.id) {
    const e = findEntry(msg.id);
    if (!e) return;
    post(panel, { type: 'toast', text: 'Загружаю модели…' });
    const models = await aiListModels(e);
    post(panel, { type: 'models', id: e.id, list: models });
    return;
  }
  // Модели для ещё не добавленного провайдера.
  const provider = String(msg.provider || '');
  const draft = {
    provider,
    baseUrl: String(msg.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(msg.apiKey || '').trim(),
    bin: String(msg.bin || '').trim() || provider
  };
  if (!provider) return;
  try {
    const models = await aiListModels(draft);
    post(panel, { type: 'models', target: 'new', list: models });
  } catch (e) {
    post(panel, { type: 'models', target: 'new', list: [] });
  }
}

async function handleCheck(lms, panel, msg) {
  const provider = String(msg.provider || '');
  try {
    if (provider === 'opencode' || provider === 'cline') {
      const bin = String(msg.bin || '').trim() || provider;
      const resolved = provider === 'opencode' ? resolveOpenCodeBin(bin) : resolveClineBin(bin);
      const ver = await (provider === 'opencode' ? openCodeVersion(resolved) : clineVersion(resolved));
      if (ver) post(panel, { type: 'hint', text: provider + ' найден: ' + ver + ' — ' + resolved, kind: 'ok' });
      else post(panel, { type: 'hint', text: provider + ' не найден (' + resolved + '). Установите его или укажите путь.', kind: 'err' });
      return;
    }
    const models = await aiListModels({
      provider,
      baseUrl: String(msg.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(msg.apiKey || '').trim()
    });
    if (models.length) post(panel, { type: 'hint', text: 'Сервер ответил, моделей: ' + models.length, kind: 'ok' });
    else post(panel, { type: 'hint', text: 'Список моделей пуст — проверьте адрес и ключ', kind: 'err' });
  } catch (e) {
    post(panel, { type: 'hint', text: String(e.message || e), kind: 'err' });
  }
}

async function runAction(lms, panel, name) {
  const map = {
    login: 'yandexLms.loginMenu',
    logout: 'yandexLms.logout',
    refresh: 'yandexLms.refresh',
    log: 'yandexLms.showLog',
    diagnose: 'yandexLms.diagnose',
    collect: 'yandexLms.collect',
    repair: 'yandexLms.fixWebview',
    forget: 'yandexLms.aiForget',
    settingsJson: 'workbench.action.openSettings'
  };
  if (name === 'settingsJson') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'yandexLms');
    return;
  }
  if (name === 'lensOpen') {
    await lms.lensOpenSite();
    return;
  }
  const cmd = map[name];
  if (!cmd) return;
  await vscode.commands.executeCommand(cmd);
  if (name === 'logout') render(lms);
}

function attachSettingsPanel(panel, lms) {
  panel.webview.onDidReceiveMessage(async msg => {
    const type = msg && msg.type;
    if (!type || type === 'ready') return;
    try {
      if (type === 'update') {
        try {
          const value = await applyUpdate(msg.key, msg.value);
          post(panel, { type: 'saved', key: msg.key, ok: true, value: value });
        } catch (e) {
          post(panel, { type: 'saved', key: msg.key, ok: false, error: String(e.message || e) });
        }
        return;
      }
      // Позиция прокрутки живёт в расширении: перерисовка html не должна
      // отбрасывать пользователя в начало страницы.
      if (type === 'scroll') {
        lms.settingsScroll = Number(msg.y) || 0;
        return;
      }
      if (type === 'section') {
        lms.settingsSection = String(msg.name || '');
        return;
      }
      if (type === 'poolUpdate') return await handlePoolUpdate(lms, panel, msg);
      if (type === 'poolAdd') return await handleAdd(lms, panel, msg.entry || {});
      if (type === 'poolPrimary') {
        pool.poolSetPrimary(msg.id);
        render(lms);
        return;
      }
      if (type === 'poolDelete') {
        const e = findEntry(msg.id);
        if (!e) return;
        const ok = await vscode.window.showWarningMessage('Удалить «' + pool.aiEntryLabel(e) + '»?', { modal: true }, 'Удалить');
        if (ok !== 'Удалить') return;
        pool.poolRemove(msg.id);
        render(lms);
        post(panel, { type: 'toast', text: 'Ключ удалён' });
        return;
      }
      if (type === 'poolTest') {
        const e = findEntry(msg.id);
        if (!e) return;
        post(panel, { type: 'toast', text: 'Проверяю ' + pool.aiEntryLabel(e) + '…' });
        const ok = await lms.aiTestEntry(e, { silent: true });
        const st = pool.stateOf(e) || {};
        post(panel, {
          type: 'toast',
          kind: ok ? 'ok' : 'err',
          text: ok
            ? 'Работает: ' + pool.aiEntryLabel(e) + (st.ms ? ' · ' + (st.ms / 1000).toFixed(1) + ' с' : '')
            : 'Не работает: ' + (st.lastError || 'нет ответа')
        });
        render(lms);
        return;
      }
      if (type === 'testAll') {
        const list = pool.aiEntries();
        if (!list.length) return;
        let okCount = 0;
        for (const e of list) {
          post(panel, { type: 'toast', text: 'Проверяю ' + pool.aiEntryLabel(e) + '…' });
          if (await lms.aiTestEntry(e, { silent: true })) okCount++;
        }
        post(panel, {
          type: 'toast',
          kind: okCount === list.length ? 'ok' : 'warn',
          text: 'Работает ' + okCount + ' из ' + list.length
        });
        render(lms);
        return;
      }
      if (type === 'resetLimits') {
        pool.aiResetStates();
        render(lms);
        post(panel, { type: 'toast', kind: 'ok', text: 'Лимиты сброшены — все ключи снова доступны' });
        return;
      }
      if (type === 'models') return await handleModels(lms, panel, msg);
      if (type === 'check') return await handleCheck(lms, panel, msg);
      if (type === 'lensCookies') {
        try {
          const st = await lms.lensSaveCookies(msg.value);
          post(panel, { type: 'toast', kind: 'ok', text: 'Куки сохранены: ' + st.count + ' шт' });
        } catch (e) {
          post(panel, { type: 'toast', kind: 'err', text: String(e.message || e) });
        }
        render(lms);
        return;
      }
      if (type === 'lensWarm') {
        post(panel, { type: 'toast', text: 'Забираю куки Google…' });
        try {
          const st = await lms.lensWarmUp();
          post(panel, {
            type: 'toast',
            kind: st.count ? 'ok' : 'warn',
            text: st.count ? 'Куки обновлены: ' + st.count + ' шт' : 'Google не отдал куки — проверьте сеть или VPN'
          });
        } catch (e) {
          post(panel, { type: 'toast', kind: 'err', text: String(e.message || e) });
        }
        render(lms);
        return;
      }
      if (type === 'lensClear') {
        await lms.lensClearCookies();
        render(lms);
        post(panel, { type: 'toast', text: 'Куки Google удалены' });
        return;
      }
      if (type === 'lensTest') {
        post(panel, { type: 'toast', text: 'Стучусь в Google…' });
        try {
          const r = await lms.lensProbe();
          const text = r.bot
            ? 'Google просит проверку на робота — вставьте куки из браузера'
            : 'Google ответил ' + r.status + (r.cookies ? ', кук получено: ' + r.cookies : '') + ' — Объектив доступен';
          post(panel, { type: 'toast', kind: r.bot ? 'warn' : 'ok', text: text });
        } catch (e) {
          post(panel, { type: 'toast', kind: 'err', text: 'Google недоступен: ' + String(e.message || e) });
        }
        render(lms);
        return;
      }
      if (type === 'action') return await runAction(lms, panel, msg.name);
    } catch (e) {
      lms.output().appendLine('Настройки (' + type + '): ' + (e.message || e));
      post(panel, { type: 'toast', kind: 'err', text: String(e.message || e) });
    }
  });
}

function attach(Lms) {
  // Открыть настройки: section — раздел, opts.provider — сразу раскрыть форму
  // добавления с нужным провайдером (для команд «подключить OpenCode/Cline»).
  Lms.prototype.openSettings = function (section, opts) {
    const options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      disableServiceWorker: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    if (this.settingsPanel) {
      this.settingsPanel.reveal(vscode.ViewColumn.Active);
      if (section) {
        this.settingsSection = section;
        this.settingsPanel.webview.postMessage({ type: 'goto', section: section });
      }
      if (opts && opts.provider) this.settingsPanel.webview.postMessage({ type: 'prefill', provider: opts.provider });
      return this.settingsPanel;
    }
    if (section) this.settingsSection = section;
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Настройки — Яндекс LMS', vscode.ViewColumn.Active, options);
    this.settingsPanel = panel;
    attachSettingsPanel(panel, this);
    panel.onDidDispose(() => {
      if (this.settingsPanel === panel) this.settingsPanel = null;
    });
    panel.webview.html = settingsHtml(this);
    if (section) setTimeout(() => post(panel, { type: 'goto', section: section }), 120);
    if (opts && opts.provider) setTimeout(() => post(panel, { type: 'prefill', provider: opts.provider }), 160);
    return panel;
  };
}

module.exports = { attach, settingsHtml, applyUpdate, VIEW_TYPE, SECTIONS, FIELDS };
