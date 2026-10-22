const vscode = require('vscode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SECRET_COOKIES = 'yandexLms.cookies';
const SECRET_LOGIN = 'yandexLms.login';
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

function cfg() {
  return vscode.workspace.getConfiguration('yandexLms');
}

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
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

function errorItem(message, detail) {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('warning');
  item.tooltip = detail ? String(detail).slice(0, 1500) : message;
  item.command = { command: 'yandexLms.diagnose', title: 'Диагностика API' };
  return item;
}

function safeName(s) {
  return String(s || 'без-названия').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

const webviewState = new WeakMap();

function webviewFragment(html) {
  const styles = [];
  for (const m of html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)) styles.push(m[0]);
  let body = html;
  const bm = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (bm) body = bm[1];
  body = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  return styles.join('\n') + '\n' + body;
}

function webviewLog(event, data) {
  try {
    const dir = path.join(os.tmpdir(), 'yandex-lms-diag');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'webview-log.jsonl'), JSON.stringify(Object.assign({ ts: new Date().toISOString(), event }, data || {})) + '\n', 'utf8');
  } catch (e) { }
}

// Кэш service worker чинится ТОЛЬКО при закрытом VS Code. Пишем cmd-скрипт,
// который дожидается выхода, чистит папки профиля и запускает VS Code заново.
function scheduleWebviewRepair() {
  const dir = path.join(os.tmpdir(), 'yandex-lms-diag');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  const file = path.join(dir, 'fix-webview.cmd');
  const exe = process.execPath;
  const body = [
    '@echo off',
    'timeout /t 3 /nobreak >nul',
    'taskkill /IM Code.exe /F >nul 2>&1',
    'timeout /t 4 /nobreak >nul',
    'rmdir /S /Q "%APPDATA%\\Code\\Service Worker" 2>nul',
    'rmdir /S /Q "%APPDATA%\\Code\\Code Cache" 2>nul',
    'rmdir /S /Q "%APPDATA%\\Code\\GPUCache" 2>nul',
    'start "" "' + exe + '"',
    ''
  ].join('\r\n');
  fs.writeFileSync(file, body, 'ascii');
  require('child_process').spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  webviewLog('sw-repair-scheduled', { file, exe });
  return file;
}

function setWebviewHtml(panel, html) {
  if (!panel) return;
  let st = webviewState.get(panel);
  if (!st) {
    st = { last: '', at: 0, timer: null, assigned: false };
    webviewState.set(panel, st);
  }
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  if (st.assigned) {
    if (st.last === html) return;
    st.last = html;
    st.at = Date.now();
    try {
      panel.webview.postMessage({ type: '__html', html: webviewFragment(html) });
    } catch (e) { }
    return;
  }
  st.assigned = true;
  st.last = html;
  st.at = Date.now();
  webviewLog('assign', { viewType: 'yandexLmsTask', len: html.length });
  try {
    panel.webview.html = html;
  } catch (e) { webviewLog('assign-error', { error: String(e.message || e) }); }
}

function assignWebviewHtml(panel, html) {
  setWebviewHtml(panel, html);
}

class CookieJar {
  constructor() {
    this.map = new Map();
  }

  storeFrom(reqUrl, res) {
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') {
      list = res.headers.getSetCookie();
    } else {
      const one = res.headers.get('set-cookie');
      if (one) list = [one];
    }
    const host = new URL(reqUrl).hostname;
    for (const raw of list) {
      this.storeOne(raw, host);
    }
  }

  storeOne(raw, host) {
    const parts = raw.split(';');
    const nv = parts[0];
    const eq = nv.indexOf('=');
    if (eq <= 0) return;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    const c = { name, value, domain: host, path: '/', expires: 0 };
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
    if (c.expires && c.expires < Date.now() + 1000) {
      this.map.delete(name);
      return;
    }
    this.map.set(name, c);
  }

  headerFor(reqUrl) {
    const u = new URL(reqUrl);
    const host = u.hostname;
    const now = Date.now();
    const items = [];
    for (const c of this.map.values()) {
      if (c.expires && c.expires < now) continue;
      const domainOk = host === c.domain || host.endsWith('.' + c.domain);
      const pathOk = u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/') || c.path === '/';
      if (domainOk && pathOk) items.push(c);
    }
    items.sort((a, b) => b.path.length - a.path.length);
    return items.map(c => `${c.name}=${c.value}`).join('; ');
  }

  serialize() {
    return JSON.stringify([...this.map.values()]);
  }

  restore(text) {
    try {
      const arr = JSON.parse(text);
      this.map = new Map(arr.map(c => [c.name, c]));
    } catch (e) {
      this.map = new Map();
    }
  }

  clear() {
    this.map = new Map();
  }

  isEmpty() {
    return this.map.size === 0;
  }
}

class LmsClient {
  constructor(jar, base) {
    this.jar = jar;
    this.base = base.replace(/\/$/, '');
    this.passport = 'https://passport.yandex.ru';
    this.passportCsrf = '';
  }

