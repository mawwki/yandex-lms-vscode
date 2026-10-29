// Google Объектив: снимок условия задания уходит в Google Lens, результат
// открывается в браузере (по умолчанию) или карточкой в VS Code.
//
// Загрузка — обычный multipart POST на lens.google.com/v3/upload (поле
// encoded_image), в ответ Google отдаёт 303 и Location на страницу результатов.
// Куки Google лежат в SecretStorage: без них Google чаще включает проверку
// «я не робот». Снять куки из браузера автоматически нельзя — Chrome и Edge
// шифруют их ключом, привязанным к процессу браузера, — поэтому в настройках
// есть кнопка «Обновить автоматически» (гостевые куки Google) и поле для
// строки Cookie из DevTools (куки своего аккаунта).
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { cfg, debugEnabled } = require('./cfg');
const { diagDir } = require('./diag');
const { escapeHtml, sleep } = require('./util');

const SECRET_COOKIES = 'yandexLms.lensCookies';
const LENS_PANEL = 'yandexLmsLens';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LENS_HOME = 'https://lens.google.com/';
// Первая ручка — актуальная, вторая — старая (на случай смены схемы у Google).
const UPLOAD_URLS = [
  'https://lens.google.com/v3/upload?stcs=',
  'https://lens.google.com/upload?ep=ccm&s=&st='
];
const TIMEOUT_MS = 25000;

// ── куки google.com ─────────────────────────────────────────────────────────

// Строка Cookie из DevTools → список кук. Принимает и «Cookie: a=1; b=2»,
// и просто «a=1; b=2» (в том числе с переводами строк после копирования).
function parseCookieHeader(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return [];
  s = s.replace(/^cookie\s*:/i, '').replace(/[\r\n]+/g, '; ');
  const out = [];
  for (const part of s.split(';')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!name || /\s/.test(name)) continue;
    if (out.some(c => c.name === name)) continue;
    out.push({ name, value, domain: 'google.com', path: '/', expires: 0 });
  }
  return out;
}

// Одна строка Set-Cookie → кука. Домен нормализуем до google.com: иначе кука,
// поставленная на www.google.com, не уйдёт на lens.google.com.
function cookieFromSetCookie(raw, host) {
  const parts = String(raw || '').split(';');
  const nv = parts[0] || '';
  const eq = nv.indexOf('=');
  if (eq <= 0) return null;
  const c = {
    name: nv.slice(0, eq).trim(),
    value: nv.slice(eq + 1).trim(),
    domain: String(host || '').toLowerCase(),
    path: '/',
    expires: 0
  };
  if (!c.name) return null;
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i];
    const k = a.indexOf('=');
    const key = (k < 0 ? a : a.slice(0, k)).trim().toLowerCase();
    const val = k < 0 ? '' : a.slice(k + 1).trim();
    if (key === 'domain') c.domain = val.replace(/^\./, '').toLowerCase();
    else if (key === 'path') c.path = val || '/';
    else if (key === 'max-age') c.expires = Date.now() + parseInt(val, 10) * 1000;
    else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) c.expires = t;
    }
  }
  if (c.domain === 'google.com' || c.domain.endsWith('.google.com')) c.domain = 'google.com';
  return c;
}

// Слияние: одноимённые куки заменяются, просроченные выбрасываются.
function mergeCookies(list, add) {
  const now = Date.now();
  const out = (list || []).filter(c => c && c.name && (!c.expires || c.expires > now));
  for (const c of add || []) {
    if (!c || !c.name) continue;
    if (c.expires && c.expires <= now) continue;
    const i = out.findIndex(x => x.name === c.name && x.domain === c.domain && x.path === c.path);
    if (i >= 0) out[i] = c;
    else out.push(c);
  }
  return out;
}

function cookiesFor(cookies, host) {
  const h = String(host || '').toLowerCase();
  return (cookies || []).filter(c => h === c.domain || h.endsWith('.' + c.domain));
}

function cookieHeaderFor(cookies, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return ''; }
  return cookiesFor(cookies, host).map(c => c.name + '=' + c.value).join('; ');
}

// Google вместо результатов отдал проверку на робота / согласие.
function isBotPage(html) {
  const s = String(html || '');
  if (!s) return false;
  return /unusual traffic|not a robot|recaptcha|\/sorry\/|наш[аи]?\s+систем|проверк[аи]\s+на\s+робот/i.test(s);
}

