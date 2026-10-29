// Google Объектив: разбор кук, проверка ответа Google и загрузка снимка.
// Сеть подменяется — тесты не ходят в Google.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return {};
  return origLoad.apply(this, arguments);
};

const {
  Lens, parseCookieHeader, cookieFromSetCookie, mergeCookies,
  cookiesFor, cookieHeaderFor, isBotPage, absoluteUrl, uploadBody, lensUploadHtml
} = require('../src/lens');

test('parseCookieHeader понимает строку Cookie и не берёт дубли', () => {
  const list = parseCookieHeader('Cookie: NID=abc; SID=def; NID=old\n');
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map(c => c.name), ['NID', 'SID']);
  assert.strictEqual(list[0].domain, 'google.com');
});

test('cookieFromSetCookie нормализует домен google.com и читает Expires', () => {
  const c = cookieFromSetCookie('NID=abc; Domain=.google.com; Path=/; Expires=Wed, 21 Oct 2027 07:28:00 GMT', 'www.google.com');
  assert.strictEqual(c.name, 'NID');
  assert.strictEqual(c.value, 'abc');
  assert.strictEqual(c.domain, 'google.com');
  assert.ok(c.expires > Date.now());
});

test('mergeCookies заменяет совпадающие куки и выбрасывает просроченные', () => {
  const old = [{ name: 'A', value: '1', domain: 'google.com', path: '/', expires: 0 }];
  const out = mergeCookies(old, [
    { name: 'A', value: '2', domain: 'google.com', path: '/', expires: 0 },
    { name: 'B', value: '3', domain: 'google.com', path: '/', expires: Date.now() - 1000 }
  ]);
  assert.deepStrictEqual(out.map(c => c.name + '=' + c.value), ['A=2']);
});

test('cookiesFor и cookieHeaderFor выбирают куки по хосту', () => {
  const list = [
    { name: 'A', value: '1', domain: 'google.com', path: '/', expires: 0 },
    { name: 'B', value: '2', domain: 'example.com', path: '/', expires: 0 }
  ];
  assert.deepStrictEqual(cookiesFor(list, 'lens.google.com').map(c => c.name), ['A']);
  assert.strictEqual(cookieHeaderFor(list, 'https://lens.google.com/'), 'A=1');
});

test('isBotPage узнаёт проверку на робота, absoluteUrl достраивает адрес', () => {
  assert.strictEqual(isBotPage('Our systems have detected unusual traffic'), true);
  assert.strictEqual(isBotPage('обычная страница'), false);
  assert.strictEqual(absoluteUrl('/search?q=1'), 'https://lens.google.com/search?q=1');
});

test('uploadBody собирает multipart с PNG и размерами', () => {
  const png = Buffer.from([1, 2, 3, 4]);
  const { boundary, body } = uploadBody(png, 12, 34);
  const text = body.toString('latin1');
  assert.ok(boundary.startsWith('----LensBoundary'));
  assert.ok(text.includes('name="encoded_image"'));
  assert.ok(text.includes('name="processed_image_dimensions"'));
  assert.ok(text.includes('12,34'));
  assert.ok(body.includes(png), 'PNG лежит в теле как есть');
  assert.ok(!text.includes('name="q"'), 'без запроса поле q не добавляется');
});

test('uploadBody добавляет текстовый запрос q — иначе Google открывает пустой AI Mode', () => {
  const png = Buffer.from([1, 2, 3, 4]);
  const { body } = uploadBody(png, 12, 34, 'Всем привет — реши задачу');
  const text = body.toString('utf8');
  assert.ok(text.includes('name="q"'));
  assert.ok(text.includes('Всем привет — реши задачу'));
});

test('lensUploadHtml собирает страницу с формой, запросом и встроенным PNG', () => {
  const b64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
  const html = lensUploadHtml(b64, 900, 538, 12345, 'Циклы & for');
  assert.ok(html.includes('action="https://lens.google.com/v3/upload?stcs=12345"'));
  assert.ok(html.includes('name="encoded_image"'));
  assert.ok(html.includes('name="processed_image_dimensions"'));
  assert.ok(html.includes('value="900,538"'));
  assert.ok(html.includes('name="q"'));
  assert.ok(html.includes('value="Циклы &amp; for"'), 'запрос экранируется');
  assert.ok(html.includes('var b64="' + b64 + '"'));
  assert.ok(html.includes('new File('));
  assert.ok(html.includes('DataTransfer'));
  assert.ok(!html.includes('<foreignObject'));
});

test('Lens.upload отдаёт ссылку на результаты и забирает куки', async () => {
  const store = new Map();
  const lms = {
    context: {
      secrets: {
        get: async key => store.get(key) || null,
        store: async (key, value) => { store.set(key, value); },
        delete: async key => { store.delete(key); }
      }
    }
  };
  const lens = new Lens(lms);
  await lens.load();
  const origFetch = global.fetch;
  global.fetch = async () => new Response('', {
    status: 303,
    headers: {
      location: '/search?x=1',
      'set-cookie': 'NID=test; Domain=.google.com; Path=/'
    }
  });
  try {
    const r = await lens.upload(Buffer.from([1, 2, 3]), 10, 20);
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.url, 'https://lens.google.com/search?x=1');
    assert.ok(lens.status().count >= 1);
  } finally {
    global.fetch = origFetch;
  }
});

test('Lens.upload сообщает о проверке на робота', async () => {
  const lens = new Lens({ context: { secrets: { get: async () => null, store: async () => { }, delete: async () => { } } } });
  await lens.load();
  const origFetch = global.fetch;
  global.fetch = async () => new Response('unusual traffic', { status: 200 });
  try {
    await assert.rejects(() => lens.upload(Buffer.from([1]), 1, 1), /проверка на робота/);
  } finally {
    global.fetch = origFetch;
  }
});