  async raw(method, url, opts = {}) {
    let current = url;
    let curMethod = method;
    let curBody = opts.body;
    const extraHeaders = opts.headers || {};
    for (let hop = 0; hop < (opts.maxRedirects === undefined ? 12 : opts.maxRedirects); hop++) {
      const headers = Object.assign({ 'User-Agent': UA, 'Accept': '*/*' }, extraHeaders);
      const ck = this.jar.headerFor(current);
      if (ck) headers['Cookie'] = ck;
      const res = await fetch(current, {
        method: curMethod,
        headers,
        body: curBody,
        redirect: 'manual'
      });
      this.jar.storeFrom(current, res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod !== 'GET')) {
          curMethod = 'GET';
          curBody = undefined;
        }
        continue;
      }
      res.finalUrl = current;
      return res;
    }
    throw new Error('Слишком много перенаправлений');
  }

  apiHeaders() {
    const h = {
      'Accept': 'application/json, text/plain, */*',
      'Referer': this.base + '/',
      'Origin': this.base,
      'X-Request-Id': crypto.randomUUID()
    };
    const csrf = this.jar.map.get('csrftoken');
    if (csrf && csrf.value) {
      h['X-CSRF-Token'] = csrf.value;
      h['X-CSRFToken'] = csrf.value;
    }
    return h;
  }

  async bffSolution(solutionId) {
    const r = await this.api('GET', `/api/proxy/problems/solution/${solutionId}`);
    return r;
  }

  async contestLogs(submissionId) {
    if (!submissionId) return null;
    const urls = [
      `/api/submissions/${submissionId}/contest-logs`,
      `/api/proxy/submissions/${submissionId}/contest-logs`
    ];
    for (const u of urls) {
      try {
        const r = await this.api('GET', u);
        if (r.status === 200 && r.json) return r.json;
      } catch (e) { }
    }
    return null;
  }

  async api(method, apiUrl, payload) {
    const url = apiUrl.startsWith('http') ? apiUrl : this.base + apiUrl;
    const opts = { headers: this.apiHeaders() };
    if (payload !== undefined && method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(payload);
    }
    const res = await this.raw(method, url, opts);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }
    return { status: res.status, json, text, url: res.finalUrl };
  }

  async loginWithPassword(login, password) {
    const url = this.passport + '/passport?mode=auth';
    const body = new URLSearchParams({
      login,
      passwd: password,
      retpath: this.base + '/',
      origin: 'lyceum',
      timestamps: '',
      cnf: ''
    }).toString();
    const res = await this.raw('POST', url, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      maxRedirects: 6
    });
    const finalUrl = res.finalUrl || '';
    const text = await res.text().catch(() => '');
    if (finalUrl.includes('showcaptcha') || text.includes('showcaptcha')) {
      throw new Error('Яндекс показал капчу. Войдите в браузере и используйте «Войти по cookie».');
    }
    if (/confirmation|challenge|otp|twofactor|password-2fa/i.test(finalUrl) || /confirmation|challenge/i.test(text.slice(0, 4000))) {
      throw new Error('Включена двухфакторная защита. Войдите в браузере (можно по QR) и используйте «Войти по cookie».');
    }
    const check = await this.api('GET', '/api/profile?withCoursesSummary=true&withExpelled=true&withChildren=true&withParents=true');
    if (check.status !== 200 || !check.json) {
      throw new Error('Вход не подтверждён сервером (HTTP ' + check.status + '). Используйте «Войти по cookie».');
    }
    return check.json;
  }

  async loginWithCookieString(cookieLine) {
    for (const part of cookieLine.split(';')) {
      const s = part.trim();
      if (!s) continue;
      this.jar.storeOne(s, 'lms.yandex.ru');
    }
    const check = await this.api('GET', '/api/profile?withCoursesSummary=true&withExpelled=true&withChildren=true&withParents=true');
    if (check.status !== 200 || !check.json) {
      throw new Error('С cookie не удалось получить профиль (HTTP ' + check.status + '). Проверьте, что скопированы все куки lms.yandex.ru.');
    }
    return check.json;
  }

  passportHeaders(extra) {
    const h = Object.assign({
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Origin': this.passport,
      'Referer': this.passport + '/'
    }, extra || {});
    if (this.passportCsrf) h['x-csrf-token'] = this.passportCsrf;
    return h;
  }

  async passportApi(apiPath, payload) {
    const url = this.passport + '/pwl-yandex/api/passport' + apiPath;
    const res = await this.raw('POST', url, {
      headers: this.passportHeaders(),
      body: JSON.stringify(payload || {})
    });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, json, text, url: res.finalUrl };
  }

  async loginQr(linkCallback, abort) {
    this.passportCsrf = '';
    const startUrl = this.passport + '/pwl-yandex?retpath=' + encodeURIComponent(this.base + '/') + '&origin=lyceum';
    const start = await this.raw('GET', startUrl);
    const startText = await start.text().catch(() => '');
    if (start.url && /showcaptcha/i.test(start.url)) {
      throw new Error('Яндекс показал капчу. Попробуйте позже или используйте «Войти по cookie».');
    }
    const m = startText.match(/window\.__CSRF__\s*=\s*"([^"]+)"/);
    this.passportCsrf = m ? m[1] : '';

    const submit = await this.passportApi('/auth/password/submit', {
      retpath: this.base + '/',
      yandexAllowedDomains: ''
    });
    if (submit.status !== 200 || !submit.json || !submit.json.track_id) {
      throw new Error('passport password/submit: HTTP ' + submit.status + ' ' + submit.text.slice(0, 200));
    }
    const magicTrack = String(submit.json.track_id);
    const magicCsrf = submit.json.csrf_token ? String(submit.json.csrf_token) : this.passportCsrf;

    const codeRes = await this.passportApi('/auth/magic/code', {
      track_id: '',
      magic_track_id: magicTrack,
      location_id: '0'
    });
    let link = codeRes.json && codeRes.json.link;
    if (!link) {
      const alt = await this.passportApi('/auth/saving-flow/qr', {
        track_id: '',
        magic_track_id: magicTrack,
        location_id: '0'
      });
      link = alt.json && alt.json.link;
    }
    if (!link) {
      throw new Error('passport magic/code: HTTP ' + codeRes.status + ' ' + codeRes.text.slice(0, 200));
    }
    if (linkCallback) await linkCallback(link);

    const deadline = Date.now() + 9.5 * 60 * 1000;
    let finished = false;
    let trackId = '';
    let sameErr = 0;
    while (Date.now() < deadline) {
      if (abort && abort.cancelled) throw new Error('Отменено');
      await sleep(1000);
      let st;
      try {
        st = await this.passportApi('/auth/magic/code/status', {
          track_id: magicTrack,
          csrf_token: magicCsrf,
          yandexAllowedDomains: ''
        });
      } catch (e) {
        sameErr++;
        if (sameErr >= 5) throw e;
        continue;
      }
      if (st.status !== 200 || !st.json) {
        sameErr++;
        if (sameErr >= 5) throw new Error('passport magic/code/status: HTTP ' + st.status);
        continue;
      }
      sameErr = 0;
      const state = st.json.state;
      if (st.json.stopPolling) {
        throw new Error('QR-сессия закрыта сервером (state=' + state + ').');
      }
      if (state === 'auth_challenge') {
        throw new Error('Аккаунт требует дополнительное подтверждение (2FA). Войдите по паролю или по cookie.');
      }
      if (state === 'otp_auth_finished') {
        finished = true;
        trackId = st.json.trackId ? String(st.json.trackId) : '';
        break;
      }
    }
    if (!finished) throw new Error('Время QR-входа истекло (10 минут). Запустите вход заново.');

    const finalTrack = trackId || magicTrack;
    try { await this.passportApi('/sessions/get_session', { track_id: finalTrack }); } catch (e) { }
    try { await this.passportApi('/auth/logined/account', {}); } catch (e) { }
    try {
      const delRes = await this.raw('POST', this.passport + '/api/track/delete', {
        headers: this.passportHeaders(),
        body: JSON.stringify({ track_id: finalTrack })
      });
      await delRes.text().catch(() => '');
    } catch (e) { }

    const check = await this.api('GET', '/api/profile?withCoursesSummary=true&withExpelled=true&withChildren=true&withParents=true');
    if (check.status !== 200 || !check.json) {
      throw new Error('QR-вход получен, но профиль LMS недоступен (HTTP ' + check.status + '). Используйте «Войти по cookie».');
    }
    return check.json;
  }

  async profile() {
    return this.api('GET', '/api/profile?withCoursesSummary=true&withExpelled=true&withChildren=true&withParents=true');
  }

  async lessons(courseId, groupId) {
    return this.api('GET', `/api/student/lessons?courseId=${courseId}&groupId=${groupId}`);
  }

  async lessonTasks(courseId, lessonId, groupId) {
    return this.api('GET', `/api/student/lessonTasks?courseId=${courseId}&lessonId=${lessonId}&groupId=${groupId}`);
  }

  async task(taskId, groupId) {
    return this.api('GET', `/api/student/tasks/${taskId}?groupId=${groupId}`);
  }

  async solution(solutionId) {
    return this.api('GET', `/api/student/solutions/${solutionId}`);
  }

  async submitCandidates(ctx, code) {
    const compilerId = ctx.compilerId;
    const sid = ctx.solutionId;
    const attempts = [];
    const tryOne = async (label, method, apiUrl, opts = {}) => {
      let res;
      let reqBody = '';
      try {
        if (typeof opts.body === 'string') reqBody = opts.body.slice(0, 2000);
      } catch (e) { }
      try {
        res = await this.raw(method, apiUrl.startsWith('http') ? apiUrl : this.base + apiUrl, Object.assign({ headers: this.apiHeaders() }, opts));
      } catch (e) {
        attempts.push({ label, status: 'ERR', detail: String(e.message || e) });
        try { this.onAttempt && this.onAttempt(label, method, apiUrl, 'ERR', String(e.message || e), reqBody); } catch (e2) { }
        return null;
      }
      const text = await res.text().catch(() => '');
      attempts.push({ label, status: res.status, detail: text.slice(0, 300) });
      try { this.onAttempt && this.onAttempt(label, method, apiUrl, res.status, text, reqBody); } catch (e) { }
      if (res.status >= 200 && res.status < 300) {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (e) { }
        return { json, text };
      }
      return null;
    };

    if (sid) {
      const mkUpload = () => {
        const f = new FormData();
        f.append('file', new Blob([code], { type: 'text/x-python' }), 'solution.py');
        if (compilerId !== undefined && compilerId !== null) f.append('compiler_id', String(compilerId));
        return f;
      };
      const uploadUrls = [
        `/api/student/solutions/${sid}/comments/files`,
        `/api/proxy/student/solutions/${sid}/comments/files`
      ];
      for (const u of uploadUrls) {
        const r = await tryOne(`POST ${u} (multipart solution.py)`, 'POST', u, { headers: this.apiHeaders(), body: mkUpload() });
        if (r) return { result: r, attempts, solutionId: sid };
      }
      const json = (o) => ({ headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify(o) });
      const proxyTries = [
        [`POST /api/proxy/student/solutions/${sid}/submission (json)`, 'POST', `/api/proxy/student/solutions/${sid}/submission`, json({ code, compiler_id: compilerId })],
        [`POST /api/proxy/student/solutions/${sid}/submission (code)`, 'POST', `/api/proxy/student/solutions/${sid}/submission`, json({ code })],
        [`POST /api/proxy/student/solutions/${sid}/submissions (json)`, 'POST', `/api/proxy/student/solutions/${sid}/submissions`, json({ code, compiler_id: compilerId })],
        [`PUT /api/proxy/student/solutions/${sid} (json)`, 'PUT', `/api/proxy/student/solutions/${sid}`, json({ code, compiler_id: compilerId })],
        [`POST /api/proxy/student/solutions/${sid}/attempt (multipart)`, 'POST', `/api/proxy/student/solutions/${sid}/attempt`, (() => {
          const f = new FormData();
          f.append('file', new Blob([JSON.stringify({ code, compiler_id: compilerId })], { type: 'application/json' }), 'solution.json');
          return { headers: this.apiHeaders(), body: f };
        })()]
      ];
      for (const [label, method, url, opts] of proxyTries) {
        const r = await tryOne(label, method, url, opts);
        if (r) return { result: r, attempts, solutionId: sid };
      }
      const formProxy = new FormData();
      formProxy.append('file', new Blob([code], { type: 'text/x-python' }), 'solution.py');
      if (compilerId !== undefined) formProxy.append('compiler_id', String(compilerId));
      const rf = await tryOne(`POST /api/proxy/student/solutions/${sid}/submission (multipart)`, 'POST', `/api/proxy/student/solutions/${sid}/submission`, {
        headers: this.apiHeaders(),
        body: formProxy
      });
      if (rf) return { result: rf, attempts, solutionId: sid };

      const answerBodies = [
        { code },
        { code, compiler_id: compilerId },
        { code, compilerId },
        { sourceCode: code }
      ];
      for (const body of answerBodies) {
        const b = compilerId === undefined ? Object.fromEntries(Object.entries(body).filter(([k]) => !/compiler/i.test(k))) : body;
        const r = await tryOne(`POST /api/student/problem/submission (bff)`, 'POST', `/api/student/problem/submission?solutionId=${sid}`, {
          headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify(b)
        });
        if (r) return { result: r, attempts, solutionId: sid };
      }
      for (const body of answerBodies.slice(0, 2)) {
        const r = await tryOne(`POST /api/proxy/student/problem/submission`, 'POST', `/api/proxy/student/problem/submission?solutionId=${sid}`, {
          headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        });
        if (r) return { result: r, attempts, solutionId: sid };
      }
      const bodies = [];
      bodies.push({ code, compilerId });
      bodies.push({ sourceCode: code, compilerId });
      bodies.push({ code, compiler_id: compilerId });
      for (const body of bodies) {
        const r = await tryOne(`POST /api/student/solutions/${sid}/submission`, 'POST', `/api/student/solutions/${sid}/submission`, {
          headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        });
        if (r) return { result: r, attempts, solutionId: sid };
      }
      for (const body of bodies.slice(0, 2)) {
        const r = await tryOne(`POST /api/student/solutions/${sid}`, 'POST', `/api/student/solutions/${sid}`, {
          headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        });
        if (r) return { result: r, attempts, solutionId: sid };
        const p = await tryOne(`PUT /api/student/solutions/${sid}`, 'PUT', `/api/student/solutions/${sid}`, {
          headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        });
        if (p) return { result: p, attempts, solutionId: sid };
      }
      const r2 = await tryOne(`POST /api/student/solutions/${sid}/submissions`, 'POST', `/api/student/solutions/${sid}/submissions`, {
        headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code, compilerId })
      });
      if (r2) return { result: r2, attempts, solutionId: sid };
      const form = new FormData();
      form.append('file', new Blob([code], { type: 'text/x-python' }), 'solution.py');
      if (compilerId !== undefined) form.append('compilerId', String(compilerId));
      const r3 = await tryOne(`POST /api/student/solutions/${sid}/file (multipart)`, 'POST', `/api/student/solutions/${sid}/file`, {
        headers: this.apiHeaders(),
        body: form
      });
      if (r3) return { result: r3, attempts, solutionId: sid };
      const r4 = await tryOne(`POST /api/student/solutions/${sid}/submit`, 'POST', `/api/student/solutions/${sid}/submit`, {
        headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code, compilerId })
      });
      if (r4) return { result: r4, attempts, solutionId: sid };
    }

    const create = await tryOne('POST /api/student/solutions (создать решение)', 'POST', '/api/student/solutions', {
      headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ taskId: ctx.taskId, task_id: ctx.taskId, compilerId })
    });
    let newSid = sid;
    if (create && create.json) {
      newSid = pick(create.json, 'id') || pick(create.json.solution, 'id') || pick(create.json.data, 'id') || sid;
    }
    if (newSid && newSid !== sid) {
      const r = await tryOne(`POST /api/student/solutions/${newSid}/submission`, 'POST', `/api/student/solutions/${newSid}/submission`, {
        headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code, compilerId })
      });
      if (r) return { result: r, attempts, solutionId: newSid };
    }
    const r5 = await tryOne(`POST /api/student/tasks/${ctx.taskId}/solution`, 'POST', `/api/student/tasks/${ctx.taskId}/solution`, {
      headers: Object.assign(this.apiHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code, compilerId })
    });
    if (r5) return { result: r5, attempts, solutionId: newSid };
    return { result: null, attempts, solutionId: newSid };
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
    this.aiNote = null;
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
      if (reqBody) o.appendLine(`  req: ${String(reqBody).slice(0, 600)}`);
      o.appendLine(`  [${label}] ${String(body).slice(0, 400)}`);
      this.logSubmit({ ts: new Date().toISOString(), label, method, url, status, req: reqBody || null, res: String(body).slice(0, 8000) });
    };
  }

  async init() {
    const saved = await this.context.secrets.get(SECRET_COOKIES);
    if (saved) {
      this.jar.restore(saved);
      await this.refreshProfile(true);
    }
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

  baseDir() {
    const folderName = cfg().get('folderName') || 'yandex-lms';
    const folders = vscode.workspace.workspaceFolders;
    const root = folders && folders.length ? folders[0].uri.fsPath : os.homedir();
    return path.join(root, folderName);
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

  taskFilePath(courseTitle, lessonTitle, task) {
    const dir = this.taskFileDir(courseTitle, lessonTitle);
    const num = pick(task, 'id');
    const title = pick(task, 'shortTitle', 'short_title') || pick(task, 'title') || 'задача';
    return path.join(dir, `${num}-${safeName(title)}.py`);
  }

  async openTask(node) {
    if (!(await this.ensureAuth())) return;
    const task = node.task;
    const groupId = node.groupId;
    await this.saveActiveIfDirty();
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: загружаю задание…' }, async () => {
      const det = await this.client.task(task.id, groupId);
      if (det.status !== 200 || !det.json) {
        vscode.window.showErrorMessage('LMS: не удалось загрузить задание (HTTP ' + det.status + ')');
        return;
      }
      const detail = det.json;
      this.detailCache.set(String(detail.id || task.id), detail);
      try {
        const sc = pick(detail, 'storeContainer');
        fs.writeFileSync(path.join(this.diagDir(), 'task-detail-latest.json'), JSON.stringify({
          id: detail.id, title: detail.title, taskType: detail.taskType,
          contestProblemType: detail.contestProblemType,
          description: pick(detail, 'description', 'statement', 'content'),
          storeContainer: sc || null,
          keys: Object.keys(detail)
        }, null, 2), 'utf8');
      } catch (e) { }
      const isMarkers = this.isMarkersTask(detail);
      const solutionId = pick(detail, 'solutionId', 'solution_id');
      let serverCode = null;
      let verdictInfo = pick(detail, 'latestSubmission', 'latest_submission');
      let problemDefinition = null;
      let markersQuestion = '';
      this.currentStatementHtml = null;
      this.statementImages = [];
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
        // картинки в описании (если есть) — тоже подгружаем
        const assetsM = await this.prepareStatement(detail);
        this.currentStatementHtml = assetsM.html;
        this.statementImages = assetsM.images;
        // и картинки внутри текстовых блоков задания
        this.inlinedText = new Map();
        const qparts = [];
        // ресурсы (картинки с кодом) из storeContainer.resources
        const resources = pick(detail, 'storeContainer') ? pick(pick(detail, 'storeContainer'), 'resources') : null;
        const resMap = await this.loadResources(resources);
        if (resMap.size) this.output().appendLine('LMS: загружено ресурсов-картинок: ' + resMap.size);
        for (const b of this.markersBlocks(problemDefinition)) {
          const c = pick(b, 'content') || {};
          const txt = pick(c, 'text');
          if (!txt) continue;
          let text = this.substituteResources(txt, resMap);
          if (/<img/i.test(text)) {
            const a2 = await this.inlineImages(text);
            this.inlinedText.set(txt, a2.html);
            for (const im of a2.images) this.statementImages.push(im);
            text = a2.html;
          }
          qparts.push(text);
        }
        if (qparts.length) markersQuestion = qparts.join('\n\n');
        if (this.statementImages.length) this.output().appendLine('LMS: картинок в задании: ' + this.statementImages.length);
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
        // картинки в условии — скачиваем с авторизацией и встраиваем как data-URI
        const sc = pick(detail, 'storeContainer');
        const resMap = await this.loadResources(sc ? pick(sc, 'resources') : null);
        const descRaw = String(pick(detail, 'description', 'statement', 'content') || '');
        const descWithRes = this.substituteResources(descRaw, resMap);
        const assets = await this.inlineImages(descWithRes);
        this.currentStatementHtml = assets.html;
        this.statementImages = assets.images;
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
          const initial = stripTemplate(String(serverCode || ''));
          fs.writeFileSync(filePath, initial, 'utf8');
          created = true;
        } else {
          try {
            const st = fs.statSync(filePath);
            const cur = fs.readFileSync(filePath, 'utf8');
            const clean = stripTemplate(cur);
            if (clean !== cur) {
              const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
              if (!open || !open.isDirty) {
                fs.writeFileSync(filePath, clean, 'utf8');
                this.output().appendLine('LMS: удалён шаблон main() из ' + path.basename(filePath));
              }
            } else if (st.size === 0 && serverCode && String(serverCode).trim()) {
              fs.writeFileSync(filePath, stripTemplate(String(serverCode)), 'utf8');
            }
          } catch (e) { }
        }
        // закрываем предыдущее окно кода — чтобы не плодились
        if (this.prevCodePath) await this.closeTabByPath(this.prevCodePath);
        this.prevCodePath = filePath;
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two, false);
        if (created) {
          vscode.window.showInformationMessage('LMS: создан файл ' + path.basename(filePath));
        }
      } else {
        // задание с вариантами ответа — кода писать не надо, окно кода закрываем
        if (this.prevCodePath) {
          await this.closeTabByPath(this.prevCodePath);
          this.prevCodePath = null;
        }
      }
      this.currentTask = {
        taskId: detail.id || task.id,
        solutionId,
        groupId,
        compilerId: compilers.length === 1 ? compilers[0] : compilers[0],
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
      await this.showTaskPanel(detail, serverCode);
    });
  }

  verdictText(info) {
    if (!info) return 'Решение ещё не отправлено';
    const v = pick(info, 'verdict');
    if (!v) return 'Проверяется…';
    return VERDICTS[v] || v;
  }

  attachPanel(panel) {
    webviewLog('created', { viewType: panel.viewType, visible: panel.visible });
    panel.onDidDispose(() => {
      webviewLog('disposed', { viewType: panel.viewType });
      webviewState.delete(panel);
      if (this.panel === panel) this.panel = null;
    });
    panel.webview.onDidReceiveMessage(async msg => {
      webviewLog('msg', { type: String(msg && msg.type) });
      if (msg.type === 'ready' || msg.type === '__pong' || msg.type === 'needState') {
        const st2 = webviewState.get(panel);
        if (st2) st2.ready = true;
      }
      if (msg.type === 'needState') {
        const t = this.currentTask;
        try {
          panel.webview.postMessage({
            type: 'state',
            state: t ? {
              taskId: t.taskId, groupId: t.groupId, solutionId: t.solutionId, filePath: t.filePath,
              taskTitle: t.taskTitle, courseTitle: t.courseTitle, lessonTitle: t.lessonTitle, compilerId: t.compilerId
            } : {}
          });
        } catch (e) { }
        return;
      }
      if (!this.currentTask) return;
      if (msg.type === 'submit') {
        await this.submitCurrent();
      } else if (msg.type === 'refresh') {
        await this.reloadCurrentTask();
      } else if (msg.type === 'browser') {
        await this.openCurrentInBrowser();
      } else if (msg.type === 'pull') {
        await this.pullSolution(this.currentTask);
      } else if (msg.type === 'aiHints') {
        await this.aiRun('hints');
      } else if (msg.type === 'aiSolve') {
        await this.aiRun('solve');
      } else if (msg.type === 'aiFix') {
        await this.aiFix();
      } else if (msg.type === 'markersSubmit') {
        await this.markersAnswer(msg.answer || {});
      } else if (msg.type === 'pep8') {
        await this.pep8Check();
      } else if (msg.type === 'aiAnswer') {
        await this.aiChooseAnswer();
      } else if (msg.type === 'details') {
        const d = await this.refreshContestLogs();
        await this.showTaskPanel(this.detailCache.get(String(this.currentTask && this.currentTask.taskId)) || { title: this.currentTask && this.currentTask.taskTitle }, null);
        if (!d) vscode.window.showInformationMessage('LMS: деталей проверки нет (задача ещё не проверялась).');
      } else if (msg.type === 'aiCheck') {
        await this.aiRun('check');
      } else if (msg.type === 'aiClear') {
        await this.aiClear();
      } else if (msg.type === 'aiSettings') {
        await this.aiSettingsUI();
      } else if (msg.type === 'aiKeys') {
        await this.aiKeysUI();
      }
    });
  }

  pep8Html() {
    const r = this.pep8Report;
    if (!r) return '';
    const rows = (r.errors || []).map(e =>
      '<div class="d-row"><span class="d-label">строка ' + e.line + (e.col ? ':' + e.col : '') + '</span><span class="d-value">' + escapeHtml(e.code + ' ' + e.text) + '</span></div>'
    ).join('');
    return '<div class="details pep8"><div class="ai-title">Проверка PEP 8' + (r.tool ? ' (' + escapeHtml(r.tool) + ')' : '') + '</div>' +
      (rows || '<div class="d-row"><span class="d-value">Замечаний нет — код соответствует PEP 8.</span></div>') + '</div>';
  }

  aiStateHtml() {
    aiPruneStates();
    const list = aiEntries();
    if (!list.length) {
      return 'ИИ: <b>не настроен</b> — нажмите «AI: ключи», чтобы добавить провайдера и ключ.';
    }
    const ready = list.filter(e => aiCooldownLeft(e) === 0);
    const active = list.find(e => e.id === AI_POOL_ACTIVE) || ready[0] || list[0];
    const st = AI_POOL_STATE[active.id] || {};
    const kinds = {};
    for (const e of list) {
      const s = AI_POOL_STATE[e.id] || {};
      if (aiCooldownLeft(e) > 0) kinds[s.kind || 'error'] = (kinds[s.kind || 'error'] || 0) + 1;
    }
    let status;
    if (ready.length) {
      status = '<span class="ai-ok">готов</span>';
    } else if ((kinds.auth || 0) === list.length) {
      status = '<span class="ai-bad">ключи не приняты</span>';
    } else if (kinds.limit) {
      const min = Math.min.apply(null, list.map(e => aiCooldownLeft(e)) || [0]);
      status = '<span class="ai-warn">лимит ещё ' + Math.max(1, Math.ceil(min / 60000)) + ' мин</span>';
    } else {
      const min = Math.min.apply(null, list.map(e => aiCooldownLeft(e)) || [0]);
      status = '<span class="ai-warn">пауза ' + Math.max(1, Math.ceil(min / 1000)) + ' с</span>';
    }
    const tip = list.map(e => {
      const s = AI_POOL_STATE[e.id] || {};
      const cd = aiCooldownLeft(e);
      return aiEntryLabel(e) + ' [' + aiKeyTail(e.apiKey) + ']: ' +
        (cd ? (s.kind === 'limit' ? 'лимит' : (s.kind === 'auth' ? 'ключ не принят' : (s.kind === 'denied' ? 'доступ к модели закрыт' : 'пауза'))) +
          ' ещё ' + Math.ceil(cd / 1000) + ' с' + (s.lastError ? ' — ' + s.lastError : '') : 'работает');
    }).join('\n');
    return '<span title="' + escapeHtml(tip).replace(/\n/g, '&#10;') + '">ИИ: <b>' + escapeHtml(active.label || active.provider) + '</b> · ' + escapeHtml(active.model) +
      ' · ' + escapeHtml(aiKeyTail(active.apiKey)) +
      (list.length > 1 ? ' · ключей ' + ready.length + '/' + list.length : '') +
      (st.ms ? ' · ' + (st.ms / 1000).toFixed(1) + ' с' : '') +
      ' · ' + status + '</span>';
  }

  aiBlockHtml() {
    const parts = [];
    if (this.aiHints) {
      parts.push('<div class="ai-note"><div class="ai-title">Подсказки ИИ</div>' + mdToHtml(this.aiHints) + '</div>');
    }
    if (this.aiNote) {
      parts.push('<div class="ai-note"><div class="ai-title">Проверка ИИ</div>' + mdToHtml(this.aiNote) + '</div>');
    }
    return parts.join('\n');
  }

  taskHtml(t, detail, serverCode) {
    let aiState = '';
    let aiBlock = '';
    try {
      aiState = this.aiStateHtml();
      aiBlock = this.aiBlockHtml();
    } catch (e) {
      webviewLog('taskhtml-ai-error', { error: String(e.message || e) });
    }
    const webview = this.panel ? this.panel.webview : null;
    const csp = webview ? webview.cspSource : '';
    const nonce = String(Math.random()).slice(2);
    let statement = pick(detail, 'description', 'statement', 'content');
    if (this.currentStatementHtml) statement = this.currentStatementHtml;
    if (!statement) {
      const cached = this.detailCache.get(String(t && t.taskId));
      if (cached) statement = pick(cached, 'description', 'statement', 'content');
    }
    statement = statement || '<p>Условие не пришло от API. Откройте задание в браузере кнопкой ниже.</p>';
    const verdict = this.verdictText(t.verdictInfo);
    const scoreMax = pick(detail, 'scoreMax', 'score_max');
    const deadline = pick(detail, 'deadline');
    const safeStatement = String(statement).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; img-src ${csp} https: data:; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 18px 18px; line-height: 1.5; }
  h1 { font-size: 1.2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
  .meta { opacity: 0.75; font-size: 0.9em; margin-bottom: 12px; }
  .status { padding: 8px 12px; border-radius: 6px; margin-bottom: 14px; background: var(--vscode-input-background); border-left: 4px solid var(--vscode-charts-blue); }
  .status.ok { border-left-color: var(--vscode-charts-green); }
  .status.fail { border-left-color: var(--vscode-charts-red); }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  .actions.ai-row { grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); margin-bottom: 6px; }
  button { font-family: inherit; font-size: 0.92em; padding: 5px 8px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; width: 100%; text-align: center; }
  button.secondary { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); }
  button:hover { filter: brightness(1.1); }
  .ai-state { font-size: 0.88em; opacity: 0.85; margin: 0 0 12px; }
  .ai-ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .ai-bad { color: var(--vscode-charts-red, #f14c4c); }
  .ai-warn { color: var(--vscode-charts-orange, #d18616); }
  .ai-note { margin: 0 0 14px; padding: 10px 12px; border-radius: 6px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.12)); border-left: 4px solid var(--vscode-charts-purple); }
  .ai-title { font-weight: 600; margin-bottom: 6px; }
  .ai-note h3, .ai-note h4, .ai-note h5, .ai-note h6 { font-size: 1em; margin: 8px 0 4px; }
  .ai-note p { margin: 4px 0; }
  .ai-note ul, .ai-note ol { margin: 4px 0 4px 18px; padding: 0; }
  .ai-note code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,0.2); padding: 1px 4px; border-radius: 3px; }
  .ai-note pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 10px; overflow: auto; border-radius: 4px; }
  .ai-note pre code { background: none; padding: 0; }
  .details { margin: 0 0 16px; padding: 10px 12px; border-radius: 6px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.12)); border-left: 4px solid var(--vscode-charts-orange); }
  .d-row { display: flex; gap: 8px; margin: 3px 0; font-size: 0.92em; }
  .d-label { min-width: 150px; opacity: 0.8; }
  .d-value { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-word; }
  .markers-question { margin: 0 0 12px; }
  .marker-text { margin-bottom: 10px; }
  .marker-text pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 10px; overflow: auto; border-radius: 4px; }
  .marker-options { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 10px; }
  .opt { display: flex; gap: 8px; align-items: flex-start; padding: 5px 8px; border-radius: 5px; border: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .opt:hover { background: var(--vscode-list-hoverBackground); }
  .opt input { margin-top: 3px; }
  .statement img { max-width: 100%; }  .statement pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 10px; overflow: auto; border-radius: 4px; }
  .statement code { font-family: var(--vscode-editor-font-family, monospace); }
  table { border-collapse: collapse; }
  td, th { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
</style>
</head>
<body>
  <h1>${escapeHtml(t.taskTitle)}</h1>
  <div class="meta">
    ${t.courseTitle ? 'Курс: ' + escapeHtml(t.courseTitle) + '<br>' : ''}
    ${t.lessonTitle ? 'Урок: ' + escapeHtml(t.lessonTitle) + '<br>' : ''}
    ${scoreMax !== undefined ? 'Максимум баллов: ' + escapeHtml(String(scoreMax)) + '<br>' : ''}
    ${deadline ? 'Дедлайн: ' + escapeHtml(String(deadline)) : ''}
  </div>
  <div class="status ${t.verdictInfo && pick(t.verdictInfo, 'verdict') === 'OK' ? 'ok' : (t.verdictInfo ? 'fail' : '')}">
    Статус: ${escapeHtml(verdict)}
  </div>
  <div class="actions">
    ${t.isMarkers ? '' : '<button data-act="submit" class="primary">Отправить решение (Ctrl+Alt+S)</button><button data-act="pull" class="secondary">Забрать из LMS</button><button data-act="refresh" class="secondary">Обновить статус</button><button data-act="browser" class="secondary">Открыть в браузере</button>'}
  </div>
  <div class="actions ai-row">
    ${t.isMarkers
      ? '<button data-act="pep8" class="secondary">PEP 8</button><button data-act="aiSettings" class="secondary">AI: настройки</button><button data-act="aiKeys" class="secondary">AI: ключи</button><button data-act="aiClear" class="secondary">Очистить</button>'
      : '<button data-act="pep8" class="secondary">PEP 8</button><button data-act="aiHints" class="secondary">AI: подсказки</button><button data-act="aiCheck" class="secondary">AI: проверить</button><button data-act="aiSolve" class="secondary">AI: решение</button><button data-act="aiFix" class="secondary">AI: исправить</button><button data-act="aiClear" class="secondary">Очистить</button><button data-act="aiSettings" class="secondary">AI: настройки</button><button data-act="aiKeys" class="secondary">AI: ключи</button>'}
  </div>
  <div class="ai-state">${aiState}</div>
  ${aiBlock}
  ${this.contestLogsHtml()}
  ${this.aiLessonsHtml()}
  ${t.isMarkers ? this.markersPanelHtml() : `<div class="statement">${safeStatement}</div>`}
<script nonce="${nonce}">
  const vscode = window.__vscode || (window.__vscode = acquireVsCodeApi());
  if (!window.__lmsSwap) {
    window.__lmsSwap = true;
    window.addEventListener('message', ev => {
      const m = ev.data || {};
      if (m.type === '__html' && typeof m.html === 'string') {
        document.body.innerHTML = m.html;
      }
      if (m.type === '__ping') {
        vscode.postMessage({ type: '__pong' });
      }
      if (m.type === 'state' && m.state) {
        try { vscode.setState(m.state); } catch (e) { }
      }
    });
  }
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.getAttribute('data-act');
    if (act === 'markersSubmit') {
      const answer = {};
      document.querySelectorAll('input[data-marker]').forEach(inp => {
        const key = inp.getAttribute('data-marker');
        if (inp.type === 'checkbox') {
          if (inp.checked) { answer[key] = answer[key] ? answer[key] + ',' + inp.value : inp.value; }
        } else if (inp.checked) {
          answer[key] = inp.value;
        }
      });
      vscode.postMessage({ type: 'markersSubmit', answer });
      return;
    }
    vscode.postMessage({ type: act });
  });
  vscode.postMessage({ type: 'needState' });
