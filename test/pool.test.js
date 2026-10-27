// Тесты пула ИИ-ключей: стабильные id и перенос состояния при миграции.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const vscodeStub = new Proxy({
  workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => { } }) }
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return function stub() { };
  }
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const pool = require(path.join(__dirname, '..', 'src/ai/pool.js'));

// id в старых версиях — хеш содержимого записи.
function legacyId(e) {
  return crypto.createHash('sha1')
    .update([e.provider || '', e.baseUrl || '', e.bin || '', e.model || '', e.apiKey || ''].join('|'))
    .digest('hex').slice(0, 12);
}

test('initPool переносит состояние и «основной» ключ на стабильные id', async () => {
  const legacy = { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', apiKey: 'sk-old' };
  const oldId = legacyId(legacy);
  const stored = {
    entries: [legacy],
    state: { [oldId]: { until: Date.now() + 5 * 60 * 1000, kind: 'limit', lastError: '429' } },
    active: oldId
  };
  let saved = null;
  const context = {
    secrets: {
      get: async () => JSON.stringify(stored),
      store: async (key, value) => { saved = value; }
    }
  };

  await pool.initPool(context);
  const entries = pool.aiEntries();
  assert.strictEqual(entries.length, 1);
  const e = entries[0];

  assert.ok(e.id && e.id !== oldId, 'id должен смениться на новый');
  assert.strictEqual(pool.AI_POOL_ACTIVE_REF(), e.id, 'основной ключ потерялся');
  assert.ok(pool.aiCooldownLeft(e) > 0, 'кулдаун потерялся при миграции');
  assert.match(e.id, /^[0-9a-f]{12}$/);
  // новая схема уходит в хранилище
  assert.ok(saved === null || JSON.parse(saved).entries[0].id === e.id);
});

test('id не меняется при правке модели, ключа и адреса', () => {
  pool.poolAdd({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', apiKey: 'k-1', label: 'Mistral' });
  let entry = pool.aiEntries().find(x => x.apiKey === 'k-1');
  const id = entry.id;
  assert.ok(id);

  pool.poolSetModel(id, 'mistral-large-latest');
  entry = pool.aiEntries().find(x => x.id === id);
  assert.ok(entry, 'запись должна остаться с тем же id');
  assert.strictEqual(entry.model, 'mistral-large-latest');

  pool.poolSetPrimary(id);
  assert.strictEqual(pool.AI_POOL_ACTIVE_REF(), id);

  pool.poolReplace(id, Object.assign({}, entry, { apiKey: 'k-2' }));
  const after = pool.aiEntries().find(x => x.id === id);
  assert.ok(after, 'poolReplace не должен менять id');
  assert.strictEqual(after.apiKey, 'k-2');
});

test('дубль по содержимому не добавляется дважды', () => {
  const draft = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'dup-key', label: 'OpenAI' };
  const id1 = pool.poolAdd(draft);
  const id2 = pool.poolAdd(Object.assign({}, draft, { label: 'OpenAI 2' }));
  assert.strictEqual(id1, id2);
  assert.strictEqual(pool.aiEntries().filter(e => e.apiKey === 'dup-key').length, 1);
});

test('запись без id (старый формат) считается по хешу и удаляется', () => {
  const legacy = { provider: 'custom', baseUrl: 'https://a.example/v1', model: 'm', apiKey: 'old-style' };
  const id = pool.aiEntryId(legacy);
  assert.strictEqual(id, legacyId(legacy));
  pool.poolAdd(Object.assign({ id: id }, legacy));
  assert.ok(pool.aiEntries().some(e => e.id === id));
  pool.poolRemove(id);
  assert.ok(!pool.aiEntries().some(e => e.id === id));
});
