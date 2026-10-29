// HTTP-клиент Яндекс LMS: куки, CSRF, QR/пароль/cookie-вход, отправка решения.
// Эндпоинты зафиксированы по результатам реверса SPA (см. diagnose — только по команде).
// У каждого запроса есть таймаут: зависший fetch не вешает расширение.
const crypto = require('crypto');
const { CookieJar } = require('./cookies');
const { sleep, pick } = require('./util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30000;

class LmsClient {
  constructor(jar, base) {
    this.jar = jar || new CookieJar();
    this.base = String(base || 'https://lms.yandex.ru').replace(/\/$/, '');
    this.passport = 'https://passport.yandex.ru';
    this.passportCsrf = '';
    this.onAttempt = null;
  }

  async raw(method, url, opts = {}) {
    let current = url;
    let curMethod = method;
    let curBody = opts.body;
    const extraHeaders = opts.headers || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    for (let hop = 0; hop < (opts.maxRedirects === undefined ? 12 : opts.maxRedirects); hop++) {
      const headers = Object.assign({ 'User-Agent': UA, 'Accept': '*/*' }, extraHeaders);
      const ck = this.jar.headerFor(current);
      if (ck) headers['Cookie'] = ck;
      const res = await fetch(current, {
        method: curMethod,
        headers,
        body: curBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
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

  // Куки по имени. В jar ключ — «domain|path|name», поэтому map.get('csrftoken')
  // всегда возвращал undefined: POST уходил без X-CSRF-Token, и сервер отвечал
  // 403 на все изменяющие запросы (GET при этом работали).
  // Одноимённые куки бывают на разных доменах — берём самую конкретную.
  cookieValue(name) {
    const now = Date.now();
    const host = new URL(this.base).hostname;
    let best = null;
    for (const c of this.jar.map.values()) {
      if (c.name !== name) continue;
      if (c.expires && c.expires < now) continue;
      const domainOk = host === c.domain || host.endsWith('.' + c.domain);
      if (!domainOk) continue;
      if (!best || String(c.domain).length > String(best.domain).length) best = c;
    }
    return best ? best.value : '';
  }

  // CSRF-токен выдаётся вместе с HTML-страницей LMS. Если куки нет (вход по QR
  // или паролю её не получает) — забираем страницу и берём токен оттуда.
  async ensureCsrf(force) {
    if (!force) {
      const have = this.cookieValue('csrftoken');
      if (have) return have;
    }
    const urls = ['/', '/api/profile'];
    for (const u of urls) {
      try {
        const res = await this.raw('GET', this.base + u, {
          headers: { 'Accept': u === '/' ? 'text/html,application/xhtml+xml' : 'application/json' },
          timeoutMs: 15000
        });
        await res.text().catch(() => '');
      } catch (e) { }
      const t = this.cookieValue('csrftoken');
      if (t) return t;
    }
    return this.cookieValue('csrftoken');
  }

  apiHeaders() {
    const h = {
      'Accept': 'application/json, text/plain, */*',
      'Referer': this.base + '/',
      'Origin': this.base,
      'X-Request-Id': crypto.randomUUID()
    };
    const csrf = this.cookieValue('csrftoken');
    if (csrf) {
      h['X-CSRF-Token'] = csrf;
      h['X-CSRFToken'] = csrf;
    }
    return h;
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

  // Материалы урока (учебники). В SPA список берётся из /api/student/lessons/...,
  // через прокси тот же путь тоже работает — оставляем фолбэк на случай
  // различий между контурами LMS.
  async lessonMaterials(courseId, lessonId, groupId) {
    const urls = [
      `/api/student/lessons/${lessonId}/groups/${groupId}/materials?groupId=${groupId}`,
      `/api/proxy/student/lessons/${lessonId}/groups/${groupId}/materials?groupId=${groupId}`
    ];
    let last = null;
    for (const u of urls) {
      try {
        last = await this.api('GET', u);
        if (last.status === 200 && last.json) return last;
      } catch (e) {
        last = { status: 0, json: null, text: String(e.message || e), url: u };
      }
    }
    return last || { status: 0, json: null, text: 'нет ответа', url: '' };
  }

  // Детали материала: сайт ходит именно через /api/proxy/materials/<id>.
  // Прямой /api/materials/<id> отдаёт 404, но пусть будет фолбэком.
  async material(materialId, lessonId) {
    const qs = lessonId !== undefined && lessonId !== null ? `?lessonId=${lessonId}` : '';
    const urls = [
      `/api/proxy/materials/${materialId}${qs}`,
      `/api/proxy/materials/${materialId}`,
      `/api/materials/${materialId}${qs}`,
      `/api/materials/${materialId}`
    ].filter((u, i, a) => a.indexOf(u) === i);
    let last = null;
    for (const u of urls) {
      try {
        last = await this.api('GET', u);
        if (last.status === 200 && last.json) return last;
      } catch (e) {
        last = { status: 0, json: null, text: String(e.message || e), url: u };
      }
    }
    return last || { status: 0, json: null, text: 'нет ответа', url: '' };
  }

  async solution(solutionId) {
    return this.api('GET', `/api/student/solutions/${solutionId}`);
  }

  // Отправка решения: основной эндпоинт + два фолбэка. Раньше здесь было ~20
  // попыток наугад — медленно и с побочными POST; теперь только проверенные ручки.
  async submitSolution(ctx, code) {
    const compilerId = ctx.compilerId;
    const sid = ctx.solutionId;
    const attempts = [];
    // Токен нужен до первого POST: без него сервер отвечает 403.
    await this.ensureCsrf();
    const tryOne = async (label, method, apiUrl, opts = {}, retried) => {
      let res;
      let reqBody = '';
      try {
        if (typeof opts.body === 'string') reqBody = opts.body.slice(0, 2000);
      } catch (e) { }
      // Заголовки собираем на каждую попытку заново: после обновления CSRF
      // токен в них должен быть уже новый.
      const headers = Object.assign(this.apiHeaders(), opts.headers || {});
      try {
        res = await this.raw(method, apiUrl.startsWith('http') ? apiUrl : this.base + apiUrl,
          Object.assign({}, opts, { headers }));
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
      // 403 на POST — почти всегда протухший CSRF-токен. Обновляем его
      // страницей LMS и один раз повторяем тот же запрос.
      if (res.status === 403 && !retried) {
        const fresh = await this.ensureCsrf(true);
        if (fresh) {
          // FormData пересобираем: тело первого запроса уже отправлено.
          let body = opts.body;
          if (body instanceof FormData) {
            const copy = new FormData();
            for (const [k, v] of body) copy.append(k, v);
            body = copy;
          }
          return tryOne(label + ' (после обновления CSRF)', method, apiUrl, Object.assign({}, opts, { body }), true);
        }
      }
      return null;
    };

    const multipart = (fileName, mime, payload) => {
      const f = new FormData();
      f.append('file', new Blob([payload], { type: mime }), fileName);
      // _internal_lms_txt — служебный «компилятор» для текстовых ответов,
      // его сайт в поле compiler_id не передаёт.
      if (compilerId !== undefined && compilerId !== null && compilerId !== '_internal_lms_txt') {
        f.append('compiler_id', String(compilerId));
      }
      return { body: f };
    };

    if (sid) {
      // Основная ручка (то, что использует сам сайт: /api + /student/... при bff).
      const r1 = await tryOne('POST /api/student/solutions/<id>/comments/files', 'POST',
        `/api/student/solutions/${sid}/comments/files`,
        multipart('solution.py', 'text/x-python', code));
      if (r1) return { result: r1, attempts, solutionId: sid };
      // Фолбэк 1: тот же путь через прокси.
      const r2 = await tryOne('POST /api/proxy/student/solutions/<id>/comments/files', 'POST',
        `/api/proxy/student/solutions/${sid}/comments/files`,
        multipart('solution.py', 'text/x-python', code));
      if (r2) return { result: r2, attempts, solutionId: sid };
      // Фолбэк 2: JSON-ручка отправки.
      const body = compilerId === undefined ? { code } : { code, compiler_id: compilerId };
      const r3 = await tryOne('POST /api/student/problem/submission?solutionId=<id>', 'POST',
        `/api/student/problem/submission?solutionId=${sid}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r3) return { result: r3, attempts, solutionId: sid };
    }

    // Решения на сервере нет — создаём и отправляем.
    const create = await tryOne('POST /api/student/solutions (создать решение)', 'POST', '/api/student/solutions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: ctx.taskId, task_id: ctx.taskId, compilerId })
    });
    let newSid = sid;
    if (create && create.json) {
      newSid = pick(create.json, 'id') || pick(create.json.solution, 'id') || pick(create.json.data, 'id') || sid;
    }
    if (newSid && newSid !== sid) {
      const r4 = await tryOne('POST /api/student/solutions/<id>/submission', 'POST',
        `/api/student/solutions/${newSid}/submission`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compilerId === undefined ? { code } : { code, compilerId })
      });
      if (r4) return { result: r4, attempts, solutionId: newSid };
    }
    return { result: null, attempts, solutionId: newSid };
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
    const check = await this.profile();
    if (check.status !== 200 || !check.json) {
      throw new Error('Вход не подтверждён сервером (HTTP ' + check.status + '). Используйте «Войти по cookie».');
    }
    // Токен CSRF выдаётся вместе со страницей LMS: забираем сразу после входа,
    // иначе первый POST (отправка решения) получит 403.
    try { await this.ensureCsrf(); } catch (e) { }
    return check.json;
  }

  async loginWithCookieString(cookieLine) {
    for (const part of cookieLine.split(';')) {
      const s = part.trim();
      if (!s) continue;
      this.jar.storeOne(s, 'lms.yandex.ru');
    }
    const check = await this.profile();
    if (check.status !== 200 || !check.json) {
      throw new Error('С cookie не удалось получить профиль (HTTP ' + check.status + '). Проверьте, что скопированы все куки lms.yandex.ru.');
    }
    // Токен CSRF выдаётся вместе со страницей LMS: забираем сразу после входа,
    // иначе первый POST (отправка решения) получит 403.
    try { await this.ensureCsrf(); } catch (e) { }
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

    const check = await this.profile();
    if (check.status !== 200 || !check.json) {
      throw new Error('QR-вход получен, но профиль LMS недоступен (HTTP ' + check.status + '). Используйте «Войти по cookie».');
    }
    // Токен CSRF выдаётся вместе со страницей LMS: забираем сразу после входа,
    // иначе первый POST (отправка решения) получит 403.
    try { await this.ensureCsrf(); } catch (e) { }
    return check.json;
  }
}

module.exports = { LmsClient, UA, DEFAULT_TIMEOUT_MS };