</script>
</body>
</html>`;
  }

  aiStatement() {
    const t = this.currentTask;
    if (!t) return '';
    const cached = this.detailCache.get(String(t.taskId));
    const html = cached ? pick(cached, 'description', 'statement', 'content') : '';
    return htmlToText(html);
  }

  aiCurrentCode() {
    const t = this.currentTask;
    if (!t || !t.filePath) return '';
    try {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === t.filePath);
      if (doc) return doc.getText();
      if (fs.existsSync(t.filePath)) return fs.readFileSync(t.filePath, 'utf8');
    } catch (e) { }
    return '';
  }

  async aiFileWrite(text) {
    const t = this.currentTask;
    if (!t || !t.filePath) throw new Error('Нет открытого файла задачи.');
    const uri = vscode.Uri.file(t.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, text);
    await vscode.workspace.applyEdit(edit);
  }

  async aiRememberComments(comments) {
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
  }

    aiStudentRules() {
    return [
      'Ученик — новичок, прошедший только предыдущие уроки курса «Программирование на Python» (ввод-вывод, строки, списки, словари, циклы for и while, условия, вложенные циклы, работа с символами).',
      'СТРОГИЕ ОГРАНИЧЕНИЯ (нарушение = неверный ответ):',
      '- НЕЛЬЗЯ использовать модули и библиотеки: import, sys, os, math, random, collections, re, typing, itertools, datetime, json и любые другие. Никакого import вообще.',
      '- НЕЛЬЗЯ использовать классы и ООП, try/except/finally, raise, lambda, генераторы, декораторы, comprehensions (списковые/словарные/множественные), тернарные операторы, f-строки вида f"...", распаковку, *, nonlocal, async, декораторы, сортировку с ключем.',
      '- НЕЛЬЗЯ использовать bitwise-операции, побитовые сдвиги, степени через **, math-функции, random.',
      'РАЗРЕШЕНО: print() (в т.ч. с sep= и end=), input(), int(), float(), str(), bool(), len(), range(), abs(), round(), min(), max(), sum(), zip(), enumerate(), строки (upper, lower, strip, split, replace, find, index, count, startswith, endswith, isdigit, isalpha, isspace, join, ord, chr, title, capitalize, ljust, rjust), списки (append, insert, pop, remove, sort, reverse, count, index, len, срез[:]), словари (get, keys, values, items, in, len), циклы for/while, range, break/continue, if/elif/else, вложенные циклы, арифметика, конкатенация строк, форматирование через % и .format().',
      'Код должен читать ввод через input() и печатать ответ через print(). Никаких пояснений в коде.'
    ].join('\n');
  }

  aiSystemPrompt() {
    return 'Ты — наставник курса Яндекс LMS «Программирование на Python» (26/27). Пишешь по-русски, коротко и по делу, как методичка курса. Отвечаешь ТОЛЬКО на русском языке.';
  }

  async aiRun(mode) {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      return;
    }
    const c = aiConfig();
    if (!aiHasConfig()) {
      const go = await vscode.window.showInformationMessage('ИИ не настроен. Добавить провайдера и ключ сейчас?', 'Настроить');
      if (go === 'Настроить') await this.aiKeysUI();
      return;
    }
    const statement = this.aiStatement();
    if (!statement) {
      vscode.window.showWarningMessage('LMS: не удалось получить условие задачи (откройте задание заново).');
      return;
    }
    const code = this.aiCurrentCode();
    aiLog({ event: 'start', mode, provider: c.provider, model: c.model, pool: aiEntries().map(e => aiEntryLabel(e)), filePath: t.filePath, codeLen: code.length, statementLen: statement.length });
    vscode.window.showInformationMessage('LMS: ИИ думает… (' + this.aiStatusText() + ')');
    let text = '';
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
        text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — строгий, но доброжелательный проверяющий.', 60000, this.statementImages, { maxTokens: 900 });
        const sp = this.splitLesson(text);
        this.aiNote = sp.text;
        if (sp.lesson) await this.aiRememberLesson(sp.lesson);
        this.output().appendLine('=== AI: проверка решения ===\n' + text);
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
        vscode.window.showInformationMessage('LMS: проверка ИИ готова — смотри в панели задачи.');
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
        text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — наставник, который ведёт ученика за руку, но не даёт готового решения.', 60000, this.statementImages, { maxTokens: 900 });
        const sp = this.splitLesson(text);
        this.aiHints = sp.text;
        if (sp.lesson) await this.aiRememberLesson(sp.lesson);
        this.output().appendLine('=== AI: подсказки ===\n' + text);
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
        vscode.window.showInformationMessage('LMS: подсказки ИИ — в панели задачи.');
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
      text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — автор эталонных решений курса.', 90000, this.statementImages, { maxTokens: 1800, temperature: 0.15 });
      aiLog({ event: 'response', mode, raw: String(text).slice(0, 6000) });
      const sp = this.splitLesson(text);
      const m = /```(?:python)?\s*([\s\S]*?)```/i.exec(sp.text);
      let solution = (m ? m[1] : sp.text).replace(/^\s*```.*$/gm, '').trim();
      if (!solution) throw new Error('Модель вернула пустое решение.');
      // самопроверка: запрещённые конструкции курса + компиляция, до 2 попыток починки
      let leftProblems = [];
      if (cfg().get('ai.selfCheck') !== false) {
        for (let round = 0; round < 2; round++) {
          const v = await this.aiValidateCode(solution);
          leftProblems = v.problems;
          if (v.ok) break;
          aiLog({ event: 'selfcheck', round: round + 1, problems: v.problems });
          const fixed = await this.aiRepairCode(solution, v.problems, statement);
          if (!fixed || fixed === solution) break;
          solution = fixed;
        }
        const finalCheck = await this.aiValidateCode(solution);
        leftProblems = finalCheck.problems;
      }
      if (sp.lesson) await this.aiRememberLesson(sp.lesson);
      await this.aiFileWrite(solution + '\n');
      this.aiHints = 'Решение от ИИ вставлено в файл:\n\n```python\n' + solution + '\n```' +
        (leftProblems.length ? '\n\n⚠ Не удалось убрать: ' + leftProblems.join('; ') : '');
      this.output().appendLine('=== AI: решение ===\n' + solution);
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
      vscode.window.showInformationMessage('LMS: решение ИИ вставлено в файл (Ctrl+Z — отменить).');
    } catch (e) {
      aiLog({ event: 'error', mode, error: String(e.message || e) });
      vscode.window.showErrorMessage('LMS: ИИ: ' + (e.message || e));
      this.output().appendLine('AI error: ' + (e.message || e));
      return;
    }
  }

  async aiClear() {
    const t = this.currentTask;
    let clearedPanel = false;
    if (this.aiHints || this.aiNote) {
      this.aiHints = null;
    this.pep8Report = null;
    this.aiNote = null;
    this.aiHints = null;
    this.webviewBroken = false;
    this.panelRetries = 0;
      clearedPanel = true;
    }
    if (!t || !t.filePath) {
      if (clearedPanel) {
        await this.showTaskPanel(this.detailCache.get(String(t && t.taskId)) || { title: t && t.taskTitle }, null);
        vscode.window.showInformationMessage('LMS: подсказки ИИ очищены.');
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
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
        vscode.window.showInformationMessage('LMS: подсказки ИИ очищены.');
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
      await this.aiFileWrite(out.join('\n'));
      vscode.window.showInformationMessage('LMS: подсказки ИИ удалены (Ctrl+Z — отменить).');
    } catch (e) {
      vscode.window.showErrorMessage('LMS: не удалось очистить подсказки: ' + (e.message || e));
    }
  }

  async aiPickModel(def, entry) {
    const conf = cfg();
    const current = (entry && entry.model) || conf.get('ai.model') || (def && def.model) || '';
    const models = await aiListModels(entry);
    const items = [];
    if (current) items.push({ label: current, description: 'текущая модель' });
    for (const m of models) {
      if (m === current) continue;
      items.push({ label: m, description: /:free$/.test(m) ? 'free (может стоять в очереди)' : '' });
    }
    items.push({ label: '✏️ Ввести модель вручную…', description: '' });
    if (!items.length) {
      const manual = await vscode.window.showInputBox({ prompt: 'Модель', value: current, ignoreFocusOut: true });
      return manual;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Выберите модель' + (models.length ? ' (доступно: ' + models.length + ')' : ''),
      matchOnDescription: true
    });
    if (!picked) return undefined;
    if (picked.label === '✏️ Ввести модель вручную…') {
      const manual = await vscode.window.showInputBox({ prompt: 'Модель', value: current, ignoreFocusOut: true });
      return manual;
    }
    return picked.label;
  }

  aiStatusText() {
    const list = aiEntries();
    if (!list.length) return 'не настроен';
    const active = list.find(e => e.id === AI_POOL_ACTIVE) || list[0];
    const idx = list.indexOf(active) + 1;
    return (active.label || active.provider) + ' · ' + active.model + ' · ключ ' + aiKeyTail(active.apiKey) +
      (list.length > 1 ? ' (' + idx + ' из ' + list.length + ')' : '');
  }

  async aiValidateCode(code) {
    const problems = aiLint(code);
    const file = path.join(os.tmpdir(), 'yandex-lms-ai-check.py');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, code, 'utf8');
      const python = cfg().get('pythonPath') || 'python';
      const res = await this.runProcess(python, ['-m', 'py_compile', file], 15000);
      if (res.code !== 0) {
        const out = String(res.out || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        if (out && !/no module named|не найден|is not recognized|not found/i.test(out)) {
          problems.push('не компилируется: ' + out.slice(0, 200));
        }
      }
    } catch (e) { }
    return { ok: !problems.length, problems };
  }

  async aiRepairCode(code, problems, statement) {
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
  }

  async aiTestEntry(entry) {
    entry = Object.assign({}, entry, { id: aiEntryId(entry) });
    const t0 = Date.now();
    try {
      const res = await aiChatOnce(entry, 'Ответь одним словом: работает?', 'Отвечай кратко.', 30000, null, { maxTokens: 20, temperature: 0 }, new AbortController());
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      aiMarkOk(entry, Date.now() - t0);
      this.output().appendLine('AI: ' + aiEntryLabel(entry) + ' [' + aiKeyTail(entry.apiKey) + '] — ок за ' + s + ' с: ' + res.text.slice(0, 60));
      vscode.window.showInformationMessage('LMS: ' + aiEntryLabel(entry) + ' — работает, ' + s + ' с.');
      return true;
    } catch (e) {
      aiMarkFail(entry, e);
      const msg = String((e && e.message) || e).slice(0, 200);
      this.output().appendLine('AI: ' + aiEntryLabel(entry) + ' — ошибка: ' + msg);
      vscode.window.showWarningMessage('LMS: ' + aiEntryLabel(entry) + ' — ' + msg);
      return false;
    }
  }

  async aiTest() {
    const list = aiEntries();
    if (!list.length) {
      vscode.window.showWarningMessage('LMS: ИИ не настроен — добавьте ключ.');
      return;
    }
    const lines = [];
    for (const e of list) {
      const t0 = Date.now();
      try {
        const res = await aiChatOnce(e, 'Ответь одним словом: работает?', 'Отвечай кратко.', 30000, null, { maxTokens: 20, temperature: 0 }, new AbortController());
        const ms = Date.now() - t0;
        aiMarkOk(e, ms);
        lines.push('✓ ' + aiEntryLabel(e) + ' [' + aiKeyTail(e.apiKey) + '] — ' + (ms / 1000).toFixed(1) + ' с: ' + res.text.slice(0, 40));
      } catch (err) {
        aiMarkFail(e, err);
        lines.push('✗ ' + aiEntryLabel(e) + ' [' + aiKeyTail(e.apiKey) + '] — ' + String((err && err.message) || err).slice(0, 160));
      }
    }
    this.output().appendLine('=== AI: проверка ключей ===\n' + lines.join('\n'));
    const okCount = lines.filter(l => l.startsWith('✓')).length;
    vscode.window.showInformationMessage('LMS: ИИ — работает ключей ' + okCount + ' из ' + list.length + '. Подробности в выводе «LMS».');
    await this.refreshAiPanel();
  }

  async refreshAiPanel() {
    if (!this.currentTask) return;
    try {
      await this.showTaskPanel(this.detailCache.get(String(this.currentTask.taskId)) || { title: this.currentTask.taskTitle }, null);
    } catch (e) { }
  }

  async aiSettingsUI() {
    const list = aiEntries();
    const items = [
      { label: '$(key) Ключи и провайдеры', description: list.length ? list.length + ' · ротация по лимитам' : 'не настроено', action: 'keys' },
      { label: '$(beaker) Проверить все ключи', description: 'замер времени ответа', action: 'test' },
      { label: '$(symbol-parameter) Сменить модель', description: list[0] ? list[0].model : '', action: 'model' },
      { label: '$(gear) Быстрая настройка одного провайдера', description: 'провайдер + ключ + модель', action: 'legacy' },
      { label: '$(sparkle) Автодополнение в редакторе', description: cfg().get('ai.autocomplete') ? 'включено — нажмите, чтобы выключить' : 'выключено — нажмите, чтобы включить', action: 'autocomplete' },
      { label: '$(check) Самопроверка кода перед вставкой', description: cfg().get('ai.selfCheck') !== false ? 'включена — нажмите, чтобы выключить' : 'выключена — нажмите, чтобы включить', action: 'selfcheck' },
      { label: '$(rocket) Ускорение: второй ключ параллельно', description: cfg().get('ai.hedge') !== false ? 'включено — нажмите, чтобы выключить' : 'выключено — нажмите, чтобы включить', action: 'hedge' },
      { label: '$(debug-restart) Сбросить состояние лимитов', description: 'снова пробовать все ключи', action: 'reset' },
      { label: '$(history) Забыть накопленные ошибки', description: 'память о граблях ученика', action: 'forget' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'ИИ: настройки и ключи', ignoreFocusOut: true });
    if (!picked) return;
    const conf = cfg();
    if (picked.action === 'keys') return this.aiKeysUI();
    if (picked.action === 'test') return this.aiTest();
    if (picked.action === 'legacy') return this.aiLegacySettingsUI();
    if (picked.action === 'forget') return vscode.commands.executeCommand('yandexLms.aiForget');
    if (picked.action === 'reset') {
      AI_POOL_STATE = {};
      aiPersistSoon();
      vscode.window.showInformationMessage('LMS: состояние лимитов сброшено — все ключи снова доступны.');
      return this.refreshAiPanel();
    }
    if (picked.action === 'autocomplete' || picked.action === 'selfcheck' || picked.action === 'hedge') {
      const key = picked.action === 'autocomplete' ? 'ai.autocomplete' : (picked.action === 'selfcheck' ? 'ai.selfCheck' : 'ai.hedge');
      const cur = picked.action === 'autocomplete' ? !!conf.get(key) : conf.get(key) !== false;
      await conf.update(key, !cur, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('LMS: ' + picked.label.replace(/^\$\([^)]+\)\s*/, '') + ' — ' + (!cur ? 'включено' : 'выключено') + '.');
      return this.refreshAiPanel();
    }
    if (picked.action === 'model') {
      const target = list.length > 1
        ? await vscode.window.showQuickPick(list.map(e => ({ label: aiEntryLabel(e), entry: e })), { placeHolder: 'Ключ, которому менять модель' })
        : (list[0] ? { entry: list[0] } : null);
      if (!target) return;
      const model = await this.aiPickModel({ model: target.entry.model }, target.entry);
      if (!model) return;
      const idx = AI_POOL.findIndex(e => aiEntryId(e) === target.entry.id);
      if (idx >= 0) AI_POOL[idx].model = model;
      else AI_POOL.push(Object.assign({}, target.entry, { model }));
      aiPersistSoon();
      vscode.window.showInformationMessage('LMS: модель — ' + model + '.');
      return this.refreshAiPanel();
    }
  }

  async aiKeysUI() {
    for (;;) {
      const list = aiEntries();
      const items = [
        { label: '$(add) Добавить ключ или провайдера', description: 'ещё один API для ротации', action: 'add' },
        { label: '$(beaker) Проверить все ключи', description: list.length ? String(list.length) : '', action: 'test' },
        { label: '$(debug-restart) Сбросить лимиты', description: '', action: 'reset' },
        { label: '$(gear) Обычные настройки', description: '', action: 'settings' }
      ];
      for (const e of list) {
        const cd = aiCooldownLeft(e);
        const st = AI_POOL_STATE[e.id] || {};
        items.push({
          label: '$(key) ' + aiEntryLabel(e) + (e.id === AI_POOL_ACTIVE ? '  ⭐' : ''),
          description: aiKeyTail(e.apiKey) + (cd ? ' · лимит ещё ' + Math.ceil(cd / 60000) + ' мин' : (st.ms ? ' · ' + (st.ms / 1000).toFixed(1) + ' с' : '')),
          detail: cd ? (st.lastError || 'временно недоступен') : 'готов',
          action: 'entry',
          entry: e
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'ИИ: ключи и провайдеры — выберите ключ для действий',
        matchOnDescription: true,
        ignoreFocusOut: true
      });
      if (!picked) return;
      if (picked.action === 'add') { await this.aiAddKey(); continue; }
      if (picked.action === 'test') { await this.aiTest(); continue; }
      if (picked.action === 'reset') {
        AI_POOL_STATE = {};
        aiPersistSoon();
        vscode.window.showInformationMessage('LMS: лимиты сброшены.');
        continue;
      }
      if (picked.action === 'settings') { await this.aiSettingsUI(); continue; }
      if (picked.action === 'entry') { await this.aiKeyActions(picked.entry); continue; }
      return;
    }
  }

  async aiKeyActions(entry) {
    const items = [
      { label: '$(star) Сделать основным', description: 'пробовать первым', action: 'primary' },
      { label: '$(beaker) Проверить этот ключ', description: '', action: 'test' },
      { label: '$(edit) Заменить ключ', description: aiKeyTail(entry.apiKey), action: 'key' },
      { label: '$(symbol-parameter) Сменить модель', description: entry.model, action: 'model' },
      { label: '$(trash) Удалить', description: '', action: 'delete' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: aiEntryLabel(entry), ignoreFocusOut: true });
    if (!picked) return;
    const idx = AI_POOL.findIndex(e => aiEntryId(e) === entry.id);
    if (picked.action === 'primary') {
      AI_POOL_ACTIVE = entry.id;
      if (idx > 0) AI_POOL.unshift(AI_POOL.splice(idx, 1)[0]);
      aiPersistSoon();
      vscode.window.showInformationMessage('LMS: основной ключ — ' + aiEntryLabel(entry) + '.');
    } else if (picked.action === 'test') {
      await this.aiTestEntry(entry);
    } else if (picked.action === 'key') {
      const key = await vscode.window.showInputBox({ prompt: 'Новый API-ключ для ' + aiEntryLabel(entry), password: true, ignoreFocusOut: true });
      if (!key) return;
      const next = Object.assign({}, entry, { apiKey: key.trim() });
      if (idx >= 0) AI_POOL[idx] = next;
      else AI_POOL.push(next);
      delete AI_POOL_STATE[entry.id];
      aiPersistSoon();
      await this.aiTestEntry(next);
    } else if (picked.action === 'model') {
      const model = await this.aiPickModel({ model: entry.model }, entry);
      if (!model) return;
      if (idx >= 0) AI_POOL[idx].model = model;
      else AI_POOL.push(Object.assign({}, entry, { model }));
      aiPersistSoon();
    } else if (picked.action === 'delete') {
      const ok = await vscode.window.showWarningMessage('Удалить ключ ' + aiEntryLabel(entry) + '?', { modal: true }, 'Удалить');
      if (ok !== 'Удалить') return;
      AI_POOL = AI_POOL.filter(e => aiEntryId(e) !== entry.id);
      delete AI_POOL_STATE[entry.id];
      aiPersistSoon();
    }
    await this.refreshAiPanel();
  }

  async aiAddKey() {
    aiPoolEnsureSeed();
    const items = Object.keys(AI_PROVIDERS).filter(k => k !== 'none').map(k => ({
      label: AI_PROVIDERS[k].label,
      description: k,
      detail: AI_PROVIDERS[k].baseUrl || 'адрес указывается вручную'
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Провайдер нового ключа', ignoreFocusOut: true });
    if (!picked) return;
    const provider = picked.description;
    const def = AI_PROVIDERS[provider] || {};
    const key = await vscode.window.showInputBox({
      prompt: provider === 'ollama' ? 'API-ключ (можно пустой для локальной модели)' : 'API-ключ ' + def.label,
      password: true,
      ignoreFocusOut: true
    });
    if (key === undefined) return;
    const draft = { provider, baseUrl: def.baseUrl || '', model: def.model || '', apiKey: key.trim(), label: def.label };
    if (provider === 'custom' || !def.baseUrl) {
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Базовый URL API (например https://openrouter.ai/api/v1)',
        value: draft.baseUrl,
        ignoreFocusOut: true
      });
      if (!baseUrl) return;
      draft.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    }
    const model = await this.aiPickModel({ model: draft.model }, draft);
    if (!model) return;
    draft.model = model;
    AI_POOL.push(draft);
    aiPersistSoon();
    await this.aiTestEntry(draft);
    await this.refreshAiPanel();
  }

  async aiLegacySettingsUI() {
    const items = Object.keys(AI_PROVIDERS).map(k => ({
      label: k === 'none' ? 'Выключено' : AI_PROVIDERS[k].label,
      description: k,
      detail: AI_PROVIDERS[k].baseUrl || 'адрес указывается вручную'
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Выберите провайдера ИИ', ignoreFocusOut: true });
    if (!picked) return;
    const provider = picked.description;
    const conf = cfg();
    await conf.update('ai.provider', provider, vscode.ConfigurationTarget.Global);
    const def = AI_PROVIDERS[provider] || AI_PROVIDERS.none;
    if (provider !== 'none') {
      const key = await vscode.window.showInputBox({
        prompt: 'API-ключ (оставьте пустым для локальной модели)',
        password: true,
        value: conf.get('ai.apiKey') || '',
        ignoreFocusOut: true
      });
      if (key === undefined) return;
      await conf.update('ai.apiKey', key, vscode.ConfigurationTarget.Global);
      const model = await this.aiPickModel(def);
      if (model === undefined) return;
      await conf.update('ai.model', model, vscode.ConfigurationTarget.Global);
      if (provider === 'custom' || !def.baseUrl) {
        const baseUrl = await vscode.window.showInputBox({
          prompt: 'Базовый URL API (например https://api.example.com/v1)',
          value: conf.get('ai.baseUrl') || '',
          ignoreFocusOut: true
        });
        if (baseUrl === undefined) return;
        await conf.update('ai.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
      }
    }
    AI_POOL = [];
    aiPoolEnsureSeed();
    aiPersistSoon();
    const c = aiConfig();
    vscode.window.showInformationMessage('LMS: провайдер ИИ — ' + c.label + ' (' + c.model + ').');
    await this.refreshAiPanel();
  }

  viewDir() {
    const t = this.currentTask;
    const id = (t && t.taskId) || 'task';
    const d = path.join(os.tmpdir(), 'yandex-lms-view', String(id));
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
    return d;
  }

  saveImages(text) {
    // data-URI картинки сохраняем файлами рядом с .md — так preview VS Code их точно покажет
    if (!text || !/data:image\/[a-z+]+;base64,/i.test(text)) return text;
    const dir = this.viewDir();
    let n = 0;
    return String(text).replace(/data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)/gi, (m, ext, b64) => {
      n++;
      const name = 'img' + n + '.' + (ext === 'jpeg' ? 'jpg' : ext);
      try {
        fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
      } catch (e) { }
      return name;
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
    if (this.aiHints) {
      L.push('');
      L.push('## Подсказки ИИ');
      L.push('');
      L.push(this.aiHints);
    }
    if (this.aiNote) {
      L.push('');
      L.push('## Проверка ИИ');
      L.push('');
      L.push(this.aiNote);
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
          if (uri && uri.scheme === 'lms') {
            await vscode.window.tabGroups.close(tab, true);
          }
          if (uri && uri.scheme === 'file' && /yandex-lms-view/i.test(uri.fsPath)) {
            await vscode.window.tabGroups.close(tab, true);
          }
        }
      }
    } catch (e) { }
  }

  async showTaskDoc(withPreview) {
    const t = this.currentTask;
    if (!t) return;
    const dir = this.viewDir();
    const title = (t.taskTitle || 'Задание') + ' (' + t.taskId + ')';
    let text = this.buildTaskDocText(null);
    text = this.saveImages(text);
    const mdPath = path.join(dir, 'условие.md');
    try { fs.writeFileSync(mdPath, text, 'utf8'); } catch (e) { }
    const uri = vscode.Uri.file(mdPath);
    this.taskDocUri = uri;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
      await sleep(400);
      try { await vscode.commands.executeCommand('markdown.showPreview', uri); } catch (e) { }
    } catch (e) {
      this.output().appendLine('Не удалось открыть условие: ' + (e.message || e));
    }
    this.updateTaskStatusBar();
  }

  createTaskPanel(t) {
    // Все опции — в конструкторе, html — сразу после. Любая смена options или
    // отложенная установка html пересоздаёт iframe и срывает регистрацию
    // service worker («InvalidStateError: The document is in an invalid state»).
    // retainContextWhenHidden не даёт Chromium выгрузить документ в фоне.
    // Уникальный viewType на каждую панель: повторное создание webview с тем же
    // viewType после закрытия предыдущего срывает регистрацию service worker.
    const viewType = 'yandexLmsTask' + Date.now().toString(36);
    const panel = vscode.window.createWebviewPanel(viewType, t.taskTitle, { viewColumn: vscode.ViewColumn.One, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      disableServiceWorker: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    this.attachPanel(panel);
    return panel;
  }

  watchPanelReady(t, detail, serverCode) {
    const panel = this.panel;
    const st = webviewState.get(panel);
    if (!st) return;
    let attempt = 0;
    const check = async () => {
      if (this.panel !== panel || st.ready) return;
      attempt++;
      webviewLog('panel-not-ready', { attempt });
      // Лечим гонку service worker: перезагружаем документ ВНУТРИ того же
      // webview (новый html), не создавая панель заново.
      if (attempt <= 2) {
        const html = st.last;
        try {
          if (html) panel.webview.html = html.replace('</body>', '<!-- reload ' + attempt + ' --></body>');
        } catch (e) { webviewLog('panel-reload-error', { error: String(e.message || e) }); }
        setTimeout(check, 4000);
        return;
      }
      this.panelRetries = (this.panelRetries || 0) + 1;
      try { this.context.globalState.update('yandexLms.swBroken', true); } catch (e) { }
      // Панель не поднялась даже после перезагрузок — показываем условие текстом.
      this.webviewBroken = true;
      try { panel.dispose(); } catch (e) { }
      if (this.panel === panel) this.panel = null;
      await this.showTaskDoc(true);
      const again = await vscode.window.showInformationMessage(
        'LMS: VS Code не смог загрузить webview-панель (service worker). Условие показано текстом.',
        'Ещё раз',
        'Починить webview'
      );
      if (again === 'Ещё раз') {
        this.webviewBroken = false;
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, serverCode);
      } else if (again === 'Починить webview') {
        await vscode.commands.executeCommand('yandexLms.fixWebviewProfile');
      }
    };
    setTimeout(check, 5000);
  }

  async openPanel(t, detail, serverCode) {
    const panel = this.createTaskPanel(t);
    this.panel = panel;
    try { assignWebviewHtml(panel, this.taskHtml(t, detail, serverCode)); } catch (e) { }
    this.watchPanelReady(t, detail, serverCode);
  }

  async showTaskPanel(detail, serverCode) {
    const t = this.currentTask;
    if (!t) return;
    const mode = String(cfg().get('taskView') || 'panel');
    if (mode === 'text') {
      await this.showTaskDoc(false);
      return;
    }
    // старое окно условия (текстовое) закрываем — оно нам не нужно, если панель работает
    if (!this.webviewBroken) await this.closeLmsDocTabs();
    if (this.webviewBroken) {
      await this.showTaskDoc();
      return;
    }
    if (!this.panel) {
      await this.openPanel(t, detail, serverCode);
      return;
    }
    this.panel.title = t.taskTitle;
    assignWebviewHtml(this.panel, this.taskHtml(t, detail, serverCode));
  }

  async closeLmsDocTabs() {
    try {
      if (!vscode.window.tabGroups || !vscode.window.tabGroups.all) return;
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs.slice()) {
          const inp = tab.input;
          const uri = inp && inp.uri;
          if (uri && uri.scheme === 'lms') {
            await vscode.window.tabGroups.close(tab, true);
          }
        }
      }
    } catch (e) { }
  }

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
      { label: '$(play) Отправить решение', cmd: 'yandexLms.submit' },
      { label: '$(sync) Обновить статус', cmd: 'yandexLms.refreshStatus' },
      { label: '$(sparkle) AI: подсказки (вставить в код)', cmd: 'yandexLms.aiHints' },
      { label: '$(check) AI: проверить решение', cmd: 'yandexLms.aiCheck' },
      { label: '$(wand) AI: решение задачи', cmd: 'yandexLms.aiSolve' },
      { label: '$(clear-all) Очистить подсказки ИИ', cmd: 'yandexLms.aiClear' },
      { label: '$(gear) AI: настройки провайдера', cmd: 'yandexLms.aiSettings' },
      { label: '$(cloud-download) Забрать решение из LMS', cmd: 'yandexLms.pullSolution' },
      { label: '$(link-external) Открыть в браузере', cmd: 'yandexLms.openInBrowser' }
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Задание: ' + (t.taskTitle || '') });
    if (!picked) return;
    await vscode.commands.executeCommand(picked.cmd);
  }

  contestLogsData() {
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
      this.lastSubmissionId = sid;
      await this.aiLearnFromLogs(data);
      return data;
    } catch (e) { return null; }
  }

  async aiLearnFromLogs(data) {
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
    return '<div class="details"><div class="ai-title">Подробности проверки</div>' + rows.join('') + '</div>';
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

  async aiFix() {
    const t = this.currentTask;
    if (!t) {
      vscode.window.showWarningMessage('LMS: сначала откройте задание.');
      return;
    }
    if (!aiHasConfig()) {
      const go = await vscode.window.showInformationMessage('ИИ не настроен. Добавить провайдера и ключ сейчас?', 'Настроить');
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
    vscode.window.showInformationMessage('LMS: ИИ разбирает ошибку...');
    let text = '';
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
        'Не объясняй ошибку в посте — просто дай рабочий код.\n' +
        'В конце ответа (после блока кода) добавь строку: УРОК: <одно предложение — в чём была ошибка и как её избежать в следующий раз>.\n' +
        'Ответь ТОЛЬКО кодом в одном блоке ```python ... ``` и этой строкой.';
      text = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — автор эталонных решений курса, исправляешь решения учеников.', 90000, this.statementImages, { maxTokens: 1800, temperature: 0.15 });
      aiLog({ event: 'ai-fix-response', raw: String(text).slice(0, 4000) });
      const sp = this.splitLesson(text);
      const mm = /```(?:python)?\s*([\s\S]*?)```/i.exec(sp.text);
      let fixed = (mm ? mm[1] : sp.text).replace(/^\s*```.*$/gm, '').trim();
      if (!fixed) throw new Error('Модель вернула пустой код.');
      if (cfg().get('ai.selfCheck') !== false) {
        for (let round = 0; round < 2; round++) {
          const v = await this.aiValidateCode(fixed);
          if (v.ok) break;
          aiLog({ event: 'fix-selfcheck', round: round + 1, problems: v.problems });
          const again = await this.aiRepairCode(fixed, v.problems, statement);
          if (!again || again === fixed) break;
          fixed = again;
        }
      }
      await this.aiFileWrite(fixed + '\n');
      if (sp.lesson) await this.aiRememberLesson(sp.lesson);
      this.aiHints = 'ИИ исправил код по ошибке проверки. Новый код — в файле.';
      this.output().appendLine('=== AI: исправление ===\n' + fixed);
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
      vscode.window.showInformationMessage('LMS: исправленный код записан в файл (Ctrl+Z — отменить).');
    } catch (e) {
      aiLog({ event: 'ai-fix-error', error: String(e.message || e) });
      vscode.window.showErrorMessage('LMS: ИИ: ' + (e.message || e));
    }
  }

  aiLessonsList() {
    if (!this.aiLessons) {
      try { this.aiLessons = this.context.globalState.get('yandexLms.aiLessons', []) || []; } catch (e) { this.aiLessons = []; }
    }
    return this.aiLessons;
  }

  aiLessonsText() {
    const list = this.aiLessonsList();
    if (!list.length) return '';
    return 'ЧТО УЖЕ НАСТУПАЛО НА ГРАБЛИ (не повторяй эти ошибки, ученик их уже проходил):\n' +
      list.slice(-25).map(x => '- ' + x).join('\n') + '\n\n';
  }

  async aiRememberLesson(text) {
    if (!text) return;
    const s = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!s || /^нет$/i.test(s)) return;
    const list = this.aiLessonsList();
    if (list.some(x => x.toLowerCase() === s.toLowerCase())) return;
    list.push(s);
    while (list.length > 60) list.shift();
    this.aiLessons = list;
    try { await this.context.globalState.update('yandexLms.aiLessons', list); } catch (e) { }
  }

  splitLesson(text) {
    const s = String(text || '');
    const m = /^[ \t]*(?:\*\*)?УРОК(?:\*\*)?[ \t]*:[ \t]*(.+)$/mi.exec(s);
    if (!m) return { text: s, lesson: null };
    const lesson = m[1].trim();
    const cleaned = s.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleaned, lesson };
  }

  async aiLessonsHtml() {
    const list = this.aiLessonsList();
    if (!list.length) return '';
    const items = list.slice(-12).map(x => '<li>' + escapeHtml(x) + '</li>').join('');
    return '<div class="details lessons"><div class="ai-title">На какие грабли уже наступали</div><ul>' + items + '</ul></div>';
  }

  isMarkersTask(detail) {
    if (!detail) return false;
    const tt = String(pick(detail, 'taskType') || '');
    const cp = String(pick(detail, 'contestProblemType') || '');
    return tt === 'schoolbook_markers' || cp === 'TEXT_ANSWER_PROBLEM';
  }

  async fetchProblemDefinition(t) {
    const dir = this.diagDir();
    const tries = [];
    const sid = t && t.solutionId;
    const tid = t && t.taskId;
    const gid = t && t.groupId;
    const cand = [];
    if (sid) {
      cand.push({ m: 'GET', u: `/api/proxy/problems/solution/${sid}` });
      cand.push({ m: 'GET', u: `/api/problems/solution/${sid}` });
      cand.push({ m: 'GET', u: `/api/student/problems/solution/${sid}` });
    }
    if (tid) {
      cand.push({ m: 'POST', u: '/api/student/problems/solution/', body: { problem_id: tid } });
      cand.push({ m: 'POST', u: '/api/proxy/student/problems/solution/', body: { problem_id: tid } });
      if (gid) cand.push({ m: 'GET', u: `/api/student/tasks/${tid}?groupId=${gid}` });
    }
    for (const c of cand) {
      try {
        const opts = c.m === 'POST'
          ? { headers: Object.assign(this.client.apiHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify(c.body) }
          : { headers: this.client.apiHeaders() };
        const res = await this.client.raw(c.m, this.client.base + c.u, opts);
        const text = await res.text();
        tries.push({ m: c.m, u: c.u, status: res.status, head: text.slice(0, 300) });
        if (res.status === 200 && text) {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { }
          const pd = json ? (pick(json, 'problemDefinition') || pick(json, 'problem') || json) : null;
          const hasContent = pd && (pick(pd, 'markup') || pick(pd, 'markers') || pick(pd, 'layout'));
          if (hasContent) {
            try { fs.writeFileSync(path.join(dir, 'problem-definition.json'), JSON.stringify(json, null, 2), 'utf8'); } catch (e) { }
            return { data: json, problem: pd, source: c.u, tries };
          }
          if (json) {
            try { fs.writeFileSync(path.join(dir, 'problem-definition.json'), JSON.stringify(json, null, 2), 'utf8'); } catch (e) { }
            return { data: json, problem: pd, source: c.u, tries };
          }
        }
      } catch (e) {
        tries.push({ m: c.m, u: c.u, error: String(e.message || e) });
      }
    }
    try { fs.writeFileSync(path.join(dir, 'problem-tries.json'), JSON.stringify(tries, null, 2), 'utf8'); } catch (e) { }
    return { data: null, problem: null, source: null, tries };
  }

  markersBlocks(problem) {
    if (!problem) return [];
    const sc = pick(problem, 'storeContainer');
    const mk = sc ? pick(sc, 'markers') : null;
    if (mk) {
      const layout = pick(mk, 'layout');
      if (Array.isArray(layout)) return layout;
    }
    const blocks = (pick(problem, 'markup') && pick(pick(problem, 'markup'), 'layout')) || pick(problem, 'layout') || [];
    return Array.isArray(blocks) ? blocks : [];
  }

  markersMap(problem) {
    if (!problem) return {};
    const m = pick(problem, 'markers') || pick(problem, 'markerDefs') || {};
    return (m && typeof m === 'object') ? m : {};
  }

  markerOptions(marker) {
    if (!marker) return [];
    const c = pick(marker, 'content') || marker;
    const o = pick(c, 'options');
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const choices = pick(o, 'choices', 'options', 'variants');
      if (Array.isArray(choices)) {
        return choices.map((ch, i) => {
          if (ch && typeof ch === 'object') {
            const val = pick(ch, 'value', 'id') !== undefined ? pick(ch, 'value', 'id') : i;
            const label = pick(ch, 'text', 'title', 'label') !== undefined ? pick(ch, 'text', 'title', 'label') : String(val);
            return { value: String(val), label: String(label) };
          }
          return { value: String(i), label: String(ch) };
        });
      }
      return [];
    }
    const opts = Array.isArray(o) ? o : (pick(c, 'options', 'variants', 'values', 'answers') || []);
    if (Array.isArray(opts)) {
      return opts.map((x, i) => {
        if (x && typeof x === 'object') {
          const val = pick(x, 'value', 'id') !== undefined ? pick(x, 'value', 'id') : i;
          const label = pick(x, 'text', 'title', 'label', 'content') !== undefined ? pick(x, 'text', 'title', 'label', 'content') : String(val);
          return { value: String(val), label: String(label) };
        }
        return { value: String(x !== undefined && x !== null ? x : i), label: String(x) };
      });
    }
    if (opts && typeof opts === 'object') {
      return Object.keys(opts).map(k => ({ value: String(k), label: String(opts[k]) }));
    }
    return [];
  }

  markersPanelHtml() {
    const t = this.currentTask;
    if (!t || !t.isMarkers) return '';
    const problem = t.problemDefinition || null;
    const blocks = this.markersBlocks(problem);
    const map = this.markersMap(problem);
    const out = [];
    out.push('<div class="markers-question">');
    // описание задачи (там могут быть картинки и текст) — показываем первым
    const desc = this.currentStatementHtml || '';
    if (desc && desc.trim()) {
      const clean = desc.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
      out.push('<div class="marker-text">' + clean + '</div>');
    }
    if (blocks.length) {
      for (const b of blocks) {
        const kind = pick(b, 'kind');
        const content = pick(b, 'content') || {};
        if (kind === 'text' || pick(content, 'text')) {
          const raw = String(pick(content, 'text') || '');
          if (/<[a-z][\s\S]*>/i.test(raw)) {
            const inlined = this.inlinedText && this.inlinedText.get(String(pick(content, 'text'))) || raw;
            const html = inlined.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
            out.push('<div class="marker-text">' + html + '</div>');
          } else {
            out.push('<div class="marker-text"><pre>' + escapeHtml(raw) + '</pre></div>');
          }
          continue;
        }
        const id = pick(content, 'id');
        const marker = (id !== undefined && map[id]) ? map[id] : content;
        const opts = this.markerOptions(marker);
        const type = String(pick(marker, 'type') || 'radio');
        if (!opts.length) continue;
        out.push('<div class="marker-options" data-marker="' + escapeHtml(String(id !== undefined ? id : '')) + '">');
        if (type === 'checkbox') {
          for (const o of opts) {
            out.push('<label class="opt"><input type="checkbox" data-marker="' + escapeHtml(String(id !== undefined ? id : '')) + '" value="' + escapeHtml(o.value) + '"> <span>' + escapeHtml(o.label) + '</span></label>');
          }
        } else {
          for (const o of opts) {
            out.push('<label class="opt"><input type="radio" name="m' + escapeHtml(String(id !== undefined ? id : '')) + '" data-marker="' + escapeHtml(String(id !== undefined ? id : '')) + '" value="' + escapeHtml(o.value) + '"> <span>' + escapeHtml(o.label) + '</span></label>');
          }
        }
        out.push('</div>');
      }
    } else {
      const desc = t.markersQuestion || '';
      out.push(desc ? '<div class="marker-text">' + desc + '</div>' : '<p>Условие с вариантами ответа не пришло от API. Откройте задание в браузере.</p>');
    }
    out.push('</div>');
    out.push('<div class="actions ai-row"><button data-act="markersSubmit">Ответить</button><button data-act="aiAnswer" class="secondary">AI: выбрать ответ</button></div>');
    return out.join('\n');
  }

  async markersAnswer(answer) {
    const t = this.currentTask;
    if (!t || !t.solutionId) {
      vscode.window.showWarningMessage('LMS: у задания нет решения на сервере.');
      return;
    }
    const payload = JSON.stringify(answer);
    const urls = [
      `/api/student/solutions/${t.solutionId}/attempt`,
      `/api/proxy/student/solutions/${t.solutionId}/attempt`
    ];
    for (const u of urls) {
      try {
        const f = new FormData();
        f.append('file', new Blob([payload], { type: 'application/json' }), 'solution.json');
        const res = await this.client.raw('POST', this.client.base + u, { headers: this.client.apiHeaders(), body: f });
        const text = await res.text();
        this.logSubmit({ ts: new Date().toISOString(), label: 'markersAnswer', method: 'POST', url: u, status: res.status, req: payload, res: text.slice(0, 2000) });
        if (res.status >= 200 && res.status < 300) {
          vscode.window.showInformationMessage('LMS: ответ отправлен!');
          await this.reloadCurrentTask();
          return;
        }
        this.output().appendLine('markersAnswer ' + u + ' → ' + res.status + ' ' + text.slice(0, 200));
      } catch (e) {
        this.output().appendLine('markersAnswer error: ' + (e.message || e));
      }
    }
    vscode.window.showErrorMessage('LMS: не удалось отправить ответ.');
  }

  async aiChooseAnswer() {
    const t = this.currentTask;
    if (!t || !t.isMarkers) {
      vscode.window.showWarningMessage('LMS: это не задание с вариантами ответа.');
      return;
    }
    if (!aiHasConfig()) {
      const go = await vscode.window.showInformationMessage('ИИ не настроен. Добавить провайдера и ключ сейчас?', 'Настроить');
      if (go === 'Настроить') await this.aiKeysUI();
      return;
    }
    const question = t.markersQuestion || '';
    const opts = [];
    const problem = t.problemDefinition || null;
    const map = this.markersMap(problem);
    for (const b of this.markersBlocks(problem)) {
      const content = pick(b, 'content') || {};
      const id = pick(content, 'id');
      const marker = (id !== undefined && map[id]) ? map[id] : content;
      const o = this.markerOptions(marker);
      if (!o.length) continue;
      opts.push({ marker: id, options: o });
    }
    if (!opts.length) {
      vscode.window.showWarningMessage('LMS: варианты ответа не пришли от API.');
      return;
    }
    const questionText = question || (t.markersText || '');
    vscode.window.showInformationMessage('LMS: ИИ выбирает ответ...');
    try {
      const prompt =
        'Вопрос задания (курс «Программирование на Python»):\n' + questionText + '\n\n' +
        'Варианты ответа:\n' + opts.map((o, i) =>
          'Маркер ' + JSON.stringify(String(o.marker)) + ':\n' + o.options.map(x => '  - value=' + JSON.stringify(x.value) + ' | ' + x.label).join('\n')
        ).join('\n\n') +
        '\n' + this.aiLessonsText() +
        'Определи правильный вариант(ы). Ответь ТОЛЬКО JSON без пояснений: {"answers":{"<marker id>":"<value>"}}\n' +
        'Ученик прошёл только базовый курс (строки, циклы, условия) — считай результат вручную, как это делал бы новичок.';
      const raw = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — эксперт по основам Python и по заданиям этого курса.', 60000, this.statementImages, { maxTokens: 400, temperature: 0 });
      const m = /\{[\s\S]*\}/.exec(raw);
      const json = JSON.parse(m ? m[0] : raw);
      const answers = pick(json, 'answers') || json;
      if (!answers || typeof answers !== 'object') throw new Error('Модель не вернула ответы.');
      this.aiNote = 'ИИ выбрал: ' + JSON.stringify(answers);
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
      const choice = await vscode.window.showQuickPick(
        Object.keys(answers).map(k => ({ label: 'Отправить: ' + k + ' = ' + answers[k], value: answers[k], key: k })),
        { placeHolder: 'ИИ предлагает ответ — отправить?' }
      );
      if (!choice) return;
      const payload = {};
      payload[choice.key] = choice.value;
      await this.markersAnswer(payload);
    } catch (e) {
      vscode.window.showErrorMessage('LMS: ИИ: ' + (e.message || e));
    }
  }

  absUrl(src) {
    if (!src) return null;
    if (/^data:/i.test(src)) return null;
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith('/')) return this.client.base + src;
    return null;
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
        assets.html = assets.html.split(src).join(uri);
        assets.images.push(uri);
      } catch (e) { }
    }
    return assets;
  }

  async prepareStatement(detail) {
    const html = String(pick(detail, 'description', 'statement', 'content') || '');
    if (!html) return { html: '', images: [] };
    const assets = await this.inlineImages(html);
    if (assets.images.length) this.output().appendLine('LMS: загружено картинок в условии: ' + assets.images.length);
    return assets;
  }

  async scanImages() {
    const out = { ts: new Date().toISOString(), found: [], errors: [] };
    const all = [];
    try {
      if (!this.profileJson) await this.refreshProfile(true);
      const courses = this.courseList();
      try {
        fs.writeFileSync(path.join(this.diagDir(), 'scan-courses.json'), JSON.stringify({
          profileLoaded: !!this.profileJson,
          coursesSummaryKeys: this.profileJson ? Object.keys(this.profileJson) : [],
          courses: courses
        }, null, 2), 'utf8');
      } catch (e) { }
      for (const course of courses) {
        const cid = pick(course, 'id');
        const gid = pick(pick(course, 'group'), 'id') || pick(course, 'groupId') ||
          (Array.isArray(pick(course, 'groups')) && pick(course, 'groups').length ? pick(pick(course, 'groups')[0], 'id') : undefined);
        if (!cid) { out.errors.push({ error: 'курс без id' }); continue; }
        if (!gid) { out.errors.push({ error: 'у курса ' + cid + ' нет группы' }); continue; }
        const lr = await this.client.lessons(cid, gid);
        const lessons = asArray(lr.json, ['lessons', 'items', 'data', 'results', 'groups']) || [];
        for (const lesson of lessons) {
          const lid = pick(lesson, 'id');
          if (!lid) continue;
          const tr = await this.client.lessonTasks(cid, lid, gid);
          const groups = Array.isArray(tr.json) ? tr.json : (asArray(tr.json, ['tasks', 'items', 'data', 'results']) || []);
          for (const g of groups) {
            const tasks = pick(g, 'tasks') || pick(g, 'problems') || pick(g, 'items') || [];
            for (const t of tasks) {
              const tid = pick(t, 'id');
              if (!tid) continue;
              const det = await this.client.task(tid, gid);
              if (det.status !== 200 || !det.json) {
                out.errors.push({ taskId: tid, status: det.status });
                continue;
              }
              const html = String(pick(det.json, 'description', 'statement', 'content') || '');
              const sc = pick(det.json, 'storeContainer');
              const mk = sc ? pick(sc, 'markers') : null;
              const blocks = mk ? (pick(mk, 'layout') || []) : [];
              let markerHtml = '';
              for (const b of blocks) {
                const c = pick(b, 'content') || {};
                const txt = pick(c, 'text');
                if (txt) markerHtml += String(txt) + '\n';
              }
              const rec = {
                taskId: tid, title: pick(det.json, 'title'), lesson: pick(lesson, 'title'),
                isMarkers: this.isMarkersTask(det.json),
                description: html, markers: markerHtml,
                storeContainer: sc || null
              };
              all.push(rec);
              const imgs = [...(html + '\n' + markerHtml).matchAll(/<img[^>]*?src\s*=\s*["']([^"']+)["']/gi)].map(x => x[1]);
              if (imgs.length) out.found.push({ taskId: tid, title: rec.title, lesson: rec.lesson, isMarkers: rec.isMarkers, imgs });
            }
          }
        }
      }
    } catch (e) {
      out.errors.push({ error: String(e.message || e) });
    }
    try {
      fs.writeFileSync(path.join(this.diagDir(), 'images-scan.json'), JSON.stringify(out, null, 2), 'utf8');
      fs.writeFileSync(path.join(this.diagDir(), 'task-descriptions.json'), JSON.stringify(all, null, 2), 'utf8');
    } catch (e) { }
    this.output().appendLine('LMS: заданий с картинками: ' + out.found.length);
    for (const f of out.found) this.output().appendLine('  ' + f.taskId + ' ' + f.title + ' → ' + f.imgs.join(', '));
    vscode.window.showInformationMessage('LMS: заданий с картинками: ' + out.found.length + ' (отчёт в ' + path.join(this.diagDir(), 'images-scan.json') + ')');
    return out;
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

  async markersPickAndSend() {
    const t = this.currentTask;
    if (!t || !t.isMarkers) {
      vscode.window.showWarningMessage('LMS: это не задание с вариантами ответа.');
      return;
    }
    const problem = t.problemDefinition || null;
    const map = this.markersMap(problem);
    const items = [];
    for (const b of this.markersBlocks(problem)) {
      const content = pick(b, 'content') || {};
      const id = pick(content, 'id');
      const marker = (id !== undefined && map[id]) ? map[id] : content;
      const opts = this.markerOptions(marker);
      if (!opts.length) continue;
      opts.forEach((o, i) => items.push({ label: o.label, description: 'вариант ' + (i + 1), marker: id, value: o.value }));
    }
    if (!items.length) {
      vscode.window.showWarningMessage('LMS: варианты ответа не пришли от API — откройте задание в браузере.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Выберите ответ' });
    if (!picked) return;
    const payload = {};
    payload[String(picked.marker)] = picked.value;
    await this.markersAnswer(payload);
  }

  async taskDetail(t) {
    const id = t && t.taskId;    let detail = null;
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
      await this.showTaskPanel(await this.taskDetail(t), null);
      vscode.window.showInformationMessage('LMS: у задания ещё нет решения на сервере.');
      return;
    }
    const sol = await this.solutionState(t.solutionId);
    if (sol && sol.status === 200 && sol.json) {
      this.currentTask.verdictInfo = latestSubmissionOf(sol.json) || null;
      const detail = await this.taskDetail(t);
      await this.showTaskPanel(detail, null);
      vscode.window.showInformationMessage('LMS: статус — ' + this.verdictText(this.currentTask.verdictInfo));
    } else {
      vscode.window.showErrorMessage('LMS: не удалось получить решение (HTTP ' + (sol ? sol.status : 'ERR') + ')');
    }
  }

  async openCurrentInBrowser() {
    const t = this.currentTask;
    if (!t) return;
    const base = this.client.base;
    const url = t.taskUrl || `${base}/`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async saveActiveIfDirty() {
    try {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.isDirty) {
        await editor.document.save();
      }
    } catch (e) { }
  }

  async activeDocForTask(t) {
    const editor = vscode.window.activeTextEditor;
    if (editor && t && editor.document.uri.fsPath === t.filePath) return editor.document;
    if (t && fs.existsSync(t.filePath)) {
      return vscode.workspace.openTextDocument(t.filePath);
    }
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
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: отправляю решение…' }, async progress => {
      progress.report({ message: 'POST → checker' });
      const before = t.verdictInfo ? JSON.stringify(t.verdictInfo) : '';
      const out = await this.client.submitCandidates({
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
        this.output().appendLine('Успешная ручка: ' + out.result.text.slice(0, 500));
      }
      if (out.solutionId && out.solutionId !== t.solutionId) {
        t.solutionId = out.solutionId;
      }
      if (!out.result) {
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
          this.currentTask.verdictInfo = info;
          this.output().appendLine('  poll ' + sol.status + ' latestSubmission=' + String(now).slice(0, 300));
          if (info && now !== before && pick(info, 'verdict')) {
            break;
          }
        } else {
          this.output().appendLine('  poll ' + (sol ? sol.status : 'ERR') + ' ' + String((sol && sol.text) || '').slice(0, 200));
        }
      }
    });
    const info = this.currentTask.verdictInfo;
    const verdict = info ? pick(info, 'verdict') : null;
    if (verdict) {
      const st = pick(this.currentTask, 'verdictInfo');
      const v = st ? pick(st, 'verdict') : undefined;
      const bad = verdict !== 'OK';
      this.statusMap.set(String(t.taskId), { type: verdict === 'OK' ? 'accepted' : 'uploaded', verdict: v, badge: statusBadge(verdict === 'OK' ? 'accepted' : 'uploaded', v) });
      this.tree.refresh();
      this.updateTaskStatusBar();
      if (this.taskDocUri) this.docProvider.refresh(this.taskDocUri);
      if (bad) {
        // тянем подробности проверки, чтобы показать их и дать ИИ починить код
        await this.refreshContestLogs();
        await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
      }
    }
    if (verdict === 'OK') {
      vscode.window.showInformationMessage('LMS: решение зачтено!');
    } else if (verdict) {
      const msg = VERDICTS[verdict] || verdict;
      const choice = await vscode.window.showWarningMessage('LMS: ' + msg, 'Открыть подробности в Output');
      if (choice) {
        this.output().appendLine(attemptsLog.join('\n'));
        this.output().show(true);
      }
    } else {
      await this.probe('submit-no-verdict');
      const rep = await this.collectReport('submit-no-verdict');
      const last = (this.lastAttempts || []).slice(0, 3).map(a => a.status + ' ' + a.label).join(' | ');
      const choice = await vscode.window.showWarningMessage(
        'LMS: вердикт не пришёл. Попытки: ' + (last || 'нет') + '. Отчёт: ' + rep.file,
        'Показать лог', 'Открыть папку'
      );
      if (choice === 'Показать лог') this.output().show(true);
      if (choice === 'Открыть папку') await vscode.env.openExternal(vscode.Uri.file(rep.dir));
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
    if (direct && (direct.type || direct.verdict)) {
      this.statusMap.set(id, direct);
      return;
    }
    const sid = pick(task, 'solutionId', 'solution_id') || (pick(task, 'solution') && typeof pick(task, 'solution') === 'object' ? pick(pick(task, 'solution'), 'id') : undefined);
    if (!sid) return;
    try {
      const sol = await this.solutionState(sid);
      if (!sol || sol.status !== 200 || !sol.json) return;
      const st = pick(sol.json, 'status');
      const type = typeof st === 'string' ? st : pick(st, 'type') || '';
      const sub = pick(sol.json, 'latestSubmission', 'latest_submission');
      const verdict = sub ? pick(sub, 'verdict') : undefined;
      this.statusMap.set(id, { type, verdict, score: pick(sol.json, 'score'), badge: statusBadge(type, verdict) });
    } catch (e) { }
  }

  ensureStatuses(nodes) {
    if (this.statusBusy) return;
    const pending = (nodes || []).filter(n => n && n.task && !this.statusMap.get(String(pick(n.task, 'id'))));
    if (!pending.length) return;
    this.statusBusy = true;
    (async () => {
      try {
        for (const n of pending.slice(0, 40)) {
          await this.refreshStatusFor(n.task);
        }
      } catch (e) { }
      this.statusBusy = false;
      this.tree.refresh();
    })();
  }

  refreshAllStatuses() {
    for (const [id, st] of this.statusMap) {
      if (st && st.type === 'uploaded') this.statusMap.delete(id);
    }
  }

  async solutionState(solutionId) {
    let r = null;
    try { r = await this.client.api('GET', `/api/proxy/student/solutions/${solutionId}`); } catch (e) { r = null; }
    if (!r || r.status !== 200 || !r.json) {
      try { r = await this.client.bffSolution(solutionId); } catch (e) { r = null; }
    }
    if (!r || r.status !== 200 || !r.json) {
      try {
        const alt = await this.client.solution(solutionId);
        if (alt && alt.status === 200 && alt.json) r = alt;
      } catch (e) { }
    }
    return r;
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
        const verdict = info ? pick(info, 'verdict') : undefined;
        this.statusMap.set(String(t.taskId), { type, verdict, badge: statusBadge(type, verdict) });
        this.tree.refresh();
        this.updateTaskStatusBar();
        if (this.taskDocUri) this.docProvider.refresh(this.taskDocUri);
      }
    }
    const detail = await this.taskDetail(t);
    await this.showTaskDoc();
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
        const fr = await this.client.raw('GET', url, {});
        code = await fr.text();
      }
    }
    if (!code) {
      vscode.window.showWarningMessage('LMS: код в решении не найден.');
      return;
    }
    fs.mkdirSync(path.dirname(t.filePath), { recursive: true });
    fs.writeFileSync(t.filePath, stripTemplate(code), 'utf8');
    const doc = await vscode.workspace.openTextDocument(t.filePath);
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
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: проверяю PEP 8…' }, async () => {
      const report = await this.runPep8(doc);
      this.pep8Report = report;
      this.output().appendLine('=== PEP 8 ===\n' + report.text);
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle }, null);
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
    const python = cfg().get('pythonPath') || 'python';
    // 1) пробуем внешние инструменты
    for (const mod of ['pycodestyle', 'flake8']) {
      try {
        const res = await this.runProcess(python, ['-m', mod, '--max-line-length=100', filePath], 20000);
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
      const comp = await this.runProcess(python, ['-m', 'py_compile', filePath], 20000);
      if (comp.code !== 0) {
        const out = (comp.out || '').trim();
        return { errors: [{ line: 0, col: 0, code: 'SyntaxError', text: out.split(/\r?\n/).filter(Boolean).slice(-2).join(' ') }], text: 'Синтаксическая ошибка:\n' + out, tool: 'python' };
      }
    } catch (e) { }
    // 3) свои базовые проверки PEP 8
    const lines = code.split(/\r?\n/);
    const push = (line, col, c, text) => errors.push({ line, col, code: c, text });
    lines.forEach((ln, i) => {
      const n = i + 1;
      if (ln.length > 100) push(n, 101, 'E501', 'строка длиннее 100 символов (' + ln.length + ')');
      if (/[ \t]+$/.test(ln)) push(n, ln.replace(/[ \t]+$/, '').length + 1, 'W291', 'лишние пробелы в конце строки');
      if (/^\t/.test(ln)) push(n, 1, 'W191', 'используются табы вместо пробелов');
      const ind = (ln.match(/^ */) || [''])[0].length;
      if (ln.trim() && ind % 4 !== 0) push(n, ind + 1, 'E111', 'отступ не кратен 4');
      if (/\w\s{2,}\w/.test(ln) === false && /[^ =<>!+\-*/%&|^~]=[^=]/.test(ln) && !/^\s*#/.test(ln) && !/["']/.test(ln)) push(n, 1, 'E225', 'пропущены пробелы вокруг оператора');
      if (/=\s{2,}\S/.test(ln) && !/^\s*#/.test(ln) && !/,\s{2,}/.test(ln) && !/\w\s{2,}=/.test(ln)) push(n, 1, 'E251', 'лишние пробелы вокруг знака =');
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
    if (!code.endsWith('\n')) push(lines.length, 1, 'W292', 'нет перевода строки в конце файла');
    return {
      errors,
      text: errors.length ? errors.map(e => 'строка ' + e.line + (e.col ? ':' + e.col : '') + ' ' + e.code + ' ' + e.text).join('\n') : 'Замечаний нет.',
      tool: 'встроенная проверка'
    };
  }

  runProcess(cmd, args, timeoutMs) {
    return new Promise(resolve => {
      let out = '';
      let done = false;
      try {
        const cp = require('child_process').spawn(cmd, args, { windowsHide: true });
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

  output() {
    if (!this._output) {
      this._output = vscode.window.createOutputChannel('Yandex LMS');
    }
    return this._output;
  }

  diagDir() {
    const d = path.join(os.tmpdir(), 'yandex-lms-diag');
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
    return d;
  }

  logSubmit(obj) {
    try {
      fs.appendFileSync(path.join(this.diagDir(), 'submit-log.jsonl'), JSON.stringify(obj) + '\n', 'utf8');
    } catch (e) { }
  }

  async probe(reason) {
    const dir = this.diagDir();
    const t = this.currentTask;
    const sid = t && t.solutionId;
    const taskId = t && t.taskId;
    const gid = t && t.groupId;
    const cid = t && t.courseId;
    const lid = t && t.lessonId;
    const results = [];

    const hits = [
      `/api/problems/solution/${sid}`,
      `/api/proxy/problems/solution/${sid}`,
      `/api/student/solutions/${sid}`,
      `/api/proxy/student/solutions/${sid}`,
      `/api/student/solutions/${sid}/`,
      `/api/student/tasks/${taskId}/solution`,
      `/api/proxy/student/tasks/${taskId}/solution`,
      `/api/student/problems/solution/${sid}`,
      `/api/proxy/student/problems/solution/${sid}`,
      `/api/problems/solution/${sid}/`,
      `/api/proxy/problems/solution/${sid}/`
    ];
    if (cid && lid) {
      hits.push(`/api/courses/${cid}/groups/${gid}/lessons/${lid}/tasks/${taskId}/solution`);
      hits.push(`/api/proxy/courses/${cid}/groups/${gid}/lessons/${lid}/tasks/${taskId}/solution`);
      hits.push(`/api/courses/${cid}/groups/${gid}/lessons/${lid}/problems/${taskId}/solutions/${sid}`);
    }
    const page = cid && lid ? `/courses/${cid}/groups/${gid}/lessons/${lid}/tasks/${taskId}` : null;
    const urls = hits.map(u => ['GET', u]);
    if (page) urls.push(['GET', page]);

    for (const [method, url] of urls) {
      const rec = { method, url, status: null, body: '' };
      try {
        const res = await this.client.raw(method, this.client.base + url, { headers: {} });
        rec.status = res.status;
        rec.finalUrl = res.finalUrl;
        rec.body = (await res.text()).slice(0, 6000);
        if (rec.status === 200 && /solutions\//.test(url)) {
          try { fs.writeFileSync(path.join(dir, 'solution-latest.json'), rec.body, 'utf8'); } catch (e2) { }
        }
        if (rec.status === 200 && /\/courses\/\d+\//.test(url)) {
          try { fs.writeFileSync(path.join(dir, 'spa-task-page.html'), rec.body, 'utf8'); } catch (e2) { }
        }
      } catch (e) { rec.error = String(e.message || e); }
      results.push(rec);
      this.output().appendLine(`probe GET ${url} → ${rec.status}`);
      if (rec.status === 200) this.output().appendLine('  ' + String(rec.body).slice(0, 200));
    }

    if (page) {
      try {
        const res = await this.client.raw('GET', this.client.base + page, { headers: {} });
        const html = await res.text();
        fs.writeFileSync(path.join(dir, 'spa-full.html'), html, 'utf8');
        const srcs = [...html.matchAll(/src="(https?:\/\/[^"]+?\.js[^"]*)"/g)].map(m => m[1]);
        const inline = [...html.matchAll(/(\{["'].{200,}?\})\}?\)?\s*<\/script>/g)].map(m => m[1].slice(0, 50000));
        fs.writeFileSync(path.join(dir, 'spa-inline.json'), JSON.stringify(inline, null, 2), 'utf8');
        const bd = path.join(dir, 'spa-chunks');
        fs.mkdirSync(bd, { recursive: true });
        for (const s of srcs.slice(0, 14)) {
          const name = (s.split('/').pop() || 'chunk').split('?')[0];
          try {
            const r2 = await this.client.raw('GET', s, { headers: {} });
            fs.writeFileSync(path.join(bd, name), await r2.text(), 'utf8');
          } catch (e2) { }
        }
        this.output().appendLine('SPA: srcs=' + srcs.length + ' inline=' + inline.length);
      } catch (e) { this.output().appendLine('SPA fetch err: ' + e); }
    }

    if (cid && lid && gid) {
      const lt = `/api/student/lessonTasks?courseId=${cid}&lessonId=${lid}&groupId=${gid}`;
      try {
        const res = await this.client.raw('GET', this.client.base + lt, { headers: {} });
        const body = await res.text();
        fs.writeFileSync(path.join(dir, 'lesson-tasks.json'), body, 'utf8');
        results.push({ method: 'GET', url: lt, status: res.status, body: body.slice(0, 400) });
        this.output().appendLine('probe GET lessonTasks → ' + res.status);
      } catch (e) { }
    }

    const compilerId = (t && t.compilerId) || 'python-lyceum';
    const postTries = [
      [`/api/student/problem/submission?solutionId=${sid}`, { code: t && t.lastCode ? t.lastCode : '' }],
      [`/api/student/problem/submission/?solutionId=${sid}`, { code: t && t.lastCode ? t.lastCode : '' }],
      [`/api/proxy/student/problem/submission?solutionId=${sid}`, { code: t && t.lastCode ? t.lastCode : '' }]
    ];
    for (const [url, body] of postTries) {
      if (!body.code) break;
      const rec = { method: 'POST', url, status: null, body: '' };
      try {
        const res = await this.client.raw('POST', this.client.base + url, {
          headers: Object.assign(this.client.apiHeaders(), { 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        });
        rec.status = res.status;
        rec.body = (await res.text()).slice(0, 800);
      } catch (e) { rec.error = String(e.message || e); }
      results.push(rec);
      this.output().appendLine(`probe POST ${url} → ${rec.status}`);
      this.output().appendLine('  ' + String(rec.body).slice(0, 300));
      if (rec.status >= 200 && rec.status < 300) break;
    }

    const file = path.join(dir, 'probe-latest.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), reason: reason || 'manual', base: this.client.base, compilerId, results }, null, 2), 'utf8');
    } catch (e) { }
    this.output().appendLine('=== Зонд: ' + file + ' ===');
    return results;
  }

  async collectReport(reason) {
    const dir = this.diagDir();
    const report = {
      ts: new Date().toISOString(),
      reason: reason || 'manual',
      base: this.client.base,
      ua: UA,
      cookies: [...this.jar.map.keys()],
      steps: [],
      scripts: [],
      bundles: [],
      apiPaths: [],
      matched: [],
      currentTask: null,
      task: null,
      solution: null
    };
    const save = (name, text) => {
      try { fs.writeFileSync(path.join(dir, name), text, 'utf8'); return name; } catch (e) { return null; }
    };
    const grab = async (name, url) => {
      try {
        const r = await this.client.raw('GET', url, { headers: { 'Accept': 'text/html,application/javascript,*/*' } });
        const text = await r.text();
        report.steps.push({ name, url, status: r.status, len: text.length, finalUrl: r.finalUrl || url });
        return { status: r.status, text, finalUrl: r.finalUrl || url };
      } catch (e) {
        report.steps.push({ name, url, error: String(e.message || e) });
        return null;
      }
    };

    const index = await grab('index', this.client.base + '/');
    if (index) save('index.html', index.text);
    const html = index ? index.text : '';
    report.indexFinalUrl = index ? index.finalUrl : null;

    const srcs = [];
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) srcs.push(m[1]);
    for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.(?:js|css))["']/g)) srcs.push(m[1]);

    const t0 = this.currentTask;
    if (t0 && t0.taskUrl) {
      const page = await grab('taskPage', t0.taskUrl);
      if (page) {
        save('task-page.html', page.text);
        report.taskPageFinalUrl = page.finalUrl;
        for (const m of page.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) srcs.push(m[1]);
        for (const m of page.text.matchAll(/<link[^>]+href=["']([^"']+\.js)["']/g)) srcs.push(m[1]);
        for (const m of page.text.matchAll(/["'](\/[^"']*static\/[^"']*\.js)["']/g)) srcs.push(m[1]);
      }
    }
    report.scripts = [...new Set(srcs)];

    const baseHost = new URL(this.client.base).origin;
    const bundlesDir = path.join(dir, 'bundles');
    try { fs.mkdirSync(bundlesDir, { recursive: true }); } catch (e) { }

    for (const s of report.scripts.slice(0, 30)) {
      const u = s.startsWith('http') ? s : s.startsWith('//') ? 'https:' + s : baseHost + (s.startsWith('/') ? s : '/' + s);
      const got = await grab('script:' + s, u);
      if (!got || got.status !== 200 || !got.text) continue;
      let fname = 'bundle-' + (path.basename(new URL(u).pathname) || 'x');
      if (!/\.(js|css)$/.test(fname)) fname += '.js';
      try { fs.writeFileSync(path.join(bundlesDir, fname), got.text, 'utf8'); } catch (e) { }
      report.bundles.push({ name: fname, url: u, len: got.text.length });
      for (const m of got.text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-{}\/\.:$]+)["'`]/g)) report.apiPaths.push(m[1]);
      for (const m of got.text.matchAll(/["'`](\/[a-zA-Z0-9_\-\/]*api[a-zA-Z0-9_\-\/]*)["'`]/g)) report.apiPaths.push(m[1]);
      const snips = [];
      for (const m of got.text.matchAll(/[A-Za-z0-9_\-{}\/\.:$]{0,90}(?:submission|submit|rejudge|verdict)[A-Za-z0-9_\-{}\/\.:$]{0,90}/gi)) snips.push(m[0]);
      if (snips.length) report.matched.push({ name: fname, snips: [...new Set(snips)].slice(0, 300) });
    }
    report.apiPaths = [...new Set(report.apiPaths)].sort();

    const t = this.currentTask;
    if (t) {
      report.currentTask = { taskId: t.taskId, solutionId: t.solutionId, compilerId: t.compilerId, compilers: t.compilers, groupId: t.groupId, filePath: t.filePath, taskUrl: t.taskUrl };
      try {
        const tr = await this.client.task(t.taskId, t.groupId);
        report.task = { status: tr.status, body: String(tr.text || '').slice(0, 30000) };
      } catch (e) { report.task = { error: String(e.message || e) }; }
      if (t.solutionId) {
        try {
          const sr = await this.client.bffSolution(t.solutionId);
          report.solution = { status: sr.status, body: String(sr.text || '').slice(0, 60000) };
        } catch (e) { report.solution = { error: String(e.message || e) }; }
        try {
          const old = await this.client.solution(t.solutionId);
          report.solutionOld = { status: old.status, body: String(old.text || '').slice(0, 2000) };
        } catch (e) { }
      }
    }
    if (this.lastAttempts && this.lastAttempts.length) report.attempts = this.lastAttempts;

    const file = save('report-latest.json', JSON.stringify(report, null, 2));
    save('report-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', JSON.stringify(report, null, 2));
    this.output().appendLine('');
    this.output().appendLine('=== Отчёт сохранён: ' + path.join(dir, file) + ' ===');
    this.output().appendLine('API-пути в бандлах: ' + report.apiPaths.length + ', скриптов: ' + report.scripts.length + ', совпадений по submit: ' + report.matched.length);
    for (const p of report.apiPaths) this.output().appendLine('  ' + p);
    return { dir, file: path.join(dir, file || 'report-latest.json'), report };
  }

  async diagnose() {
    const out = this.output();
    out.clear();
    out.appendLine('=== Диагностика Яндекс LMS ===');
    out.appendLine('Базовый URL: ' + this.client.base);
    out.appendLine('Куки в хранилище: ' + (this.jar.isEmpty() ? 'нет' : [...this.jar.map.keys()].join(', ')));

    const dump = {
      ts: new Date().toISOString(),
      base: this.client.base,
      cookies: [...this.jar.map.keys()],
      steps: [],
      apiPaths: []
    };
    const record = (name, r, extra) => {
      const body = (r && r.text) || '';
      dump.steps.push(Object.assign({ name, status: r ? r.status : null, url: r ? r.url : null, body: body.slice(0, 6000) }, extra || {}));
      out.appendLine('');
      out.appendLine(`--- ${name} → HTTP ${r ? r.status : 'ERR'}`);
      out.appendLine(body.slice(0, 400));
    };

    const tryGet = async (name, ep) => {
      try {
        const r = await this.client.api('GET', ep);
        record(name, r, { endpoint: ep });
        return r;
      } catch (e) {
        out.appendLine(`--- ${name} → ОШИБКА: ${e.message}`);
        dump.steps.push({ name, endpoint: ep, error: String(e.message || e) });
        return null;
      }
    };

    await tryGet('profile', '/api/profile?withCoursesSummary=true&withExpelled=true&withChildren=true&withParents=true');

    const courses = this.courseList();
    dump.courseCount = courses.length;
    if (courses.length) {
      const c = courses[0];
      const gid = pick(pick(c, 'group'), 'id');
      dump.firstCourse = { id: pick(c, 'id'), title: pick(c, 'title'), groupId: gid, group: pick(c, 'group') };
      out.appendLine('');
      out.appendLine('Первый курс: id=' + dump.firstCourse.id + ' groupId=' + gid);
      const variants = [
        `/api/student/lessons?courseId=${c.id}&groupId=${gid}`,
        `/api/student/lessons?courseId=${c.id}`,
        `/api/student/lessons/${c.id}?groupId=${gid}`,
        `/api/student/lessons/${c.id}`
      ];
      let lessons = [];
      for (const v of variants) {
        const r = await tryGet('lessons ' + v, v);
        if (r && r.status === 200 && r.json) {
          const arr = Array.isArray(r.json) ? r.json : pick(r.json, 'lessons', 'items', 'data', 'results');
          if (Array.isArray(arr) && arr.length) { lessons = arr; break; }
        }
      }
      if (lessons.length) {
        const lid = pick(lessons[0], 'id');
        dump.firstLesson = lessons[0];
        for (const v of [
          `/api/student/lessonTasks?courseId=${c.id}&lessonId=${lid}&groupId=${gid}`,
          `/api/student/lessonTasks?courseId=${c.id}&lessonId=${lid}`,
          `/api/student/lessons/${lid}/tasks?groupId=${gid}`,
          `/api/student/lessons/${lid}/tasks`
        ]) {
          await tryGet('tasks ' + v, v);
        }
      }
    }

    out.appendLine('');
    out.appendLine('Сканирую JS-бандл LMS в поисках реальных эндпоинтов…');
    try {
      const found = await this.discoverApiPaths();
      dump.apiPaths = found.paths;
      dump.bundles = found.bundles;
      out.appendLine('Найдено эндпоинтов в бандле: ' + found.paths.length);
      for (const p of found.paths.slice(0, 120)) out.appendLine('  ' + p);
    } catch (e) {
      out.appendLine('Сканирование бандла не удалось: ' + (e.message || e));
      dump.apiPathsError = String(e.message || e);
    }

    if (this.lastAttempts.length) {
      out.appendLine('');
      out.appendLine('=== Последние попытки отправки решения ===');
      for (const a of this.lastAttempts) {
        out.appendLine(`${a.status}  ${a.label}`);
        out.appendLine('   ' + String(a.detail || '').replace(/\n/g, '\n   '));
      }
    }

    let file = '';
    try {
      const dir = path.join(os.tmpdir(), 'yandex-lms-diag');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'dump.json');
      fs.writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
      out.appendLine('');
      out.appendLine('Полный отчёт сохранён: ' + file);
    } catch (e) {
      out.appendLine('Не удалось сохранить отчёт: ' + (e.message || e));
    }

    out.show(true);
    vscode.window.showInformationMessage('LMS: диагностика записана в Output → «Yandex LMS».' + (file ? ' Файл: ' + file : ''));
  }

  async discoverApiPaths() {
    const paths = new Set();
    const bundles = [];
    const htmlRes = await this.client.raw('GET', this.client.base + '/');
    const html = await htmlRes.text().catch(() => '');
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]);
    for (const src of srcs.slice(0, 12)) {
      const url = src.startsWith('//') ? 'https:' + src : (src.startsWith('/') ? this.client.base + src : src);
      bundles.push(url);
      let code = '';
      try {
        const r = await this.client.raw('GET', url);
        code = await r.text().catch(() => '');
      } catch (e) { continue; }
      if (!code) continue;
      for (const m of code.matchAll(/["'`](\/api\/[A-Za-z0-9_\-./%${}?:=&]+)["'`]/g)) paths.add(m[1]);
    }
    return { paths: [...paths].sort(), bundles };
  }

  async dispose() {
    this.statusBar.dispose();
  }
}

class AiAutocomplete {
  constructor(lms) {
    this.lms = lms;
    this.timer = null;
    this.pending = null;
    this.cache = new Map();
    this.calls = [];
  }

  cancel() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      try { p.resolve(undefined); } catch (e) { }
    }
  }

  async provideInlineCompletionItems(document, position) {
    const lms = this.lms;
    if (!cfg().get('ai.autocomplete')) return undefined;
    const t = lms && lms.currentTask;
    if (!t || !t.filePath) return undefined;
    if (document.uri.fsPath !== t.filePath) return undefined;
    if (!aiHasConfig()) return undefined;

    const text = document.getText();
    const upto = text.slice(0, document.offsetAt(position));
    const key = document.uri.fsPath + '|' + upto.length + '|' + upto.slice(-150);
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      return v ? [v] : undefined;
    }
    const now = Date.now();
    this.calls = this.calls.filter(x => now - x < 60000);
    const maxCalls = Number(cfg().get('ai.autocompleteMaxCalls') || 12);
    if (this.calls.length >= maxCalls) return undefined;

    const delay = Number(cfg().get('ai.autocompleteDelay') || 800);
    return new Promise((resolve) => {
      this.cancel();
      this.timer = setTimeout(async () => {
        this.timer = null;
        this.pending = null;
        let item = null;
        try {
          item = await this.ask(lms, upto);
          this.calls.push(Date.now());
        } catch (e) { item = null; }
        this.cache.set(key, item);
        if (this.cache.size > 80) {
          const first = this.cache.keys().next().value;
          this.cache.delete(first);
        }
        resolve(item ? [item] : undefined);
      }, delay);
      this.pending = { resolve };
    });
  }

  async ask(lms, upto) {
    const statement = lms.aiStatement();
    const lessons = lms.aiLessonsText();
    const prompt =
      'УСЛОВИЕ ЗАДАЧИ:\n' + (statement || '(условие неизвестно)') + '\n\n' +
      'КОД, НАПИСАННЫЙ УЧЕНИКОМ ДО КУРОСОРА:\n' + upto + '\n\n' +
      lessons +
      'Ученик прошёл только базовый курс Python: ввод-вывод, строки, списки, циклы for/while, условия. Без модулей (import, sys), без классов и try/except.\n' +
      'Напиши ТОЛЬКО следующую строку кода (или 1-2 строки), которая продолжает решение по этому условию. ' +
      'Никаких пояснений, никакого markdown, никаких ``` — только код, готовый к вставке с правильным отступом. ' +
      'Если по условию для следующей строки нужно вывести результат — выведи его.';
    const raw = await aiChat(prompt, 'Ты — учитель Python курса Яндекс LMS. Ты даёшь только код, без пояснений.', 15000, null, { maxTokens: 80, temperature: 0, hedge: false, noPenalty: true });
    let s = String(raw || '').trim();
    s = s.replace(/^```(?:python)?/i, '').replace(/```\s*$/, '').trim();
    s = s.replace(/^(?:Вот|Ответ|Код|Next)[^\n:]*:\s*/i, '');
    const lines = s.split(/\r?\n/);
    const out = [];
    for (const l of lines) {
      if (out.length >= 2) break;
      if (!l.trim() && out.length === 0) continue;
      out.push(l);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    const code = out.join('\n');
    if (!code.trim()) return null;
    if (/^\s*(вот|ответ|код|следующ)/i.test(code.trim())) return null;
    return new vscode.InlineCompletionItem(code);
  }
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

class LmsTreeProvider {
  constructor(lms) {
    this.lms = lms;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.cache = new Map();
  }

  refresh() {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  statusOf(taskId) {
    return this.lms.statusMap.get(String(taskId)) || null;
  }

  getTreeItem(el) {
    return el;
  }

  async getChildren(el) {
    if (!el) {
      if (!this.lms.profileJson) {
        const item = new vscode.TreeItem('Войти в LMS…', vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'yandexLms.loginMenu', title: 'Войти' };
        item.iconPath = new vscode.ThemeIcon('sign-in');
        return [item];
      }
      const courses = this.lms.courseList();
      if (!courses.length) {
        const item = new vscode.TreeItem('Курсы не найдены — обновите (LMS: Обновить список курсов)', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('warning');
        return [item];
      }
      return courses.map(c => new CourseNode(this.lms, c));
    }
    if (el instanceof CourseNode) {
      const key = 'course:' + el.course.id;
      if (this.cache.has(key)) return this.cache.get(key);
      const r = await this.lms.client.lessons(el.course.id, el.groupId);
      const arr = asArray(r.json, ['lessons', 'items', 'data', 'results', 'groups']);
      let list = [];
      if (r.status === 200 && arr) {
        list = arr.map(l => new LessonNode(this.lms, l, el));
      } else {
        list = [errorItem('Не загрузились уроки (HTTP ' + r.status + ')', r.text)];
      }
      this.cache.set(key, list);
      return list;
    }
    if (el instanceof LessonNode) {
      const key = 'lesson:' + el.lesson.id;
      if (this.cache.has(key)) return this.cache.get(key);
      const r = await this.lms.client.lessonTasks(el.courseId, el.lesson.id, el.groupId);
      try {
        const dir = this.lms.diagDir();
        fs.writeFileSync(path.join(dir, 'lesson-tasks-' + el.lesson.id + '.json'), JSON.stringify(r.json, null, 2), 'utf8');
      } catch (e) { }
      const arr = asArray(r.json, ['tasks', 'items', 'data', 'results']);
      let list = [];
      if (r.status === 200 && arr) {
        const groups = Array.isArray(r.json) ? r.json : (arr.length && arr[0] && arr[0].tasks ? r.json : [r.json]);
        for (const group of groups) {
          const tasks = pick(group, 'tasks') || pick(group, 'problems') || pick(group, 'items') || [];
          const typeName = pick(group, 'type') || pick(group, 'title') || '';
          for (const t of tasks) {
            if (!t) continue;
            list.push(new TaskNode(this.lms, t, el, typeName));
          }
        }
      } else {
        list = [errorItem('Не загрузились задания (HTTP ' + r.status + ')', r.text)];
      }
      this.cache.set(key, list);
      this.lms.ensureStatuses(list);
      return list;
    }
    return [];
  }
}

class CourseNode extends vscode.TreeItem {
  constructor(lms, course) {
    super(lms.courseLabel(course), vscode.TreeItemCollapsibleState.Collapsed);
    this.course = course;
    this.courseId = course.id;
    this.groupId = pick(pick(course, 'group'), 'id');
    this.contextValue = 'lmsCourse';
    this.iconPath = new vscode.ThemeIcon('book');
    const rating = pick(course, 'rating');
    this.tooltip = rating !== undefined && rating !== null ? `Рейтинг: ${rating}` : lms.courseLabel(course);
  }
}

class LessonNode extends vscode.TreeItem {
  constructor(lms, lesson, courseNode) {
    super(pick(lesson, 'title') || pick(lesson, 'shortTitle', 'short_title') || 'Урок', vscode.TreeItemCollapsibleState.Collapsed);
    this.lesson = lesson;
    this.courseId = courseNode.courseId;
    this.groupId = courseNode.groupId;
    this.courseTitle = courseNode.courseLabel || courseNode.label;
    this.contextValue = 'lmsLesson';
    this.iconPath = new vscode.ThemeIcon('notebook');
    const passed = pick(lesson, 'numPassed', 'num_passed');
    const total = pick(lesson, 'numTasks', 'num_tasks');
    const deadline = pick(lesson, 'deadline');
    this.tooltip = [
      total !== undefined ? `Задач: ${passed || 0}/${total}` : null,
      deadline ? `Дедлайн: ${deadline}` : null
    ].filter(Boolean).join('\n') || undefined;
  }
}

class TaskNode extends vscode.TreeItem {
  constructor(lms, task, lessonNode, typeName) {
    const title = pick(task, 'title') || pick(task, 'shortTitle', 'short_title') || 'Задача';
    super(title, vscode.TreeItemCollapsibleState.None);
    this.task = task;
    this.groupId = lessonNode.groupId;
    this.courseId = lessonNode.courseId;
    this.lessonId = lessonNode.lesson && lessonNode.lesson.id;
    this.courseTitle = lessonNode.courseTitle;
    this.lessonTitle = lessonNode.label;
    this.contextValue = 'lmsTask';
    this.command = {
      command: 'yandexLms.openTask',
      title: 'Открыть задание',
      arguments: [this]
    };
    const scoreMax = pick(task, 'scoreMax', 'score_max');
    const deadline = pick(task, 'deadline');
    this.tooltip = [
      typeName ? 'Тип: ' + typeName : null,
      scoreMax !== undefined ? 'Баллов: ' + scoreMax : null,
      deadline ? 'Дедлайн: ' + deadline : null
    ].filter(Boolean).join('\n') || undefined;
    const dl = deadline ? new Date(deadline) : null;
    if (dl && !Number.isNaN(dl.getTime())) this.description = 'до ' + dl.toLocaleDateString('ru-RU');

    const st = lms.statusOf(task);
    if (st && st.badge && (st.badge.icon || st.badge.desc)) {
      this.label = title;
      this.iconPath = new vscode.ThemeIcon(st.badge.icon || 'code', st.badge.color ? new vscode.ThemeColor(st.badge.color) : undefined);
      const scoreTxt = (st.score !== undefined && st.score !== null && scoreMax !== undefined)
        ? ` ${st.score}/${scoreMax}` : '';
      this.description = [st.badge.desc + scoreTxt, this.description].filter(Boolean).join(' · ');
      this.tooltip = [this.tooltip, 'Статус: ' + st.badge.desc].filter(Boolean).join(' — ').replace(/\n/g, ' · ');
    } else {
      this.iconPath = new vscode.ThemeIcon('code');
    }
  }
}

function statusBadge(type, verdict) {
  const t = String(type || '').toLowerCase();
  const v = String(verdict || '').toUpperCase();
  if (t === 'accepted' || t === 'accepted-after-deadline' || t === 'samples-passed' || v === 'OK') {
    return { emoji: '', icon: 'pass', color: 'testing.iconPassed', desc: 'Зачтено' };
  }
  if (t === 'rework') {
    return { emoji: '', icon: 'edit', color: 'testing.iconFailed', desc: 'На доработку' };
  }
  if (t === 'wrong' || t === 'not-solved') {
    return { emoji: '', icon: 'error', color: 'testing.iconFailed', desc: 'Ошибка, на доработку' };
  }
  if (t === 'partial-accepted') {
    return { emoji: '', icon: 'warning', color: 'charts.yellow', desc: 'Частично зачтено' };
  }
  if (t === 'uploaded' || t === 'review' || t === 'auto-review' || t === 'assigned-to-p2p' || t === 'on-clarifying') {
    return { emoji: '', icon: 'sync', color: 'charts.yellow', desc: 'На проверке' };
  }
  if (t === 'new' || t === 'draft') {
    return { emoji: '', icon: 'code', color: null, desc: '' };
  }
  return { emoji: '', icon: 'code', color: null, desc: '' };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const AI_PROVIDERS = {
  none: { label: 'Выключено', baseUrl: '', model: '' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama (локально)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder' },
  custom: { label: 'Другой (OpenAI-совместимый)', baseUrl: '', model: '' }
};

function aiConfig() {
  const c = cfg();
  const provider = c.get('ai.provider') || 'none';
  const p = AI_PROVIDERS[provider] || AI_PROVIDERS.none;
  const baseUrl = String(c.get('ai.baseUrl') || p.baseUrl || '').replace(/\/+$/, '');
  const model = String(c.get('ai.model') || p.model || '');
  const apiKey = String(c.get('ai.apiKey') || '');
  return {
    provider,
    label: p.label,
    baseUrl,
    model,
    apiKey,
    temperature: Number(c.get('ai.temperature') || 0.2)
  };
}

// ─── Пул ключей ИИ: несколько API-ключей/провайдеров, ротация по лимитам ───
const AI_POOL_SECRET = 'yandexLms.aiPool';
let AI_POOL = [];
let AI_POOL_STATE = {};
let AI_POOL_ACTIVE = null;
let AI_POOL_PERSIST = null;
let AI_POOL_SAVE_TIMER = null;

function aiEntryId(e) {
  return crypto.createHash('sha1').update([e.provider || '', e.baseUrl || '', e.model || '', e.apiKey || ''].join('|')).digest('hex').slice(0, 12);
}

function aiEntryLabel(e) {
  const p = AI_PROVIDERS[e.provider] || {};
  return (e.label || p.label || e.provider || '?') + ' · ' + (e.model || '?');
}

function aiKeyTail(key) {
  const s = String(key || '');
  return s ? '••••' + s.slice(-4) : 'локальная';
}

function aiLegacyEntry() {
  const c = aiConfig();
  if (!c.provider || c.provider === 'none' || !c.baseUrl || !c.model) return null;
  return { provider: c.provider, baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, label: c.label };
}

function aiEntries() {
  const src = AI_POOL.length ? AI_POOL : [aiLegacyEntry()].filter(Boolean);
  const out = [];
  for (const e of src) {
    if (!e || !e.baseUrl || !e.model) continue;
    if (!e.apiKey && e.provider !== 'ollama') continue;
    out.push(Object.assign({}, e, { id: aiEntryId(e) }));
  }
  return out;
}

function aiHasConfig() {
  return aiEntries().length > 0;
}

function aiCooldownLeft(e) {
  const st = AI_POOL_STATE[e.id];
  if (!st || !st.until) return 0;
  return Math.max(0, st.until - Date.now());
}

function aiPruneStates() {
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(AI_POOL_STATE)) {
    const s = AI_POOL_STATE[k];
    if (!s) { delete AI_POOL_STATE[k]; changed = true; continue; }
    if (s.until && s.until <= now) { s.until = 0; s.kind = null; changed = true; }
    // состояния от старых версий (без kind) сбрасываем: они ставились на любые ошибки
    else if (s.until && !s.kind) { s.until = 0; changed = true; }
  }
  if (changed) aiPersistSoon();
}

function aiOrdered() {
  const ready = [];
  const cooling = [];
  for (const e of aiEntries()) (aiCooldownLeft(e) > 0 ? cooling : ready).push(e);
  ready.sort((a, b) => ((AI_POOL_STATE[a.id] || {}).ms || 4000) - ((AI_POOL_STATE[b.id] || {}).ms || 4000));
  cooling.sort((a, b) => aiCooldownLeft(a) - aiCooldownLeft(b));
  const list = ready.concat(cooling);
  const i = list.findIndex(e => e.id === AI_POOL_ACTIVE);
  if (i > 0) list.unshift(list.splice(i, 1)[0]);
  return list;
}

function aiPersistSoon() {
  if (!AI_POOL_PERSIST) return;
  if (AI_POOL_SAVE_TIMER) clearTimeout(AI_POOL_SAVE_TIMER);
  AI_POOL_SAVE_TIMER = setTimeout(() => {
    AI_POOL_SAVE_TIMER = null;
    try { AI_POOL_PERSIST(JSON.stringify({ entries: AI_POOL, state: AI_POOL_STATE, active: AI_POOL_ACTIVE })); } catch (e) { }
  }, 300);
}

function aiMarkOk(entry, ms) {
  const st = AI_POOL_STATE[entry.id] = AI_POOL_STATE[entry.id] || {};
  st.fails = 0;
  st.until = 0;
  st.kind = null;
  st.lastOk = Date.now();
  if (ms) st.ms = st.ms ? Math.round(st.ms * 0.65 + ms * 0.35) : ms;
  AI_POOL_ACTIVE = entry.id;
  aiPersistSoon();
}

function aiMarkFail(entry, err, silent) {
  if (silent) return;
  const st = AI_POOL_STATE[entry.id] = AI_POOL_STATE[entry.id] || {};
  const status = Number((err && err.status) || 0);
  const kind = (err && err.kind) || (status === 401 ? 'auth' : (status === 403 ? 'denied' : ((status === 402 || status === 429) ? 'limit' : 'error')));
  st.fails = (st.fails || 0) + 1;
  st.lastError = String((err && err.message) || err || '').slice(0, 300);
  st.lastFail = Date.now();
  st.kind = kind;
  let ms;
  if (kind === 'auth') ms = 6 * 60 * 60 * 1000;
  else if (kind === 'limit') ms = Math.max(60 * 1000, Number(err && err.retryAfterMs) || 5 * 60 * 1000);
  else if (kind === 'denied') ms = 10 * 60 * 1000;
  else ms = 20 * 1000;
  st.until = Date.now() + ms;
  aiLog({ event: 'cooldown', entry: aiEntryLabel(entry), key: aiKeyTail(entry.apiKey), kind, ms, status, error: st.lastError.slice(0, 160) });
  aiPersistSoon();
}

function aiError(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

function aiPoolEnsureSeed() {
  if (AI_POOL.length) return;
  const e = aiLegacyEntry();
  if (e) AI_POOL.push(e);
}

async function aiChatOnce(entry, prompt, system, timeoutMs, images, opts, ctl) {
  const o = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (entry.apiKey) headers['Authorization'] = 'Bearer ' + entry.apiKey;
  if (entry.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://lms.yandex.ru';
    headers['X-Title'] = 'Yandex LMS for VS Code';
  }
  const temperature = o.temperature !== undefined ? o.temperature : Number(cfg().get('ai.temperature') || 0.2);
  const maxTokens = Number(o.maxTokens || 0);
  const buildBody = (withImages) => {
    const body = {
      model: entry.model,
      messages: [
        { role: 'system', content: system || 'Ты — наставник по Python.' },
        {
          role: 'user',
          content: withImages && images && images.length
            ? [{ type: 'text', text: prompt }].concat(images.slice(0, 2).map(u => ({ type: 'image_url', image_url: { url: u } })))
            : prompt
        }
      ],
      temperature
    };
    if (maxTokens > 0) body.max_tokens = maxTokens;
    return body;
  };
  const limit = Math.max(4000, Number(timeoutMs) || 90000);
  const controller = ctl || new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (e) { } }, limit);
  const t0 = Date.now();
  let useImages = !!(images && images.length);
  const send = () => fetch(entry.baseUrl + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(useImages)),
    signal: controller.signal
  });
  let res;
  try {
    res = await send();
  } catch (e) {
    clearTimeout(timer);
    const ms = Date.now() - t0;
    aiLog({ event: 'http-error', entry: aiEntryLabel(entry), key: aiKeyTail(entry.apiKey), error: String(e.name || '') + ' ' + String(e.message || e), ms });
    if (e.name === 'AbortError' || /abort|timeout/i.test(String(e.message || ''))) {
      throw aiError('«' + entry.model + '» не ответила за ' + Math.round(limit / 1000) + ' с', { timeout: true, retryable: true, kind: 'error' });
    }
    throw aiError('нет связи с ' + entry.baseUrl + ' (' + (e.message || e) + ')', { retryable: true, kind: 'error' });
  }
  let text = await res.text();
  if (!res.ok && useImages) {
    aiLog({ event: 'images-retry', entry: aiEntryLabel(entry), status: res.status });
    useImages = false;
    try {
      res = await send();
      text = await res.text();
    } catch (e) { }
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  if (!res.ok) {
    const retryAfterS = Number(res.headers.get('retry-after') || 0);
    let msg = text.slice(0, 300);
    try {
      const j2 = JSON.parse(text);
      msg = (j2.error && (j2.error.message || j2.error)) || j2.message || msg;
    } catch (e) { }
    if (res.status === 401) msg = 'неверный API-ключ';
    else if (res.status === 403 && /openrouter/i.test(String(entry.baseUrl || ''))) msg = 'модель отклонена политикой OpenRouter — у бесплатных моделей нужно включить логирование промптов в настройках приватности, либо сменить модель/провайдера';
    aiLog({ event: 'http-fail', entry: aiEntryLabel(entry), key: aiKeyTail(entry.apiKey), status: res.status, ms, msg: String(msg).slice(0, 200) });
    const kind = res.status === 401 ? 'auth' : (res.status === 403 ? 'denied' : ((res.status === 402 || res.status === 429) ? 'limit' : 'error'));
    throw aiError('API ' + res.status + ': ' + msg, { status: res.status, retryAfterMs: retryAfterS > 0 ? retryAfterS * 1000 : 0, retryable: true, kind });
  }
  aiLog({ event: 'http', entry: aiEntryLabel(entry), key: aiKeyTail(entry.apiKey), status: res.status, ms, withImages: useImages });
  let json;
  try { json = JSON.parse(text); } catch (e) { throw aiError('ответ API не JSON: ' + text.slice(0, 200), { retryable: true }); }
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  const content = msg ? msg.content : (json.choices && json.choices[0] ? json.choices[0].text : '');
  if (!content) throw aiError('модель вернула пустой ответ', { retryable: true });
  return { text: String(content), ms };
}

async function aiChat(prompt, system, timeoutMs, images, opts) {
  const o = opts || {};
  const all = aiOrdered();
  if (!all.length) throw new Error('ИИ не настроен: добавьте ключ — «LMS: AI — ключи и лимиты».');
  const budget = Math.max(5000, Number(timeoutMs) || 90000);
  const deadline = Date.now() + budget;
  const maxTries = Math.max(1, Math.min(all.length, Number(cfg().get('ai.retries') || 3)));
  const list = all.slice(0, maxTries);
  const hedge = cfg().get('ai.hedge') !== false && o.hedge !== false && list.length > 1;
  const hedgeDelay = Math.max(1500, Number(cfg().get('ai.hedgeDelay') || 7000));

  const controllers = new Set();
  // pending хранит обёртки, которые сами себя убирают при завершении: по значению
  // из Promise.race нельзя удалить промис (indexOf вернёт -1) — это давало
  // бесконечный цикл и шторм ошибок.
  const pending = new Set();
  const errors = [];
  let launched = 0;
  let settled = false;
  let hedgeTimer = null;

  const launch = () => {
    if (settled || launched >= list.length) return false;
    const entry = list[launched++];
    const ctl = new AbortController();
    controllers.add(ctl);
    const remain = Math.max(5000, deadline - Date.now());
    const base = aiChatOnce(entry, prompt, system, remain, images, o, ctl)
      .then(r => ({ ok: true, entry, text: r.text, ms: r.ms }))
      .catch(err => ({ ok: false, entry, err }));
    let wrapped = null;
    wrapped = base.then(v => { pending.delete(wrapped); return v; });
    pending.add(wrapped);
    return true;
  };

  const abortAll = () => {
    for (const ctl of controllers) { try { ctl.abort(); } catch (e) { } }
  };

  if (hedge) hedgeTimer = setTimeout(() => { hedgeTimer = null; if (!settled) launch(); }, hedgeDelay);
  launch();

  try {
    for (;;) {
      if (!pending.size && !launch()) break;
      const r = await Promise.race([...pending]);
      if (r.ok) {
        settled = true;
        aiMarkOk(r.entry, r.ms);
        abortAll();
        return r.text;
      }
      aiMarkFail(r.entry, r.err, o.noPenalty);
      errors.push(r);
      if (Date.now() >= deadline) break;
      if (!pending.size && !launch()) break;
    }
  } finally {
    settled = true;
    if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
    abortAll();
  }

  const lines = errors.map(x => {
    const st = x.err && x.err.status ? 'HTTP ' + x.err.status : (x.err && x.err.timeout ? 'таймаут' : 'сбой');
    return aiEntryLabel(x.entry) + ' [' + aiKeyTail(x.entry.apiKey) + '] — ' + st + ': ' + String((x.err && x.err.message) || x.err || '').slice(0, 140);
  });
  const kinds = errors.map(x => (x.err && x.err.kind) || 'error');
  const allLimited = errors.length && kinds.every(k => k === 'limit');
  const allDenied = errors.length && kinds.every(k => k === 'denied' || k === 'auth');
  const tail = allLimited
    ? '\nВсе ключи упёрлись в лимиты. Добавьте ещё один ключ (кнопка «AI: ключи») или подождите — лимиты сбрасываются автоматически.'
    : (allDenied ? '\nПровайдер отклонил модели (403). На OpenRouter включите логирование промптов в настройках приватности или смените модель на платную — бесплатные модели блокируются (Security Policy).' : '');
  throw new Error('ИИ не ответил.\n' + lines.join('\n') + tail);
}

async function aiListModels(entry) {
  const e = entry || aiEntries()[0];
  if (!e || !e.baseUrl) return [];
  const headers = {};
  if (e.apiKey) headers['Authorization'] = 'Bearer ' + e.apiKey;
  try {
    const res = await fetch(e.baseUrl + '/models', { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const j = JSON.parse(await res.text());
    const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
    return arr.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
  } catch (e2) {
    return [];
  }
}

// Конструкции, которые проверка курса не принимает: ловим до отправки и правим.
const AI_FORBIDDEN = [
  { re: /^[ \t]*import[ \t]+/m, msg: 'import запрещён' },
  { re: /^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+/m, msg: 'from … import запрещён' },
  { re: /\bclass[ \t]+[A-Za-z_]\w*/m, msg: 'классы запрещены' },
  { re: /^[ \t]*try[ \t]*:/m, msg: 'try/except запрещён' },
  { re: /\bexcept\b/, msg: 'except запрещён' },
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

function aiNormalizeSteps(obj) {
  const arr = Array.isArray(obj) ? obj : (obj && (obj.steps || obj.plan || obj.hints || obj.solution)) || [];
  const steps = [];
  for (const s of arr) {
    if (!s) continue;
    if (typeof s === 'string') { steps.push({ comment: s.trim(), code: '' }); continue; }
    const comment = String(s.comment || s.hint || s.text || s.title || s.step || '').trim();
    const code = String(s.code || s.snippet || s.body || s.source || '').replace(/\r/g, '');
    if (comment || code) steps.push({ comment, code });
  }
  if (!steps.length) throw new Error('Модель не вернула ни одного шага.');
  return steps;
}

function aiBuildFile(steps) {
  const lines = [];
  const comments = [];
  for (const s of steps) {
    if (s.comment) {
      const c = s.comment.split('\n').map(l => (l.trim().startsWith('#') ? l : '# ' + l)).join('\n');
      lines.push(c);
      comments.push(c.split('\n')[0].trim());
    }
    if (s.code) {
      const code = s.code.replace(/\s+$/, '');
      if (code.trim()) lines.push(code);
    }
  }
  return { text: lines.join('\n') + '\n', comments };
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

function aiLog(obj) {
  try {
    const dir = path.join(os.tmpdir(), 'yandex-lms-diag');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ai-log.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.size > 2 * 1024 * 1024) {
        const old = path.join(dir, 'ai-log.old.jsonl');
        try { fs.rmSync(old, { force: true }); } catch (e) { }
        fs.renameSync(file, old);
      }
    } catch (e) { }
    fs.appendFileSync(file, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)) + '\n', 'utf8');
  } catch (e) { }
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
  // картинки (в т.ч. data-URI) → markdown
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

async function qrWebview(context) {
  const panel = vscode.window.createWebviewPanel(
    'yandexLmsQr',
    'Яндекс LMS — вход по QR',
    vscode.ViewColumn.One,
    { enableScripts: true, disableServiceWorker: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  const nonce = String(Math.random()).slice(2);
  const libUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'qrcode.min.js'));
  assignWebviewHtml(panel, `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource};">
<style>
 body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 28px; line-height: 1.6; }
 h1 { font-size: 1.3em; }
 .wrap { display: flex; gap: 28px; align-items: flex-start; flex-wrap: wrap; }
 .qr { background: #fff; padding: 16px; border-radius: 10px; line-height: 0; width: 292px; height: 292px; display: flex; align-items: center; justify-content: center; }
 .qr svg { width: 260px; height: 260px; }
 .steps { max-width: 420px; }
 .status { margin-top: 18px; font-size: 1.05em; }
 .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
 .err { color: var(--vscode-errorForeground, #f85149); }
 .wait { opacity: 0.85; }
 .link { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; opacity: 0.7; margin-top: 8px; }
 .spinner { display:inline-block; width:14px; height:14px; margin-right:8px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:sp 0.8s linear infinite; vertical-align:-2px;}
 @keyframes sp { to { transform: rotate(360deg); } }
 button { margin-top: 16px; font-size: 1em; padding: 7px 16px; border-radius: 4px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
</style>
</head>
<body>
<h1>Вход по QR-коду</h1>
<div class="wrap">
  <div class="qr" id="qrbox"></div>
  <div class="steps">
    <ol>
      <li>Откройте приложение <b>Яндекс</b> (или Яндекс Браузер) на телефоне.</li>
      <li>Нажмите значок <b>сканера / QR</b> рядом со строкой поиска.</li>
      <li>Наведите на код слева и подтвердите вход.</li>
    </ol>
    <div class="status wait" id="status"><span class="spinner"></span>Готовлю QR-код…</div>
    <div class="link" id="link"></div>
    <button id="cancel">Отмена</button>
  </div>
</div>
<script nonce="${nonce}" src="${libUri}"></script>
<script nonce="${nonce}">
  const statusEl = document.getElementById('status');
  const qrbox = document.getElementById('qrbox');
  const linkEl = document.getElementById('link');
  const vscode = acquireVsCodeApi();
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  function renderQr(link) {
    linkEl.textContent = link;
    if (typeof qrcode !== 'function') {
      statusEl.className = 'status err';
      statusEl.textContent = 'Не загрузилась библиотека QR. Откройте ссылку выше на телефоне вручную.';
      return;
    }
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      qrbox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 8 });
      statusEl.className = 'status wait';
      statusEl.innerHTML = '<span class="spinner"></span>Ожидаю подтверждения на телефоне…';
    } catch (e) {
      statusEl.className = 'status err';
      statusEl.textContent = 'Не удалось построить QR-код: ' + e;
    }
  }
  window.addEventListener('message', ev => {
    const m = ev.data || {};
    if (m.type === 'qr' && m.link) renderQr(m.link);
    if (m.type === 'status') {
      if (m.ok) {
        statusEl.className = 'status ok';
        statusEl.textContent = 'Вход выполнен. Окно можно закрыть.';
        qrbox.style.opacity = '0.25';
      } else if (m.error) {
        statusEl.className = 'status err';
        statusEl.textContent = m.error;
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`);
  return panel;
}

async function welcomeWebview(context) {
  const panel = vscode.window.createWebviewPanel(
    'yandexLmsWelcome',
    'Яндекс LMS — как пользоваться',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  const nonce = String(Math.random()).slice(2);
  assignWebviewHtml(panel, `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
 body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 28px; line-height: 1.6; max-width: 860px; }
 h1 { font-size: 1.4em; } h2 { font-size: 1.1em; margin-top: 24px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
 code, pre { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,0.15); padding: 2px 5px; border-radius: 3px; }
 pre { padding: 10px; overflow: auto; }
 kbd { border: 1px solid var(--vscode-panel-border); border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; font-size: 0.9em; }
 .btnrow { margin: 18px 0; }
 button { font-size: 1em; padding: 8px 16px; border-radius: 4px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
 ol li { margin-bottom: 6px; }
</style>
</head>
<body>
<h1>Яндекс LMS внутри VS Code</h1>
<div class="btnrow">
  <button id="qr">Войти по QR-коду (телефон)</button>
  <button id="login">Войти (логин и пароль Яндекса)</button>
  <button id="cookie">Войти по cookie</button>
</div>
<h2>1. Вход</h2>
<ol>
  <li><b>Самый удобный способ</b> — «Войти по QR-коду»: откройте QR-панель, наведите камеру из приложения «Яндекс» на телефоне и подтвердите вход. Пароль и 2FA не нужны.</li>
  <li><b>Логин и пароль</b> — «Войти (логин и пароль Яндекса)». Требуется аккаунт <b>без включённой 2FA</b>.</li>
  <li>Если QR или пароль не проходят: зайдите на <code>lms.yandex.ru</code> в браузере любым способом, затем DevTools (F12) → вкладка <b>Network</b> → любой запрос → <b>Request Headers</b> → скопируйте строку <code>Cookie</code> целиком и вставьте в команду «Войти по cookie». Вход сохранится навсегда (защищённое хранилище VS Code).</li>
</ol>
<h2>2. Работа с заданиями</h2>
<ol>
  <li>Слева откройте панель <b>Яндекс LMS</b> (иконка в activity bar) — там курсы → уроки → задачи.</li>
  <li>Клик по задаче открывает <b>два окна</b>: слева условие (webview), справа файл решения <code>.py</code> в обычном редакторе VS Code.</li>
  <li>Пишите код, сохраняйте — и жмите <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> (или кнопку «Отправить решение» в панели условия).</li>
  <li>Вердикт проверки (OK / wrong-answer / …) придёт в уведомление и в панель условия.</li>
</ol>
<h2>3. Полезные команды</h2>
<ul>
  <li><b>LMS: Запустить решение локально</b> — выполняет текущий файл через Python в терминале.</li>
  <li><b>LMS: Забрать решение из LMS</b> — подтягивает последний отправленный код в файл.</li>
  <li><b>LMS: Диагностика API</b> — проверяет соединение и пишет лог в Output (канал «Yandex LMS»). Если отправка не работает — пришлите этот лог, поправлю эндпоинты.</li>
</ul>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('qr').addEventListener('click', () => vscode.postMessage({ type: 'qr' }));
  document.getElementById('login').addEventListener('click', () => vscode.postMessage({ type: 'login' }));
  document.getElementById('cookie').addEventListener('click', () => vscode.postMessage({ type: 'cookie' }));
</script>
</body>
</html>`);
  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'qr') await vscode.commands.executeCommand('yandexLms.loginQr');
    if (msg.type === 'login') await vscode.commands.executeCommand('yandexLms.login');
    if (msg.type === 'cookie') await vscode.commands.executeCommand('yandexLms.loginByCookie');
  });
}

async function closeAllTabs() {
  try { await vscode.workspace.saveAll(false); } catch (e) { }
  const tabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const inp = tab.input;
      // Панель условия не закрываем: её пересоздание — единственный известный
      // путь, на котором VS Code срывает регистрацию service worker.
      if (inp && typeof inp.viewType === 'string' && inp.viewType.indexOf('yandexLmsTask') === 0) continue;
      tabs.push(tab);
    }
  }
  if (!tabs.length) return;
  let closed = false;
  try { closed = await vscode.window.tabGroups.close(tabs, true); } catch (e) { closed = false; }
  if (closed) return;
  try { await vscode.commands.executeCommand('workbench.action.closeAllEditors'); } catch (e) { }
}

