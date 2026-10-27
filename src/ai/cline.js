// Интеграция с Cline CLI (https://cline.ai): локальный ИИ-агент с собственным
// провайдером (аккаунт Cline, есть бесплатные модели с суффиксом :free).
// Используются только документированные команды:
//   cline [prompt] --json [-P cline] [-m model] [-t seconds] [-c dir]
//   cline --version
// --json печатает NDJSON-события, финальное {type:'run_result'} несёт текст,
// finishReason ('completed' | 'error' | 'aborted') и метаданные модели.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { runCapture, stripAnsi } = require('./opencode');

const PROMPT_INLINE_LIMIT = 6000; // длинный промпт уходит через файл в scratch-каталоге

// Автопоиск бинарника: cline ставится через bun в ~/.bun/bin, которого нет в PATH
// у VS Code (тот же приём, что для opencode).
const KNOWN_LOCATIONS = [
  () => path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'cline.exe' : 'cline'),
  () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cline', process.platform === 'win32' ? 'cline.exe' : 'cline'),
  () => path.join(process.env.APPDATA || '', 'npm', process.platform === 'win32' ? 'cline.cmd' : 'cline'),
  () => path.join(os.homedir(), 'scoop', 'shims', 'cline.exe'),
  () => path.join(os.homedir(), '.local', 'bin', 'cline')
];

const resolveCache = new Map();

function resolveClineBin(bin) {
  const given = String(bin || 'cline').trim();
  if (resolveCache.has(given)) return resolveCache.get(given);
  let resolved = given;
  if (!/[\\/]/.test(given)) {
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

function hintForClineError(msg) {
  if (/free promotion|no longer available|Select another model/i.test(msg)) {
    return ' — бесплатная модель Cline снята с раздачи. Смените модель (см. «AI: ключи» → Cline → «Сменить модель»).';
  }
  if (/rate-limited upstream|429/i.test(msg)) {
    return ' — бесплатная модель перегружена (общий пул upstream). Повторите попытку или смените модель.';
  }
  if (/usage limit|subscribe/i.test(msg)) {
    return ' — бесплатный лимит Cline исчерпан. Нужна подписка Cline или другая модель.';
  }
  if (/auth|unauthorized|401|login/i.test(msg)) {
    return ' — требуется вход в Cline: выполните «cline auth» в терминале.';
  }
  return '';
}

// Финальное событие run_result: finishReason 'completed' | 'error' | 'aborted'.
function clineResultIn(raw) {
  let rr = null;
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const o = JSON.parse(s);
      if (o && o.type === 'run_result') rr = o;
    } catch (e) { }
  }
  return rr;
}

// Запуск одного запроса через cline. Системную роль склеиваем с промптом:
// флаг -s подменяет системный промпт агента целиком и ломает его инструменты.
async function runCline(entry, prompt, system, timeoutMs) {
  const bin = resolveClineBin(entry.bin || 'cline');
  const limit = Math.max(20000, Number(timeoutMs) || 90000);
  const full = (system ? system + '\n\n' : '') + prompt;
  const scratch = path.join(os.tmpdir(), 'yandex-lms-cline');
  try { fs.mkdirSync(scratch, { recursive: true }); } catch (e) { }

  const args = ['--json', '-c', scratch, '-P', 'cline', '-t', String(Math.ceil(limit / 1000))];
  if (entry.model) args.push('-m', entry.model);

  // Длинные промпты (условие + код + правила) уходим файлом: cline читает его
  // инструментом из scratch-каталога, где ему и разрешено работать.
  let fileToAttach = null;
  if (full.length > PROMPT_INLINE_LIMIT) {
    try {
      fileToAttach = path.join(scratch, 'prompt-' + Date.now() + '.txt');
      fs.writeFileSync(fileToAttach, full, 'utf8');
      args.push('Прочитай файл ' + fileToAttach + ' и выполни задание из него. Ответь по правилам, указанным в файле. Файлы не создавай и не изменяй.');
    } catch (e) {
      fileToAttach = null;
    }
  }
  if (!fileToAttach) {
    args.push(full + '\n\nФайлы не создавай и не изменяй, ответь текстом.');
  }

  const t0 = Date.now();
  const res = await runCapture(bin, args, limit + 15000);
  if (fileToAttach) { try { fs.rmSync(fileToAttach, { force: true }); } catch (e) { } }
  const raw = String(res.out || '');
  const rr = clineResultIn(raw);

  if (!rr) {
    // Нет run_result — CLI упал до агента или напечатал ошибку без JSON.
    const clean = stripAnsi(raw);
    const m = /^Error:\s*(.+)$/m.exec(clean);
    const tail = clean.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    if (/ENOENT|not recognized|не является внутренней|не найден/i.test(clean)) {
      const err = new Error('cline не найден. Установите: https://cline.ai (или укажите путь к бинарнику в настройках ключа).');
      err.kind = 'auth';
      err.retryable = false;
      throw err;
    }
    const err = new Error('cline: ' + ((m && m[1]) || tail || 'нет ответа (код ' + res.code + ')').slice(0, 250) + hintForClineError(clean));
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  if (rr.finishReason === 'aborted') {
    const err = new Error('cline не успел за ' + Math.ceil(limit / 1000) + ' с (агент прерван по таймауту)');
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  const text = String(rr.text || '').trim();
  if (rr.finishReason === 'error' || /Failed to create stream|inference request failed/i.test(text)) {
    const err = new Error('cline: ' + (text || 'ошибка провайдера').slice(0, 250) + hintForClineError(text));
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  if (!text) {
    const err = new Error('cline вернул пустой ответ');
    err.retryable = true;
    err.kind = 'error';
    throw err;
  }
  return { text, ms: Date.now() - t0 };
}

// Быстрый проб одной модели cline — для автоподбора рабочей модели.
async function clineProbeModel(entry, model) {
  await runCline(Object.assign({}, entry, { model }), 'Ответь ровно одним словом: ок', 'Отвечай одним словом.', 120000);
  return true;
}

// Список моделей: у cline нет команды листинга, бесплатный каталог известен
// заранее (проверено запросом к провайдеру cline 26.10.2026).
const CLINE_FREE_MODELS = [
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'dots-studio/dots-3-note-preview:free',
  'xingchen-agi/xing4.0-29b-a4b:free',
  'recursive/flint-v1.0:free',
  'openrouter/free'
];

async function clineModels(entry) {
  return CLINE_FREE_MODELS.slice();
}

async function clineVersion(bin) {
  const res = await runCapture(resolveClineBin(bin || 'cline'), ['--version'], 20000);
  if (res.code !== 0) return null;
  const m = String(res.out || '').match(/(\d+\.\d+[\w.-]*)/);
  return m ? m[1] : String(res.out || '').trim().slice(0, 40) || null;
}

module.exports = { runCline, clineModels, clineVersion, resolveClineBin, clineProbeModel, CLINE_FREE_MODELS };
