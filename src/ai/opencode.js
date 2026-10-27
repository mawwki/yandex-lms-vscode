// Интеграция с OpenCode CLI (https://opencode.ai): локальный ИИ-агент без API-ключа.
// Используются только документированные команды:
//   opencode run [message..]  --model provider/model [--agent name]
//   opencode models [provider]
//   opencode --version
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PROMPT_INLINE_LIMIT = 6000; // длинный промпт уходит через временный файл (--file)

// Автопоиск бинарника: PATH у VS Code часто отличается от терминала
// (например, opencode ставится через bun в ~/.bun/bin, которого там нет).
const KNOWN_LOCATIONS = [
  () => path.join(os.homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
  () => path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
  () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
  () => path.join(process.env.APPDATA || '', 'npm', process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
  () => path.join(os.homedir(), 'scoop', 'shims', 'opencode.exe'),
  () => path.join(os.homedir(), '.local', 'bin', 'opencode')
];

const resolveCache = new Map();

function resolveOpenCodeBin(bin) {
  const given = String(bin || 'opencode').trim();
  if (resolveCache.has(given)) return resolveCache.get(given);
  let resolved = given;
  if (!/[\\/]/.test(given)) {
    // ищем по PATH (с расширениями Windows), затем по известным папкам
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
    outer: for (const d of dirs) {
      for (const ext of exts) {
        try {
          const cand = path.join(d, given + ext);
          if (cand !== given && fs.existsSync(cand)) { resolved = cand; break outer; }
        } catch (e) { }
      }
    }
    if (resolved === given) {
      for (const cand of KNOWN_LOCATIONS) {
        try {
          const p = cand();
          if (p && fs.existsSync(p)) { resolved = p; break; }
        } catch (e) { }
      }
    }
  }
  resolveCache.set(given, resolved);
  return resolved;
}

function quoteWin(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function runCapture(bin, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    let timer = null;
    let cp = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, out });
    };
    const wire = (p) => {
      p.stdout.on('data', d => { out += d.toString(); });
      p.stderr.on('data', d => { out += d.toString(); });
      p.on('error', () => finish(-1));
      p.on('close', finish);
    };
    const arm = (p) => {
      timer = setTimeout(() => { try { p.kill(); } catch (e) { } finish(-1); }, timeoutMs || 30000);
    };
    try {
      // stdio: stdin закрыт намеренно — opencode run при открытом stdin-канале
      // ждёт его вечно и не выдаёт ответ (главная причина «opencode не решает»).
      cp = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: String(e.message || e) });
    }
    arm(cp);
    cp.on('error', e => {
      if (done) return;
      // На Windows глобальный npm-пакет — это .cmd-шим: без shell spawn его не находит.
      if (process.platform === 'win32' && /ENOENT/i.test(String(e.code || e.message || ''))) {
        if (timer) clearTimeout(timer);
        out = '';
        const cmd = [bin].concat(args).map(quoteWin).join(' ');
        try {
          cp = spawn(cmd, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e2) {
          return finish(-1);
        }
        arm(cp);
        wire(cp);
        return;
      }
      out += String((e && e.message) || e) + '\n';
      finish(-1);
    });
    cp.stdout.on('data', d => { out += d.toString(); });
    cp.stderr.on('data', d => { out += d.toString(); });
    cp.on('close', finish);
  });
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// opencode печатает шапку «> build · модель» и ANSI-коды — ответ должен быть чистым.
function cleanOpenCodeOutput(raw) {
  const lines = stripAnsi(raw).split(/\r?\n/);
  while (lines.length && (!lines[0].trim() || /^>\s*\S/.test(lines[0]))) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n').trim();
}

// ВАЖНО: opencode run возвращает код 0 даже при ошибке модели — ошибку ищем в тексте.
function openCodeErrorIn(raw) {
  const clean = stripAnsi(raw);
  const m = /^Error:\s*(.+)$/m.exec(clean);
  return m ? m[1].trim() : null;
}