async function activate(context) {
  const lms = new Lms(context);
  await lms.init();
  try {
    if (await lms.context.globalState.get('yandexLms.swBroken', false)) {
      await lms.context.globalState.update('yandexLms.swBroken', false);
      webviewLog('sw-broken-hint', {});
    }
  } catch (e) { }

  context.subscriptions.push(lms.statusBar, lms.taskStatusBar, lms.tree && { dispose: () => { } });
  // ИИ: пул ключей (несколько API, ротация по лимитам) — ключи в SecretStorage
  try {
    const raw = await context.secrets.get(AI_POOL_SECRET);
    if (raw) {
      const j = JSON.parse(raw);
      AI_POOL = Array.isArray(j.entries) ? j.entries : [];
      AI_POOL_STATE = j.state || {};
      AI_POOL_ACTIVE = j.active || null;
    }
  } catch (e) { }
  AI_POOL_PERSIST = (json) => context.secrets.store(AI_POOL_SECRET, json);
  aiPruneStates();
  // раз в сессию сканируем задания на картинки (фоном)
  setTimeout(() => { lms.autoScan = true; lms.scanImages().catch(() => { }); }, 8000);
  try { context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('lms', lms.docProvider)); } catch (e) { }
  // ИИ-автодополнение: подсказывает следующую строку решения по условию задачи
  const ac = new AiAutocomplete(lms);
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ language: 'python', pattern: '**/*.py' }, ac));
  context.subscriptions.push({ dispose: () => ac.cancel() });

  const lmsView = vscode.window.createTreeView('yandexLms.tree', { treeDataProvider: lms.tree, showCollapseAll: true });
  context.subscriptions.push(lmsView);
  // При открытии панели LMS (клик по иконке) закрываем все вкладки:
  // приветствие, открытые файлы и т.п. Перед закрытием сохраняем изменения,
  // чтобы ничего не потерять (dirty-вкладки иначе не закрываются).
  context.subscriptions.push(lmsView.onDidChangeVisibility(e => {
    if (!e.visible) return;
    closeAllTabs().catch(() => { });
  }));
  context.subscriptions.push(
    vscode.commands.registerCommand('yandexLms.login', async () => {
      const login = await vscode.window.showInputBox({ prompt: 'Логин Яндекса (почта)', ignoreFocusOut: true });
      if (!login) return;
      const password = await vscode.window.showInputBox({ prompt: 'Пароль Яндекса', password: true, ignoreFocusOut: true });
      if (!password) return;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: авторизация…' }, async () => {
          lms.jar.clear();
          const profile = await lms.client.loginWithPassword(login.trim(), password);
          lms.profileJson = profile;
          await lms.persist();
          await context.secrets.store(SECRET_LOGIN, login.trim());
          const name = pick(profile.profile, 'firstName', 'first_name', 'fullName', 'full_name', 'login');
          lms.statusBar.text = '$(check) LMS: ' + (name || login);
          lms.tree.refresh();
        });
        vscode.window.showInformationMessage('LMS: вход выполнен и сохранён.');
      } catch (e) {
        lms.jar.clear();
        await lms.persist();
        vscode.window.showErrorMessage('LMS: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.loginMenu', async () => {
      const items = [
        { label: '$(device-camera) Войти по QR-коду (телефон)', desc: 'Откроется QR — отсканируйте в приложении Яндекс', cmd: 'yandexLms.loginQr' },
        { label: '$(key) Войти (логин и пароль Яндекса)', desc: 'Без 2FA', cmd: 'yandexLms.login' },
        { label: '$(clippy) Войти по cookie', desc: 'Скопируйте Cookie из браузера', cmd: 'yandexLms.loginByCookie' },
        { label: '$(sign-out) Выйти', desc: 'Забыть сессию', cmd: 'yandexLms.logout' }
      ];
      const pickItem = await vscode.window.showQuickPick(items, { placeHolder: 'Яндекс LMS — вход' });
      if (!pickItem) return;
      await vscode.commands.executeCommand(pickItem.cmd);
    }),

    vscode.commands.registerCommand('yandexLms.loginQr', async () => {
      const abort = { cancelled: false };
      let panel;
      try {
        panel = await qrWebview(context);
      } catch (e) {
        vscode.window.showErrorMessage('LMS: не удалось открыть окно QR — ' + (e.message || e));
        return;
      }
      let link = null;
      let webviewReady = false;
      const pushLink = () => {
        if (!link || !webviewReady) return;
        try { panel.webview.postMessage({ type: 'qr', link }); } catch (e) { }
      };
      panel.onDidDispose(() => { abort.cancelled = true; });
      panel.webview.onDidReceiveMessage(async msg => {
        const m = msg || {};
        if (m.type === 'ready') {
          webviewReady = true;
          pushLink();
        }
        if (m.type === 'cancel') {
          abort.cancelled = true;
          try { panel.dispose(); } catch (e) { }
        }
      });
      let settled = false;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: ожидаю подтверждение QR…' }, async () => {
          lms.jar.clear();
          const profile = await lms.client.loginQr(async qrLink => {
            link = qrLink;
            pushLink();
          }, abort);
          settled = true;
          lms.profileJson = profile;
          await lms.persist();
          const name = pick(profile.profile, 'firstName', 'first_name', 'fullName', 'full_name', 'login');
          lms.statusBar.text = '$(check) LMS: ' + (name || 'вход выполнен');
          lms.tree.refresh();
        });
        try { panel.webview.postMessage({ type: 'status', ok: true }); } catch (e) { }
        vscode.window.showInformationMessage('LMS: вход по QR выполнен и сохранён.');
      } catch (e) {
        if (!settled) {
          lms.jar.clear();
          await lms.persist();
        }
        if (abort.cancelled) return;
        try { panel.webview.postMessage({ type: 'status', error: 'Ошибка: ' + (e.message || e) }); } catch (x) { }
        vscode.window.showErrorMessage('LMS: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.loginByCookie', async () => {
      const cookie = await vscode.window.showInputBox({
        prompt: 'Вставьте строку Cookie для lms.yandex.ru (F12 → Network → Request Headers → Cookie)',
        placeHolder: 'Session_id=...; yandexuid=...; csrftoken=...',
        ignoreFocusOut: true
      });
      if (!cookie) return;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: проверяю cookie…' }, async () => {
          lms.jar.clear();
          const profile = await lms.client.loginWithCookieString(cookie.trim());
          lms.profileJson = profile;
          await lms.persist();
          const name = pick(profile.profile, 'firstName', 'first_name', 'fullName', 'full_name', 'login');
          lms.statusBar.text = '$(check) LMS: ' + (name || 'вход выполнен');
          lms.tree.refresh();
        });
        vscode.window.showInformationMessage('LMS: вход по cookie выполнен и сохранён.');
      } catch (e) {
        lms.jar.clear();
        await lms.persist();
        vscode.window.showErrorMessage('LMS: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.logout', async () => {
      lms.jar.clear();
      lms.profileJson = null;
      await lms.persist();
      await context.secrets.delete(SECRET_LOGIN);
      lms.statusBar.text = '$(circle-slash) LMS: не вход';
      lms.tree.refresh();
      vscode.window.showInformationMessage('LMS: выход выполнен.');
    }),

    vscode.commands.registerCommand('yandexLms.refresh', async () => {
      if (!await lms.ensureAuth()) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: обновляю…' }, async () => {
        await lms.refreshProfile(false);
      });
    }),

    vscode.commands.registerCommand('yandexLms.openTask', async (node) => {
      if (!node) {
        vscode.window.showWarningMessage('LMS: выберите задачу в панели «Яндекс LMS».');
        return;
      }
      await lms.openTask(node);
    }),

    vscode.commands.registerCommand('yandexLms.submit', async (node) => {
      if (await lms.selectNode(node)) return;
      await lms.submitCurrent();
    }),

    vscode.commands.registerCommand('yandexLms.pullSolution', async (node) => {
      if (await lms.selectNode(node)) return;
      if (!lms.currentTask) {
        vscode.window.showWarningMessage('LMS: сначала откройте задание.');
        return;
      }
      await lms.pullSolution(lms.currentTask);
    }),

    vscode.commands.registerCommand('yandexLms.runLocal', async () => {
      await lms.runLocal();
    }),

    vscode.commands.registerCommand('yandexLms.openInBrowser', async (node) => {
      if (await lms.selectNode(node)) return;
      await lms.openCurrentInBrowser();
    }),

    vscode.commands.registerCommand('yandexLms.diagnose', async () => {
      await lms.diagnose();
    }),

    vscode.commands.registerCommand('yandexLms.showLog', async () => {
      lms.output().show(true);
    }),

    vscode.commands.registerCommand('yandexLms.collect', async () => {
      const r = await lms.collectReport('manual');
      lms.output().show(true);
      vscode.window.showInformationMessage('LMS: отчёт сохранён в ' + r.file);
    }),

    vscode.commands.registerCommand('yandexLms.taskMenu', async () => { await lms.taskMenu(); }),
    vscode.commands.registerCommand('yandexLms.findImages', async () => { await lms.scanImages(); }),
    vscode.commands.registerCommand('yandexLms.answer', async (node) => { if (await lms.selectNode(node)) return; await lms.markersPickAndSend(); }),
    vscode.commands.registerCommand('yandexLms.pep8', async (node) => { if (await lms.selectNode(node)) return; await lms.pep8Check(); }),
    vscode.commands.registerCommand('yandexLms.fixWebviewProfile', async () => {
      if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('LMS: закройте VS Code, удалите папку «Service Worker» в профиле и запустите VS Code снова.');
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        'Починка webview: VS Code закроется, очистится кэш service worker, VS Code запустится снова. Несохранённых данных нет?',
        { modal: true },
        'Перезапустить VS Code'
      );
      if (pick !== 'Перезапустить VS Code') return;
      try {
        const f = scheduleWebviewRepair();
        lms.output().appendLine('LMS: починка webview запланирована: ' + f);
      } catch (e) {
        vscode.window.showErrorMessage('LMS: не удалось запланировать починку: ' + (e.message || e));
      }
    }),
    vscode.commands.registerCommand('yandexLms.showPanel', async () => {
      lms.webviewBroken = false;
      lms.panelRetries = 0;
      if (lms.panel) { try { lms.panel.dispose(); } catch (e) { } lms.panel = null; }
      await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask && lms.currentTask.taskId)) || { title: lms.currentTask && lms.currentTask.taskTitle }, null);
    }),
    vscode.commands.registerCommand('yandexLms.showText', async () => { await lms.showTaskDoc(); }),
    vscode.commands.registerCommand('yandexLms.fixWebview', async () => {
      lms.webviewBroken = false;
      lms.panelRetries = 0;
      try {
        await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        vscode.window.showInformationMessage('LMS: webview перезагружены.');
      } catch (e) {
        vscode.window.showErrorMessage('LMS: не удалось перезагрузить webview: ' + (e.message || e));
      }
    }),
    vscode.commands.registerCommand('yandexLms.refreshStatus', async (node) => { if (await lms.selectNode(node)) return; await lms.reloadCurrentTask(); }),

    vscode.commands.registerCommand('yandexLms.aiHints', async (node) => { if (await lms.selectNode(node)) return; await lms.aiRun('hints'); }),
    vscode.commands.registerCommand('yandexLms.aiSolve', async (node) => { if (await lms.selectNode(node)) return; await lms.aiRun('solve'); }),
    vscode.commands.registerCommand('yandexLms.aiCheck', async (node) => { if (await lms.selectNode(node)) return; await lms.aiRun('check'); }),
    vscode.commands.registerCommand('yandexLms.aiFix', async (node) => { if (await lms.selectNode(node)) return; await lms.aiFix(); }),
    vscode.commands.registerCommand('yandexLms.details', async (node) => { if (await lms.selectNode(node)) return; const d = await lms.refreshContestLogs(); await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask && lms.currentTask.taskId)) || { title: lms.currentTask && lms.currentTask.taskTitle }, null); vscode.window.showInformationMessage(d ? 'LMS: подробности проверки показаны в панели.' : 'LMS: деталей проверки нет (задача ещё не проверялась).'); }),
    vscode.commands.registerCommand('yandexLms.aiForget', async () => {
      lms.aiLessons = [];
      await lms.context.globalState.update('yandexLms.aiLessons', []);
      if (lms.currentTask) {
        await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask.taskId)) || { title: lms.currentTask.taskTitle }, null);
      }
      vscode.window.showInformationMessage('LMS: память ошибок очищена.');
    }),
    vscode.commands.registerCommand('yandexLms.aiClear', async (node) => { if (await lms.selectNode(node)) return; await lms.aiClear(); }),
    vscode.commands.registerCommand('yandexLms.aiKeys', async () => { await lms.aiKeysUI(); }),
    vscode.commands.registerCommand('yandexLms.aiSettings', async () => { await lms.aiSettingsUI(); }),
    vscode.commands.registerCommand('yandexLms.aiTest', async () => { await lms.aiTest(); }),

    vscode.commands.registerCommand('yandexLms.testPanel', async () => {
      webviewLog('test-start', {});
      const p = vscode.window.createWebviewPanel('yandexLmsTest', 'Тест панели LMS', vscode.ViewColumn.One, { enableScripts: true, disableServiceWorker: true });
      p.webview.onDidDispose(() => webviewLog('test-disposed', {}));
      p.webview.onDidReceiveMessage(msg => webviewLog('test-msg', { type: String(msg && msg.type) }));
      p.webview.html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>test</title></head><body><p id="x">живой</p><script>document.getElementById("x").textContent="живой "+Date.now();acquireVsCodeApi().postMessage({type:"alive"});</script></body></html>';
      webviewLog('test-assigned', {});
    }),

    vscode.commands.registerCommand('yandexLms.welcome', async () => {
      await welcomeWebview(context);
    })
  );

  const seen = await context.globalState.get('yandexLms.welcomeShown');
  if (!seen && lms.jar.isEmpty()) {
    await context.globalState.update('yandexLms.welcomeShown', true);
    await welcomeWebview(context);
  }
}

function deactivate() { }

module.exports = { activate, deactivate };
