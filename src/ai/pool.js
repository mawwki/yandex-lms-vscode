// Пул ИИ-ключей: несколько провайдеров/ключей (включая OpenCode CLI) с ротацией
// по лимитам. Хранится в SecretStorage VS Code — ключи не лежат в settings.json.
const crypto = require('crypto');
const { cfg } = require('../cfg');
const { AI_PROVIDERS, providerDef } = require('./providers');
const { aiLog } = require('../diag');

const AI_POOL_SECRET = 'yandexLms.aiPool';
let AI_POOL = [];
let AI_POOL_STATE = {};
let AI_POOL_ACTIVE = null;
let AI_POOL_PERSIST = null;
let AI_POOL_SAVE_TIMER = null;

function newEntryId() {
  return crypto.randomBytes(6).toString('hex');
}

// Id записи стабильный: хранится в самой записи. Раньше это был хеш содержимого,
// поэтому после смены модели или ключа «основной» ключ и замеры времени
// оставались привязаны к несуществующей записи. Хеш остался только для
// записей из старых версий (у них ещё нет поля id).
function aiEntryId(e) {
  if (e && e.id) return e.id;
  return crypto.createHash('sha1').update([e.provider || '', e.baseUrl || '', e.bin || '', e.model || '', e.apiKey || ''].join('|')).digest('hex').slice(0, 12);
}

// Содержимое записи — для поиска дублей (id у них может быть разный).
function aiEntryKey(e) {
  return crypto.createHash('sha1').update([e.provider || '', e.baseUrl || '', e.bin || '', e.model || '', e.apiKey || ''].join('|')).digest('hex');
}

function aiEntryLabel(e) {
  const p = providerDef(e.provider);
  return (e.label || p.label || e.provider || '?') + ' · ' + (e.model || '?');
}

function aiKeyTail(key) {
  const s = String(key || '');
  return s ? '••••' + s.slice(-4) : 'локальная';
}

// Инициализация при активации: загружаем пул из SecretStorage и, если он пуст,
// переносим легаси-ключ из настроек (после чего затираем его в settings.json).
async function initPool(context) {
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
  aiAssignIds();
  // Легаси-ключ из settings.json добавляем в пул всегда (если такого ещё нет) —
  // так новые провайдеры можно добавлять простым дописыванием в настройки.
  await migrateLegacyKey();
  aiPruneStates();
}

// Миграция на стабильные id: у записей старых версий id был хешем содержимого.
// Переносим на новый id и заодно переносим состояние лимитов и «основной» ключ.
function aiAssignIds() {
  let changed = false;
  const remap = new Map();
  for (const e of AI_POOL) {
    if (!e || e.provider === 'none') continue;
    if (!e.id) {
      remap.set(aiEntryId(e), newEntryId());
      changed = true;
    }
  }
  if (!changed) return;
  for (const e of AI_POOL) {
    if (!e) continue;
    const next = remap.get(aiEntryId(e));
    if (next) e.id = next;
  }
  const state = {};
  for (const k of Object.keys(AI_POOL_STATE)) state[remap.get(k) || k] = AI_POOL_STATE[k];
  AI_POOL_STATE = state;
  if (AI_POOL_ACTIVE) AI_POOL_ACTIVE = remap.get(AI_POOL_ACTIVE) || AI_POOL_ACTIVE;
  aiPersistSoon();
}

async function migrateLegacyKey() {
  try {
    const c = cfg();
    const provider = c.get('ai.provider');
    if (!provider || provider === 'none') return;
    const def = providerDef(provider);
    const model = String(c.get('ai.model') || def.model || '');
    const apiKey = String(c.get('ai.apiKey') || '');
    let cand;
    if (provider === 'opencode' || provider === 'cline') {
      // Локальные агенты: ключ и baseUrl не нужны — нужна модель, бинарник опционален.
      if (!model) return;
      cand = { provider, model, apiKey: '', bin: String(c.get('ai.bin') || def.bin || provider) };
    } else {
      if (!apiKey) return;
      const baseUrl = String(c.get('ai.baseUrl') || def.baseUrl || '').replace(/\/+$/, '');
      if (!baseUrl || !model) return;
      cand = { provider, baseUrl, model, apiKey };
    }
    // «Cline CLI (локальный агент)» → «Cline CLI»: в строке статуса кратко.
    cand.label = def.label.replace(/\s*\(.*\)\s*$/, '');
    const key = aiEntryKey(cand);
    if (AI_POOL.some(e => aiEntryKey(e) === key)) return; // уже в пуле
    cand.id = newEntryId();
    AI_POOL.push(cand);
    // Миграция — это последнее, что настроил пользователь: запись сразу активна.
    AI_POOL_ACTIVE = cand.id;
    if (apiKey) {
      // Ключ больше не должен лежать в открытом settings.json.
      await c.update('ai.apiKey', undefined, globalConfigTarget());
    }
    aiLog({ event: 'legacy-key-migrated', provider, model });
    aiPersistSoon();
  } catch (e) { }
}

