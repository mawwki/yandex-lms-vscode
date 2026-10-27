// Диагностика: всё, что пишет файлы в %TEMP%\yandex-lms-diag.
// Пишется ТОЛЬКО при включённой настройке yandexLms.debug — личные данные
// (решения, промпты, ответы API) не должны копиться на диске молча.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { debugEnabled } = require('./cfg');

const DIAG_DIR_NAME = 'yandex-lms-diag';
const DIAG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // чистим всё старше 7 дней

function diagDir() {
  const d = path.join(os.tmpdir(), DIAG_DIR_NAME);
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { }
  return d;
}

function appendJsonl(name, obj) {
  if (!debugEnabled()) return;
  try {
    const file = path.join(diagDir(), name);
    if (name === 'ai-log.jsonl') {
      try {
        const st = fs.statSync(file);
        if (st.size > 2 * 1024 * 1024) {
          const old = path.join(diagDir(), 'ai-log.old.jsonl');
          try { fs.rmSync(old, { force: true }); } catch (e) { }
          fs.renameSync(file, old);
        }
      } catch (e) { }
    }
    fs.appendFileSync(file, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, obj)) + '\n', 'utf8');
  } catch (e) { }
}

function aiLog(obj) { appendJsonl('ai-log.jsonl', obj); }
function webviewLog(event, data) { if (debugEnabled()) appendJsonl('webview-log.jsonl', Object.assign({ event }, data || {})); }
function submitLog(obj) { appendJsonl('submit-log.jsonl', obj); }

// Разовая чистка старых диагностических файлов (запускается при активации).
function pruneOldFiles() {
  try {
    const dir = diagDir();
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > DIAG_TTL_MS) fs.rmSync(full, { force: true });
      } catch (e) { }
    }
  } catch (e) { }
}

module.exports = { diagDir, aiLog, webviewLog, submitLog, pruneOldFiles, DIAG_DIR_NAME };
