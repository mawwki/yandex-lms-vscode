// Один запрос к ИИ (HTTP OpenAI-совместимый API или OpenCode CLI) и оркестрация:
// ротация ключей пула, ретраи, hedge-ускорение.
const { cfg } = require('../cfg');
const { aiLog } = require('../diag');
const pool = require('./pool');
const { runOpenCode, openCodeModels } = require('./opencode');
const { runCline, clineModels } = require('./cline');

function aiError(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

async function aiChatOnce(entry, prompt, system, timeoutMs, images, opts, ctl) {
  if (entry.provider === 'opencode') {
    // opencode run — это агент: на решение задачи нужно заметно больше времени,
    // чем обычному API. Жёсткий минимум 4 минуты независимо от бюджета aiChat.
    const r = await runOpenCode(entry, prompt, system, Math.max(Number(timeoutMs) || 0, 240000));
    return r;
  }
  if (entry.provider === 'cline') {
    // cline — тоже агент: тот же минимум времени, что у opencode.
    const r = await runCline(entry, prompt, system, Math.max(Number(timeoutMs) || 0, 240000));
    return r;
  }

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
    aiLog({ event: 'http-error', entry: pool.aiEntryLabel(entry), key: pool.aiKeyTail(entry.apiKey), error: String(e.name || '') + ' ' + String(e.message || e), ms });
    if (e.name === 'AbortError' || /abort|timeout/i.test(String(e.message || ''))) {
      throw aiError('«' + entry.model + '» не ответила за ' + Math.round(limit / 1000) + ' с', { timeout: true, retryable: true, kind: 'error' });
    }
    throw aiError('нет связи с ' + entry.baseUrl + ' (' + (e.message || e) + ')', { retryable: true, kind: 'error' });
  }
  let text = await res.text();
  if (!res.ok && useImages) {
    aiLog({ event: 'images-retry', entry: pool.aiEntryLabel(entry), status: res.status });
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
    aiLog({ event: 'http-fail', entry: pool.aiEntryLabel(entry), key: pool.aiKeyTail(entry.apiKey), status: res.status, ms, msg: String(msg).slice(0, 200) });
    const kind = res.status === 401 ? 'auth' : (res.status === 403 ? 'denied' : ((res.status === 402 || res.status === 429) ? 'limit' : 'error'));
    throw aiError('API ' + res.status + ': ' + msg, { status: res.status, retryAfterMs: retryAfterS > 0 ? retryAfterS * 1000 : 0, retryable: true, kind });
  }
  aiLog({ event: 'http', entry: pool.aiEntryLabel(entry), key: pool.aiKeyTail(entry.apiKey), status: res.status, ms, withImages: useImages });
  let json;
  try { json = JSON.parse(text); } catch (e) { throw aiError('ответ API не JSON: ' + text.slice(0, 200), { retryable: true }); }
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  const rawContent = msg ? msg.content : (json.choices && json.choices[0] ? json.choices[0].text : '');
  // Мультимодальные/нестандартные API отдают content массивом частей:
  // String([...]) дал бы «[object Object]» и затёр бы файл решения.
  const content = Array.isArray(rawContent)
    ? rawContent.map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('')
    : rawContent;
  if (!content) throw aiError('модель вернула пустой ответ', { retryable: true });
  return { text: String(content), ms };
}

async function aiChat(prompt, system, timeoutMs, images, opts) {
  const o = opts || {};
  const all = pool.aiOrdered();
  if (!all.length) throw new Error('ИИ не настроен: добавьте ключ или OpenCode CLI — «LMS: AI — ключи и провайдеры».');
  const budget = Math.max(5000, Number(timeoutMs) || 90000);
  const deadline = Date.now() + budget;
  const maxTries = Math.max(1, Math.min(all.length, Number(cfg().get('ai.retries') || 3)));
  const list = all.slice(0, maxTries);
  const hedge = cfg().get('ai.hedge') !== false && o.hedge !== false && list.length > 1;
  const hedgeDelay = Math.max(1500, Number(cfg().get('ai.hedgeDelay') || 7000));

  const controllers = new Set();
  // pending хранит обёртки, которые сами себя убирают при завершении: по значению
  // из Promise.race нельзя удалить промис (indexOf вернёт -1) — это когда-то
  // давало бесконечный цикл ретраев.
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
        pool.aiMarkOk(r.entry, r.ms);
        abortAll();
        return r.text;
      }
      pool.aiMarkFail(r.entry, r.err, o.noPenalty);
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
    return pool.aiEntryLabel(x.entry) + ' [' + pool.aiKeyTail(x.entry.apiKey) + '] — ' + st + ': ' + String((x.err && x.err.message) || x.err || '').slice(0, 140);
  });
  const kinds = errors.map(x => (x.err && x.err.kind) || 'error');
  const allLimited = errors.length && kinds.every(k => k === 'limit');
  const allDenied = errors.length && kinds.every(k => k === 'denied' || k === 'auth');
  const tail = allLimited
    ? '\nВсе ключи упёрлись в лимиты. Добавьте ещё один ключ (или OpenCode CLI) или подождите — лимиты сбрасываются автоматически.'
    : (allDenied ? '\nПровайдер отклонил модели (403). На OpenRouter включите логирование промптов в настройках приватности или смените модель на платную — бесплатные модели блокируются (Security Policy).' : '');
  throw new Error('ИИ не ответил.\n' + lines.join('\n') + tail);
}

async function aiListModels(entry) {
  const e = entry || pool.aiEntries()[0];
  if (!e) return [];
  if (e.provider === 'opencode') {
    return openCodeModels(e);
  }
  if (e.provider === 'cline') {
    return clineModels(e);
  }
  if (!e.baseUrl) return [];
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

module.exports = { aiChat, aiChatOnce, aiListModels, aiError };