function hintForOpenCodeError(msg) {
  if (/trains on request data|Privacy/i.test(msg)) {
    return ' — модель блокирована политикой приватности opencode. Возьмите другую модель: opencode/big-pickle (облачная) или ollama/qwen3-mini-uncensored (локальная, нужен запущенный Ollama)';
  }
  if (/connect|refused|ECONNREFUSED/i.test(msg)) {
    return ' — сервер модели недоступен. Для локальных моделей запустите Ollama: «ollama serve»';
  }
  if (/auth|unauthorized|401/i.test(msg)) {
    return ' — требуется вход в opencode: выполните «opencode auth login»';
  }
  return '';
}

// Запуск одного запроса через opencode. Промпт и системную роль склеиваем:
// у `opencode run` нет отдельного флага для system.
async function runOpenCode(entry, prompt, system, timeoutMs) {
  const bin = resolveOpenCodeBin(entry.bin || 'opencode');
  const limit = Math.max(20000, Number(timeoutMs) || 90000);
  const full = (system ? system + '\n\n' : '') + prompt;
  const args = ['run'];
  if (entry.model) args.push('--model', entry.model);
  if (entry.agent) args.push('--agent', entry.agent);

  // Длинные промпты (условие + код + правила) передаём файлом: аргументы
  // командной строки в Windows ограничены ~8-32К, а кавычки ломают разбор.
  let fileToAttach = null;
  if (full.length > PROMPT_INLINE_LIMIT) {
    try {
      const dir = path.join(os.tmpdir(), 'yandex-lms-opencode');
      fs.mkdirSync(dir, { recursive: true });
      fileToAttach = path.join(dir, 'prompt-' + Date.now() + '.txt');
      fs.writeFileSync(fileToAttach, full, 'utf8');
      args.push('--file', fileToAttach);
      args.push('Выполни задание из прикреплённого файла. Ответь по правилам, указанным в нём.');
    } catch (e) {
      fileToAttach = null;
    }
  }
  if (!fileToAttach) {
    args.push(full);
  }

  const t0 = Date.now();
  const res = await runCapture(bin, args, limit);
  if (fileToAttach) { try { fs.rmSync(fileToAttach, { force: true }); } catch (e) { } }
  const raw = String(res.out || '');
  // opencode возвращает код 0 даже при ошибке модели — проверяем текст вывода
  const errMsg = res.code !== 0 ? null : openCodeErrorIn(raw);
  if (errMsg) {
    const err = new Error('opencode: ' + errMsg.slice(0, 250) + hintForOpenCodeError(errMsg));
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  if (res.code !== 0) {
    const tail = raw.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    if (/ENOENT|not recognized|не является внутренней|не найден/i.test(tail + raw)) {
      const err = new Error('opencode не найден. Установите: https://opencode.ai/docs/ (или укажите путь к бинарнику в настройках ключа).');
      err.kind = 'auth';
      err.retryable = false;
      throw err;
    }
    const err = new Error('opencode завершился с ошибкой: ' + (tail || ('код ' + res.code)).slice(0, 250));
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  const text = cleanOpenCodeOutput(raw);
  if (!text) {
    const err = new Error('opencode вернул пустой ответ');
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  return { text, ms: Date.now() - t0 };
}

// Быстрый проб одной модели opencode — для автоподбора рабочей модели.
async function openCodeProbeModel(entry, model) {
  await runOpenCode(Object.assign({}, entry, { model }), 'Ответь ровно одним словом: ок', 'Отвечай одним словом.', 90000);
  return true;
}

// Список моделей: `opencode models` печатает таблицу, вытаскиваем пары provider/model.
async function openCodeModels(entry) {
  const bin = resolveOpenCodeBin((entry && entry.bin) || 'opencode');
  const res = await runCapture(bin, ['models'], 60000);
  if (res.code !== 0) return [];
  const seen = new Set();
  for (const m of String(res.out || '').matchAll(/([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)/g)) {
    seen.add(m[1]);
  }
  return [...seen];
}

async function openCodeVersion(bin) {
  const res = await runCapture(resolveOpenCodeBin(bin || 'opencode'), ['--version'], 15000);
  if (res.code !== 0) return null;
  const m = String(res.out || '').match(/(\d+\.\d+[\w.-]*)/);
  return m ? m[1] : String(res.out || '').trim().slice(0, 40) || null;
}

module.exports = { runOpenCode, openCodeModels, openCodeVersion, resolveOpenCodeBin, openCodeProbeModel, runCapture, stripAnsi };