function absoluteUrl(location) {
  if (!location) return null;
  try { return new URL(String(location), 'https://lens.google.com').toString(); } catch (e) { return null; }
}

// Тело multipart-запроса на загрузку (отдельно — чтобы покрыть тестом).
function uploadBody(png, width, height, query) {
  const boundary = '----LensBoundary' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="encoded_image"; filename="lens.png"\r\n' +
    'Content-Type: image/png\r\n\r\n'
  );
  const dims = Buffer.from(
    '\r\n--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="processed_image_dimensions"\r\n\r\n' +
    Math.max(1, Math.round(width || 1)) + ',' + Math.max(1, Math.round(height || 1)) + '\r\n'
  );
  // q переключает выдачу с пустого AI Mode (udm=26) на страницу Объектива
  // (udm=24), где снимок и запрос обрабатываются вместе.
  const q = String(query || '').trim();
  const qPart = q
    ? Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="q"\r\n\r\n' + q + '\r\n'
    )
    : Buffer.alloc(0);
  const tail = Buffer.from('--' + boundary + '--\r\n');
  return { boundary, body: Buffer.concat([head, png, dims, qPart, tail]) };
}

// Страница-загрузчик для браузера. Загрузка идёт обычной HTML-формой из
// браузера пользователя: тогда Google получает снимок в той же сессии, что и
// страница результатов, и не показывает битую картинку из чужой сессии.
function lensUploadHtml(pngBase64, width, height, stcs, query) {
  const b64 = String(pngBase64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  // Без q Google открывает AI Mode на www.google.com с пустым «Дополните
  // запрос» и не показывает снимок. С q тот же upload отдаёт udm=24 —
  // обычную страницу Объектива, где картинка и текст идут вместе.
  const q = String(query || '').trim();
  const action = 'https://lens.google.com/v3/upload?stcs=' + encodeURIComponent(String(stcs || Date.now()));
  return '<!DOCTYPE html>\n' +
    '<html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Google Объектив — отправка снимка</title>' +
    '<style>' +
    'html,body{margin:0;padding:0;background:#202124;color:#e8eaed;font:16px/1.5 system-ui,Segoe UI,Arial,sans-serif}' +
    'main{max-width:760px;margin:0 auto;padding:32px 20px}' +
    'h1{font-size:22px;font-weight:500;margin:0 0 10px}' +
    'p{color:#bdc1c6;margin:0 0 16px}' +
    'img{display:block;max-width:100%;height:auto;border:1px solid #5f6368;border-radius:8px;background:#fff}' +
    'form{display:none;margin-top:20px;padding:16px;border:1px solid #5f6368;border-radius:8px}' +
    'button{padding:8px 16px;border:0;border-radius:6px;background:#8ab4f8;color:#202124;font-weight:600;cursor:pointer}' +
    'input[type=file]{display:block;margin:0 0 12px;color:#e8eaed}' +
    '</style></head><body><main>' +
    '<h1>Google Объектив</h1>' +
    '<p id="lens-msg">Отправляю снимок задания в Google…</p>' +
    '<p id="lens-err" hidden></p>' +
    '<img id="lens-preview" alt="Снимок задания">' +
    '<form id="lens-form" method="post" action="' + escapeHtml(action) + '" enctype="multipart/form-data">' +
    '<input id="lens-file" type="file" name="encoded_image" accept="image/png">' +
    '<input type="hidden" name="processed_image_dimensions" value="' + w + ',' + h + '">' +
    (q ? '<input type="hidden" name="q" value="' + escapeHtml(q) + '">' : '') +
    '<button type="submit">Отправить в Google</button>' +
    '</form>' +
    '<script>(function(){' +
    'var b64="' + b64 + '";' +
    'var msg=document.getElementById("lens-msg");' +
    'try{' +
    'var bin=atob(b64),bytes=new Uint8Array(bin.length);' +
    'for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);' +
    'var file=new File([bytes],"lens.png",{type:"image/png"});' +
    'var dt=new DataTransfer();dt.items.add(file);' +
    'document.getElementById("lens-file").files=dt.files;' +
    'document.getElementById("lens-preview").src="data:image/png;base64,"+b64;' +
    'setTimeout(function(){document.getElementById("lens-form").submit();},300);' +
    '}catch(e){' +
    'msg.textContent="Не удалось отправить автоматически.";' +
    'var err=document.getElementById("lens-err");err.hidden=false;err.textContent=String(e&&e.message||e);' +
    'document.getElementById("lens-form").style.display="block";' +
    '}' +
    '})();</script>' +
    '</main></body></html>';
}

async function fetchTimed(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, ms || TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// ── клиент Объектива ────────────────────────────────────────────────────────

class Lens {
  constructor(lms) {
    this.lms = lms;
    this.cookies = [];
    this.at = 0;
    this.source = '';
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = await this.lms.context.secrets.get(SECRET_COOKIES);
      if (raw) {
        const data = JSON.parse(raw);
        this.cookies = mergeCookies(Array.isArray(data.cookies) ? data.cookies : [], []);
        this.at = Number(data.at) || 0;
        this.source = String(data.source || '');
      }
    } catch (e) { }
    return this;
  }

  async save() {
    const payload = JSON.stringify({ cookies: this.cookies, at: this.at, source: this.source });
    try {
      if (!this.cookies.length) await this.lms.context.secrets.delete(SECRET_COOKIES);
      else await this.lms.context.secrets.store(SECRET_COOKIES, payload);
    } catch (e) { }
  }

  absorb(url, res) {
    let list = [];
    if (res && res.headers && typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { host = 'google.com'; }
    const add = [];
    for (const raw of list) {
      const c = cookieFromSetCookie(raw, host);
      if (c) add.push(c);
    }
    if (add.length) this.cookies = mergeCookies(this.cookies, add);
    return add.length;
  }

  header(url) {
    return cookieHeaderFor(this.cookies, url);
  }

  status() {
    const alive = mergeCookies(this.cookies, []);
    return {
      count: alive.length,
      at: this.at,
      source: this.source,
      names: alive.map(c => c.name).slice(0, 6)
    };
  }

  // Гостевые куки Google: обычный заход на google.com и lens.google.com.
  async warmUp() {
    const targets = ['https://www.google.com/ncr', LENS_HOME];
    let added = 0;
    for (const url of targets) {
      try {
        const res = await fetchTimed(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': UA,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8'
          }
        });
        added += this.absorb(url, res);
        // Тело не нужно, но без чтения соединение может висеть.
        try { await res.text(); } catch (e) { }
      } catch (e) { }
    }
    if (added) {
      this.at = Date.now();
      this.source = 'auto';
      await this.save();
    }
    return this.status();
  }

  async importText(text) {
    const parsed = parseCookieHeader(text);
    if (!parsed.length) throw new Error('В строке нет кук вида «имя=значение»');
    this.cookies = mergeCookies(this.cookies, parsed);
    this.at = Date.now();
    this.source = 'browser';
    await this.save();
    return this.status();
  }

  async clear() {
    this.cookies = [];
    this.at = 0;
    this.source = '';
    await this.save();
    return this.status();
  }

  // Проверка связи: обычный заход на lens.google.com с текущими куками.
  async probe() {
    const headers = {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8'
    };
    const cookie = this.header(LENS_HOME);
    if (cookie) headers.cookie = cookie;
    const res = await fetchTimed(LENS_HOME, { method: 'GET', headers, redirect: 'manual' });
    const got = this.absorb(LENS_HOME, res);
    if (got) { this.at = Date.now(); if (!this.source) this.source = 'auto'; await this.save(); }
    let html = '';
    try { html = await res.text(); } catch (e) { }
    return {
      status: res.status,
      location: res.headers.get('location') || '',
      bot: isBotPage(html),
      cookies: got,
      total: this.status().count
    };
  }

  // Загрузка снимка. Возвращает ссылку на страницу результатов.
  async upload(png, width, height, query) {
    if (!png || !png.length) throw new Error('Пустой снимок');
    const errors = [];
    for (const base of UPLOAD_URLS) {
      const url = base + Date.now();
      const { boundary, body } = uploadBody(png, width, height, query);
      const headers = {
        'content-type': 'multipart/form-data; boundary=' + boundary,
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'origin': 'https://lens.google.com',
        'referer': LENS_HOME
      };
      const cookie = this.header(url);
      if (cookie) headers.cookie = cookie;
      let res;
      try {
        res = await fetchTimed(url, { method: 'POST', headers, body, redirect: 'manual' });
      } catch (e) {
        errors.push('сеть недоступна (' + String((e && e.message) || e).slice(0, 80) + ')');
        continue;
      }
      const got = this.absorb(url, res);
      const loc = absoluteUrl(res.headers.get('location'));
      if (loc && res.status >= 300 && res.status < 400) {
        if (got) { this.at = Date.now(); if (!this.source) this.source = 'auto'; await this.save(); }
        return { url: loc, status: res.status, cookies: got };
      }
      let html = '';
      try { html = await res.text(); } catch (e) { }
      errors.push('HTTP ' + res.status + (isBotPage(html) ? ' — проверка на робота' : ''));
    }
    throw new Error('Google не принял снимок: ' + (errors.join('; ') || 'нет ответа'));
  }
}

