// Отправка решения: CSRF-токен и заголовки POST.
// Регрессия, которую ловим: в jar ключ куки — «domain|path|name», поэтому
// поиск по имени возвращал пусто, POST уходил без X-CSRF-Token и сервер
// отвечал 403 на все ручки.
const test = require('node:test');
const assert = require('node:assert');
const { CookieJar } = require('../src/cookies');
const { LmsClient } = require('../src/client');

function makeRes(status, body, setCookies) {
  const map = new Map();
  for (const c of setCookies || []) map.set('set-cookie', c);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: k => map.get(String(k).toLowerCase()) || null,
      getSetCookie: () => setCookies || []
    },
    text: async () => body || ''
  };
}

// Подменяет global.fetch и складывает все запросы.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const o = opts || {};
    calls.push({ url: u, method: o.method || 'GET', headers: o.headers || {}, body: o.body });
    return handler(u, o, calls.length - 1);
  };
  return calls;
}

test('cookieValue находит куку по имени, а не по ключу map', () => {
  const jar = new CookieJar();
  jar.storeOne('csrftoken=TOK; path=/', 'lms.yandex.ru');
  const client = new LmsClient(jar, 'https://lms.yandex.ru');
  assert.strictEqual(client.cookieValue('csrftoken'), 'TOK');
  assert.strictEqual(client.cookieValue('нет-такой'), '');
});

test('POST отправки уходит с X-CSRF-Token из куки', async () => {
  const jar = new CookieJar();
  jar.storeOne('csrftoken=TOK; path=/', 'lms.yandex.ru');
  jar.storeOne('Session_id=s; path=/', 'lms.yandex.ru');
  const client = new LmsClient(jar, 'https://lms.yandex.ru');
  const calls = stubFetch(() => makeRes(204, ''));

  const out = await client.submitSolution({ solutionId: 7, compilerId: 'python-lyceum' }, 'print(1)');

  assert.ok(out.result, 'должна сработать первая ручка');
  assert.strictEqual(out.attempts[0].status, 204);
  assert.match(calls[0].url, /\/api\/student\/solutions\/7\/comments\/files$/);
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].headers['X-CSRF-Token'], 'TOK');
  assert.match(calls[0].headers['Cookie'], /Session_id=s/);
  // multipart: Content-Type ставит сам fetch (с boundary), руками — нельзя
  assert.strictEqual(calls[0].headers['Content-Type'], undefined);
  assert.ok(calls[0].body instanceof FormData);
  assert.strictEqual(calls[0].body.get('compiler_id'), 'python-lyceum');
});

test('без куки csrftoken клиент сначала забирает страницу LMS', async () => {
  const jar = new CookieJar();
  jar.storeOne('Session_id=s; path=/', 'lms.yandex.ru');
  const client = new LmsClient(jar, 'https://lms.yandex.ru');
  const calls = stubFetch((url) => {
    if (url === 'https://lms.yandex.ru/') return makeRes(200, '<html></html>', ['csrftoken=NEW; path=/; domain=.yandex.ru']);
    return makeRes(204, '');
  });

  const out = await client.submitSolution({ solutionId: 9, compilerId: 'python-lyceum' }, 'print(1)');

  assert.ok(out.result);
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].url, 'https://lms.yandex.ru/');
  const post = calls.find(c => c.method === 'POST');
  assert.strictEqual(post.headers['X-CSRF-Token'], 'NEW');
});

test('403 на POST: токен обновляется и запрос повторяется один раз', async () => {
  const jar = new CookieJar();
  jar.storeOne('csrftoken=OLD; path=/', 'lms.yandex.ru');
  const client = new LmsClient(jar, 'https://lms.yandex.ru');
  let posts = 0;
  const calls = stubFetch((url, opts) => {
    if (url === 'https://lms.yandex.ru/') return makeRes(200, '<html></html>', ['csrftoken=FRESH; path=/']);
    posts++;
    return posts === 1 ? makeRes(403, '{"code":"forbidden"}') : makeRes(204, '');
  });

  const out = await client.submitSolution({ solutionId: 11, compilerId: 'python-lyceum' }, 'print(1)');

  assert.ok(out.result, 'повтор после обновления токена должен пройти');
  assert.strictEqual(out.attempts[0].status, 403);
  const last = calls[calls.length - 1];
  assert.strictEqual(last.headers['X-CSRF-Token'], 'FRESH');
  assert.strictEqual(posts, 2, 'ровно один повтор, без цикла');
});

test('служебный компилятор _internal_lms_txt в поле compiler_id не уходит', async () => {
  const jar = new CookieJar();
  jar.storeOne('csrftoken=TOK; path=/', 'lms.yandex.ru');
  const client = new LmsClient(jar, 'https://lms.yandex.ru');
  const calls = stubFetch(() => makeRes(204, ''));

  await client.submitSolution({ solutionId: 13, compilerId: '_internal_lms_txt' }, 'ответ');
  assert.strictEqual(calls[0].body.get('compiler_id'), null);
});