function globalConfigTarget() {
  // vscode.ConfigurationTarget.Global
  return 1;
}

function aiEntries() {
  const out = [];
  const seen = new Set();
  for (const e of AI_POOL) {
    if (!e || !e.provider || e.provider === 'none') continue;
    let entry;
    if (e.provider === 'opencode' || e.provider === 'cline') {
      if (!e.model) continue;
      entry = Object.assign({ bin: e.provider }, e, { id: aiEntryId(e) });
    } else {
      if (!e.baseUrl || !e.model) continue;
      if (!e.apiKey && e.provider !== 'ollama') continue;
      entry = Object.assign({}, e, { id: aiEntryId(e) });
    }
    const key = aiEntryKey(entry);
    if (seen.has(key)) continue; // защита от дублей
    seen.add(key);
    out.push(entry);
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

function aiPersistNow() {
  if (!AI_POOL_PERSIST) return;
  try { AI_POOL_PERSIST(JSON.stringify({ entries: AI_POOL, state: AI_POOL_STATE, active: AI_POOL_ACTIVE })); } catch (e) { }
}

function aiPersistSoon() {
  if (!AI_POOL_PERSIST) return;
  if (AI_POOL_SAVE_TIMER) clearTimeout(AI_POOL_SAVE_TIMER);
  AI_POOL_SAVE_TIMER = setTimeout(() => {
    AI_POOL_SAVE_TIMER = null;
    aiPersistNow();
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

function aiResetStates() {
  AI_POOL_STATE = {};
  aiPersistSoon();
}

// Мутации пула из UI.
function poolAdd(entry) {
  const e = Object.assign({}, entry);
  const key = aiEntryKey(e);
  const dup = AI_POOL.find(x => aiEntryKey(x) === key);
  if (dup) return aiEntryId(dup);
  if (!e.id) e.id = newEntryId();
  AI_POOL.push(e);
  aiPersistSoon();
  return e.id;
}

function poolReplace(id, entry) {
  const idx = AI_POOL.findIndex(e => aiEntryId(e) === id);
  const next = Object.assign({}, entry, { id: id });
  if (idx >= 0) AI_POOL[idx] = next;
  else AI_POOL.push(next);
  aiPersistSoon();
}

function poolRemove(id) {
  AI_POOL = AI_POOL.filter(e => aiEntryId(e) !== id);
  delete AI_POOL_STATE[id];
  aiPersistSoon();
}

function poolSetPrimary(id) {
  AI_POOL_ACTIVE = id;
  const idx = AI_POOL.findIndex(e => aiEntryId(e) === id);
  if (idx > 0) AI_POOL.unshift(AI_POOL.splice(idx, 1)[0]);
  aiPersistSoon();
}

function poolSetModel(id, model) {
  const idx = AI_POOL.findIndex(e => aiEntryId(e) === id);
  if (idx >= 0) AI_POOL[idx].model = model;
  aiPersistSoon();
}

function poolClearState(id) {
  delete AI_POOL_STATE[id];
  aiPersistSoon();
}

function poolRaw() {
  return AI_POOL;
}

function activeId() {
  return AI_POOL_ACTIVE;
}

function stateOf(entry) {
  return entry && entry.id ? (AI_POOL_STATE[entry.id] || null) : null;
}

module.exports = {
  AI_POOL_SECRET, initPool, aiEntries, aiHasConfig, aiCooldownLeft, aiPruneStates,
  aiOrdered, aiMarkOk, aiMarkFail, aiResetStates, aiEntryId, aiEntryKey, aiEntryLabel, aiKeyTail,
  poolAdd, poolReplace, poolRemove, poolSetPrimary, poolSetModel, poolClearState,
  poolRaw, aiPersistNow, AI_POOL_ACTIVE_REF: activeId, stateOf
};