// ── команды и панель ────────────────────────────────────────────────────────

function lensOf(lms) {
  if (!lms.lens) lms.lens = new Lens(lms);
  return lms.lens;
}

function attach(Lms) {
  Lms.prototype.lensInit = async function () {
    const lens = lensOf(this);
    await lens.load();
    return lens;
  };

  Lms.prototype.lensStatus = function () {
    const lens = lensOf(this);
    return lens.status();
  };

  // Снимок условия из webview панели: webview растрирует .statement в PNG.
  Lms.prototype.lensCapture = async function () {
    const t = this.currentTask;
    if (!t) throw new Error('задание не открыто');
    if (!this.panel || !this.panelReady) {
      const wasForce = this.forcePanel;
      this.forcePanel = true;
      try {
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
      } finally {
        this.forcePanel = wasForce;
      }
      const started = Date.now();
      while (!this.panelReady && Date.now() - started < 6000) await sleep(120);
    }
    const panel = this.panel;
    if (!panel) throw new Error('панель условия не открылась — откройте задание и повторите');

    const scale = Math.min(Math.max(Number(cfg().get('lens.scale')) || 2, 1), 3);
    return await new Promise((resolve, reject) => {
      // Второй Ctrl+Alt+G отменяет первый захват: иначе его таймер сработает
      // позже и покажет «webview не вернул снимок» поверх успешного второго.
      const prev = this.lensPending;
      if (prev) {
        this.lensPending = null;
        clearTimeout(prev.timer);
        const e = new Error('снимок отменён — запущен новый');
        e.cancelled = true;
        try { prev.reject(e); } catch (e2) { }
      }
      const token = crypto.randomBytes(6).toString('hex');
      const timer = setTimeout(() => {
        if (!this.lensPending || this.lensPending.token !== token) return;
        this.lensPending = null;
        reject(new Error('webview не вернул снимок (попробуйте ещё раз)'));
      }, 25000);
      this.lensPending = { token, resolve, reject, timer };
      try {
        panel.webview.postMessage({ type: 'lensSnapshot', token, scale });
      } catch (e) {
        clearTimeout(timer);
        this.lensPending = null;
        reject(new Error('не удалось попросить снимок у панели: ' + (e.message || e)));
      }
    });
  };

  // Ответ webview: PNG в data-URL.
  Lms.prototype.lensImage = function (msg) {
    const pending = this.lensPending;
    if (!pending) return;
    if (msg && msg.token && msg.token !== pending.token) return;
    this.lensPending = null;
    clearTimeout(pending.timer);
    if (msg && msg.error) return pending.reject(new Error('снимок не получился: ' + msg.error));
    const m = /^data:image\/png;base64,(.+)$/.exec(String((msg && msg.dataUrl) || ''));
    if (!m) return pending.reject(new Error('снимок не получился: неверный формат'));
    pending.resolve({
      png: Buffer.from(m[1], 'base64'),
      width: Number(msg.width) || 0,
      height: Number(msg.height) || 0
    });
  };

  // Проверка снимка перед отправкой: размеры и сигнатура PNG. В журнал
  // попадают только метаданные, без содержимого задания.
  Lms.prototype.lensCheckShot = function (shot) {
    const png = (shot && shot.png) || Buffer.alloc(0);
    const sig = png.slice(0, 8).toString('hex');
    const valid = png.length > 100 && sig === '89504e470d0a1a0a';
    const info = {
      width: Number(shot && shot.width) || 0,
      height: Number(shot && shot.height) || 0,
      bytes: png.length,
      signature: sig,
      valid
    };
    try {
      this.output().appendLine('Lens: снимок ' + info.width + 'x' + info.height +
        ', ' + info.bytes + ' Б, PNG ' + (valid ? 'ok' : 'битый (' + sig + ')'));
    } catch (e) { }
    if (debugEnabled()) {
      try {
        const file = path.join(diagDir(), 'lens-last.png');
        fs.writeFileSync(file, png);
        this.output().appendLine('Lens: снимок сохранён ' + file);
      } catch (e) { }
    }
    return info;
  };

  // Открывает в браузере локальную страницу, которая отправляет снимок в
  // Google обычной формой. Так загрузка и результаты живут в одной сессии
  // браузера — иначе Google показывает картинку из чужой сессии как битую.
  Lms.prototype.openLensUploadPage = async function (shot, query) {
    const dir = this.viewDir();
    const file = path.join(dir, 'lens-upload-' + Date.now() + '.html');
    fs.writeFileSync(file, lensUploadHtml(shot.png.toString('base64'), shot.width, shot.height, Date.now(), query), 'utf8');
    try { this.output().appendLine('Lens: страница загрузки ' + file); } catch (e) { }
    const opened = await vscode.env.openExternal(vscode.Uri.file(file));
    if (!opened) throw new Error('не удалось открыть браузер');
    // В файле лежит снимок задания: браузеру хватает нескольких секунд,
    // поэтому не храним его в temp до общей чистки через 7 дней.
    setTimeout(() => { try { fs.unlinkSync(file); } catch (e) { } }, 120000);
  };

  Lms.prototype.lensTask = async function () {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      return;
    }
    const lens = await this.lensInit();
    const mode = String(cfg().get('lens.openIn') || 'browser');
    // Название задания + просьба решить: без текстового запроса Google
    // открывает AI Mode с «Дополните запрос» и не показывает снимок.
    const title = String(t.taskTitle || t.title || '').trim();
    const lensQuery = title ? title + ' — реши задачу' : 'Реши задачу по программированию';
    let result = null;
    try {
      if (mode !== 'panel') {
        // В браузере снимок отправляет сама страница: форма уходит с куками
        // и IP браузера, поэтому Google не считает результат чужой сессией.
        const shot = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Google Объектив: снимок задания…' },
          async progress => {
            progress.report({ message: 'делаю снимок…' });
            return await this.lensCapture();
          }
        );
        const info = this.lensCheckShot(shot);
        if (!info.valid) throw new Error('снимок получился повреждённым — попробуйте ещё раз');
        await this.openLensUploadPage(shot, lensQuery);
        return;
      }
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Google Объектив: снимок задания…' },
        async progress => {
          progress.report({ message: 'делаю снимок…' });
          const shot = await this.lensCapture();
          this.lensCheckShot(shot);
          // Без гостевых кук Google чаще показывает «я не робот». Забираем их
          // один раз автоматически — пользователю не нужно ничего нажимать.
          if (!lens.status().count) {
            progress.report({ message: 'получаю куки Google…' });
            try { await lens.warmUp(); } catch (e) { }
          }
          progress.report({ message: 'отправляю в Google…' });
          const up = await lens.upload(shot.png, shot.width, shot.height, lensQuery);
          return { shot, url: up.url };
        }
      );
    } catch (e) {
      if (e && e.cancelled) return;
      const msg = String((e && e.message) || e);
      vscode.window.showErrorMessage('LMS: Объектив — ' + msg + (/сеть|fetch|abort/i.test(msg)
        ? '. Похоже, Google недоступен из этой сети — включите VPN и повторите.'
        : ''));
      return;
    }
    if (result && result.url) this.lensShowPanel(result.url, result.shot);
  };

  Lms.prototype.lensOpenSite = async function () {
    await vscode.env.openExternal(vscode.Uri.parse(LENS_HOME));
  };

  Lms.prototype.lensWarmUp = async function () {
    const lens = await this.lensInit();
    const st = await lens.warmUp();
    return st;
  };

  Lms.prototype.lensSaveCookies = async function (text) {
    const lens = await this.lensInit();
    return await lens.importText(text);
  };

  Lms.prototype.lensClearCookies = async function () {
    const lens = await this.lensInit();
    return await lens.clear();
  };

  Lms.prototype.lensProbe = async function () {
    const lens = await this.lensInit();
    return await lens.probe();
  };

  Lms.prototype.lensShowPanel = function (url, shot) {
    const n = crypto.randomBytes(16).toString('hex');
    const img = 'data:image/png;base64,' + shot.png.toString('base64');
    const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src https:; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e); }
  .bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 9px 16px; border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); background: var(--vscode-editor-background, #1e1e1e); }
  .title { font-weight: 600; font-size: 1.05em; }
  .bar .right { margin-left: auto; display: flex; gap: 8px; }
  .btn { font-family: inherit; font-size: .88em; padding: 5px 12px; border-radius: 5px; cursor: pointer; border: 1px solid transparent;
    background: var(--vscode-button-secondaryBackground, #313131); color: var(--vscode-button-secondaryForeground, #ccc); }
  .btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font-weight: 600; }
  .btn:hover { filter: brightness(1.15); }
  .wrap { max-width: 980px; margin: 0 auto; padding: 16px 18px 40px; }
  .note { font-size: .88em; opacity: .75; margin: 0 0 14px; max-width: 76ch; }
  .shot { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--vscode-panel-border, #2b2b2b); background: #fff; }
  .link { display: block; margin: 12px 0 0; font-size: .86em; color: var(--vscode-textLink-foreground, #3794ff); word-break: break-all; }
  details { margin-top: 18px; border: 1px solid var(--vscode-panel-border, #2b2b2b); border-radius: 8px; overflow: hidden; }
  summary { cursor: pointer; padding: 8px 12px; font-size: .9em; user-select: none; }
  iframe { display: block; width: 100%; height: 70vh; border: 0; background: #fff; }
</style>
</head>
<body>
  <div class="bar">
    <span class="title">Google Объектив</span>
    <div class="right">
      <button class="btn primary" data-act="open">Открыть в браузере</button>
      <button class="btn" data-act="copy">Скопировать ссылку</button>
    </div>
  </div>
  <div class="wrap">
    <p class="note">Снимок отправлен, ссылка на результаты готова. Google запрещает встраивать свою страницу
      в другие приложения (<code>X-Frame-Options</code>), поэтому надёжный путь — браузер: там же ваши куки
      и вход в аккаунт. Ниже — то, что ушло в Объектив.</p>
    <img class="shot" src="${img}" alt="Снимок задания">
    <a class="link" href="${escapeHtml(url)}">${escapeHtml(url)}</a>
    <details>
      <summary>Попробовать показать страницу Google здесь</summary>
      <iframe src="${escapeHtml(url)}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </details>
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    vscode.postMessage({ type: el.getAttribute('data-act') });
  });
</script>
</body>
</html>`;
    const options = { enableScripts: true, retainContextWhenHidden: true };
    if (this.lensPanel) {
      this.lensPanel.reveal(vscode.ViewColumn.Active);
      this.lensPanel.webview.html = html;
      this.lensPanel.__url = url;
      return this.lensPanel;
    }
    const panel = vscode.window.createWebviewPanel(LENS_PANEL, 'Google Объектив', vscode.ViewColumn.Active, options);
    this.lensPanel = panel;
    panel.__url = url;
    panel.webview.html = html;
    panel.webview.onDidReceiveMessage(async msg => {
      const type = msg && msg.type;
      if (type === 'open') await vscode.env.openExternal(vscode.Uri.parse(panel.__url));
      if (type === 'copy') {
        try {
          await vscode.env.clipboard.writeText(panel.__url);
          vscode.window.setStatusBarMessage('LMS: ссылка на Объектив скопирована', 3000);
        } catch (e) { }
      }
    });
    panel.onDidDispose(() => {
      if (this.lensPanel === panel) this.lensPanel = null;
    });
    return panel;
  };
}

module.exports = {
  attach, Lens, parseCookieHeader, cookieFromSetCookie, mergeCookies, cookiesFor,
  cookieHeaderFor, isBotPage, absoluteUrl, uploadBody, lensUploadHtml, SECRET_COOKIES, LENS_PANEL
};
