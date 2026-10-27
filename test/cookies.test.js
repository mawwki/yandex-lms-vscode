const test = require('node:test');
const assert = require('node:assert');
const { CookieJar } = require('../src/cookies');

test('CookieJar хранит и отдаёт куки по домену/пути', () => {
  const jar = new CookieJar();
  jar.storeOne('Session_id=abc; path=/; domain=.yandex.ru', 'lms.yandex.ru');
  jar.storeOne('csrftoken=tok; path=/', 'lms.yandex.ru');
  assert.ok(jar.headerFor('https://lms.yandex.ru/api/x').includes('Session_id=abc'));
  assert.ok(jar.headerFor('https://lms.yandex.ru/api/x').includes('csrftoken=tok'));
  assert.strictEqual(jar.headerFor('https://example.com/'), '');
  // кука с domain=.yandex.ru действует на все поддомены, а выданная только
  // для lms.yandex.ru — на passport не приходит
  jar.storeOne('local=1; path=/', 'lms.yandex.ru');
  const passport = jar.headerFor('https://passport.yandex.ru/');
  assert.ok(passport.includes('Session_id=abc'));
  assert.ok(!passport.includes('local='));
  assert.ok(jar.headerFor('https://lms.yandex.ru/').includes('local=1'));
});

test('CookieJar удаляет просроченные куки', () => {
  const jar = new CookieJar();
  jar.storeOne('a=1; Max-Age=3600', 'lms.yandex.ru');
  jar.storeOne('b=2; Max-Age=0', 'lms.yandex.ru');
  const h = jar.headerFor('https://lms.yandex.ru/');
  assert.ok(h.includes('a=1'));
  assert.ok(!h.includes('b='));
});

test('CookieJar сериализация и восстановление', () => {
  const jar = new CookieJar();
  jar.storeOne('x=1; path=/', 'lms.yandex.ru');
  const copy = new CookieJar();
  copy.restore(jar.serialize());
  assert.strictEqual(copy.headerFor('https://lms.yandex.ru/'), 'x=1');
  copy.restore('{not json');
  assert.ok(copy.isEmpty());
});

test('CookieJar не смешивает одноимённые куки разных доменов', () => {
  const jar = new CookieJar();
  jar.storeOne('Session_id=lms; path=/', 'lms.yandex.ru');
  jar.storeOne('Session_id=passport; path=/; domain=.passport.yandex.ru', 'passport.yandex.ru');
  assert.ok(jar.headerFor('https://lms.yandex.ru/api/x').includes('Session_id=lms'));
  assert.ok(jar.headerFor('https://passport.yandex.ru/').includes('Session_id=passport'));
  // удаление куки паспорта не должно убивать сессию lms
  jar.storeOne('Session_id=; Max-Age=0; domain=.passport.yandex.ru', 'passport.yandex.ru');
  assert.ok(jar.headerFor('https://lms.yandex.ru/api/x').includes('Session_id=lms'));
});

test('CookieJar: просрочка удаляет только свою куку', () => {
  const jar = new CookieJar();
  jar.storeOne('sid=a; path=/', 'lms.yandex.ru');
  jar.storeOne('sid=b; path=/', 'other.yandex.ru');
  jar.storeOne('sid=; path=/; Max-Age=0', 'lms.yandex.ru');
  assert.ok(!jar.headerFor('https://lms.yandex.ru/').includes('sid=a'));
  assert.ok(jar.headerFor('https://other.yandex.ru/').includes('sid=b'));
});
