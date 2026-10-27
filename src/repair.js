// Починка webview при баге VS Code #342842 (Could not register service worker:
// InvalidStateError). Кэш service worker можно чистить ТОЛЬКО при закрытом
// VS Code. Безопасная схема без taskkill: пишем cmd-скрипт, который
// дожидается, пока пользователь сам закроет VS Code (до 10 минут), чистит
// кэш и запускает VS Code обратно. Если VS Code не закрыли — скрипт
// молча выходит, ничего не удаляя.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DIAG_DIR_NAME = 'yandex-lms-diag';

function scheduleWebviewRepair() {
  const dir = path.join(os.tmpdir(), DIAG_DIR_NAME);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  const file = path.join(dir, 'fix-webview.cmd');
  const exe = process.execPath;
  const img = path.basename(exe); // обычно Code.exe; учитывает Insiders/VSCodium
  const body = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    'set /a waited=0',
    ':wait',
    'timeout /t 2 /nobreak >nul',
    'tasklist /FI "IMAGENAME eq ' + img + '" 2>nul | find /I "' + img + '" >nul',
    'if errorlevel 1 goto clean',
    'set /a waited+=2',
    'if !waited! LSS 600 goto wait',
    'exit /b',
    ':clean',
    'rmdir /S /Q "%APPDATA%\\Code\\Service Worker" 2>nul',
    'rmdir /S /Q "%APPDATA%\\Code\\Code Cache" 2>nul',
    'rmdir /S /Q "%APPDATA%\\Code\\GPUCache" 2>nul',
    'start "" "' + exe + '"',
    'endlocal',
    ''
  ].join('\r\n');
  fs.writeFileSync(file, body, 'ascii');
  spawn('cmd.exe', ['/c', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return file;
}

module.exports = { scheduleWebviewRepair };
