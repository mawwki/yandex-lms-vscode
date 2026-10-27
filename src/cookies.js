// Простой jar для куки Яндекс LMS: домены, пути, срок действия, сериализация в SecretStorage.
// Ключ — domain|path|name: у Яндекса одноимённые куки живут на разных хостах
// (passport / lms), и хранение по одному имени затирало сессию lms кукой паспорта.
function keyOf(c) {
  return String(c.domain || '').toLowerCase() + '|' + String(c.path || '/') + '|' + c.name;
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
      if (!this.map.delete(keyOf(c))) {
        // Удаление пришло без Domain/Path — чистим по имени в пределах домена.
        for (const [k, old] of this.map) {
          if (old.name !== c.name) continue;
          if (old.domain === c.domain || old.domain.endsWith('.' + c.domain) || c.domain.endsWith('.' + old.domain)) {
            this.map.delete(k);
          }
        }
      }
      return;
    }
    this.map.set(keyOf(c), c);
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
      this.map = new Map(arr.map(c => [keyOf(c), c]));
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

module.exports = { CookieJar };
