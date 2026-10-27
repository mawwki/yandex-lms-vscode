// Статические webview-страницы: вход по QR и приветствие.
const vscode = require('vscode');
const crypto = require('crypto');
const { ic } = require('./panel');

function nonce() {
  return crypto.randomBytes(16).toString('hex');
}

async function qrWebview(context) {
  const panel = vscode.window.createWebviewPanel(
    'yandexLmsQr',
    'Яндекс LMS — вход по QR',
    vscode.ViewColumn.One,
    { enableScripts: true, disableServiceWorker: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  const n = nonce();
  const libUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'qrcode.min.js'));
  panel.webview.html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}' ${panel.webview.cspSource};">
<style>
 body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 28px; line-height: 1.6; }
 h1 { font-size: 1.3em; }
 .wrap { display: flex; gap: 28px; align-items: flex-start; flex-wrap: wrap; }
 .qr { background: #fff; padding: 16px; border-radius: 10px; line-height: 0; width: 292px; height: 292px; display: flex; align-items: center; justify-content: center; }
 .qr svg { width: 260px; height: 260px; }
 .steps { max-width: 420px; }
 .status { margin-top: 18px; font-size: 1.05em; }
 .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
 .err { color: var(--vscode-errorForeground, #f85149); }
 .wait { opacity: 0.85; }
 .link { word-break: break-all; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; opacity: 0.7; margin-top: 8px; }
 .spinner { display:inline-block; width:14px; height:14px; margin-right:8px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:sp 0.8s linear infinite; vertical-align:-2px;}
 @keyframes sp { to { transform: rotate(360deg); } }
 button { margin-top: 16px; font-size: 1em; padding: 7px 16px; border-radius: 4px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
</style>
</head>
<body>
<h1>Вход по QR-коду</h1>
<div class="wrap">
  <div class="qr" id="qrbox"></div>
  <div class="steps">
    <ol>
      <li>Откройте приложение <b>Яндекс</b> (или Яндекс Браузер) на телефоне.</li>
      <li>Нажмите значок <b>сканера / QR</b> рядом со строкой поиска.</li>
      <li>Наведите на код слева и подтвердите вход.</li>
    </ol>
    <div class="status wait" id="status"><span class="spinner"></span>Готовлю QR-код…</div>
    <div class="link" id="link"></div>
    <button id="cancel">Отмена</button>
  </div>
</div>
<script nonce="${n}" src="${libUri}"></script>
<script nonce="${n}">
  const statusEl = document.getElementById('status');
  const qrbox = document.getElementById('qrbox');
  const linkEl = document.getElementById('link');
  const vscode = acquireVsCodeApi();
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  function renderQr(link) {
    linkEl.textContent = link;
    if (typeof qrcode !== 'function') {
      statusEl.className = 'status err';
      statusEl.textContent = 'Не загрузилась библиотека QR. Откройте ссылку выше на телефоне вручную.';
      return;
    }
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      qrbox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 8 });
      statusEl.className = 'status wait';
      statusEl.innerHTML = '<span class="spinner"></span>Ожидаю подтверждения на телефоне…';
    } catch (e) {
      statusEl.className = 'status err';
      statusEl.textContent = 'Не удалось построить QR-код: ' + e;
    }
  }
  window.addEventListener('message', ev => {
    const m = ev.data || {};
    if (m.type === 'qr' && m.link) renderQr(m.link);
    if (m.type === 'status') {
      if (m.ok) {
        statusEl.className = 'status ok';
        statusEl.textContent = 'Вход выполнен. Окно можно закрыть.';
        qrbox.style.opacity = '0.25';
      } else if (m.error) {
        statusEl.className = 'status err';
        statusEl.textContent = m.error;
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  return panel;
}

async function welcomeWebview(context) {
  const panel = vscode.window.createWebviewPanel(
    'yandexLmsWelcome',
    'Яндекс LMS — как пользоваться',
    vscode.ViewColumn.One,
    { enableScripts: true, disableServiceWorker: true }
  );
  const n = nonce();
  panel.webview.html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
 * { box-sizing: border-box; }
 body { font-family: var(--vscode-font-family); color: var(--vscode-foreground, #cccccc); background: var(--vscode-editor-background, transparent); margin: 0; line-height: 1.6; }
 .wrap { max-width: 760px; margin: 0 auto; padding: 34px 26px 50px; }
 .hero { text-align: center; padding: 26px 0 30px; }
 .hero h1 { font-size: 1.7em; margin: 0 0 8px; letter-spacing: 0.01em; }
 .hero .accent { background: linear-gradient(90deg, #3794ff, #b180d7); -webkit-background-clip: text; background-clip: text; color: transparent; }
 .hero p { opacity: 0.75; margin: 0 auto; max-width: 520px; font-size: 0.98em; }
 .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 22px 0 8px; }
 .card { display: block; padding: 14px 16px; border-radius: 9px; border: 1px solid var(--vscode-panel-border, #2b2b2b); background: var(--vscode-sideBar-background, rgba(127,127,127,0.06)); cursor: pointer; text-align: left; font-family: inherit; color: inherit; transition: filter .12s ease, border-color .12s ease; }
 .card:hover { filter: brightness(1.2); border-color: var(--vscode-focusBorder, #007fd4); }
 .card svg { display: block; margin-bottom: 8px; opacity: 0.9; }
 .card b { display: block; font-size: 0.98em; margin-bottom: 3px; }
 .card span { opacity: 0.7; font-size: 0.85em; }
 h2 { font-size: 1.05em; margin: 30px 0 10px; border-bottom: 1px solid var(--vscode-panel-border, #2b2b2b); padding-bottom: 6px; }
 ol.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; }
 ol.steps li { counter-increment: step; position: relative; padding: 6px 0 6px 38px; margin: 0; }
 ol.steps li::before { content: counter(step); position: absolute; left: 0; top: 7px; width: 24px; height: 24px; border-radius: 50%;
   background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 18%, transparent); color: var(--vscode-charts-blue, #3794ff);
   font-size: 0.8em; font-weight: 700; display: flex; align-items: center; justify-content: center; }
 code, pre { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,0.15); padding: 2px 5px; border-radius: 3px; }
 pre { padding: 10px; overflow: auto; }
 kbd { border: 1px solid var(--vscode-panel-border, #2b2b2b); border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; font-size: 0.9em; background: rgba(127,127,127,0.12); }
 .hint { margin-top: 26px; padding: 10px 14px; border-radius: 8px; border-left: 3px solid var(--vscode-charts-green, #3fb950); background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); font-size: 0.9em; }
 .hint svg { vertical-align: -2px; margin-right: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>Яндекс LMS <span class="accent">внутри VS Code</span></h1>
    <p>Условие слева, код справа, отправка решения одной клавишей. ИИ-помощник — через API-ключи или локальный OpenCode CLI.</p>
  </div>

  <div class="cards">
    <button class="card" id="qr">${ic('phone', 20)}<b>Войти по QR-коду</b><span>приложение Яндекса, пароль и 2FA не нужны</span></button>
    <button class="card" id="login">${ic('key', 20)}<b>Логин и пароль</b><span>для аккаунтов без 2FA</span></button>
    <button class="card" id="cookie">${ic('cookie', 20)}<b>Войти по cookie</b><span>если включена 2FA — из DevTools браузера</span></button>
  </div>

  <h2>Работа с заданиями</h2>
  <ol class="steps">
    <li>Слева откройте панель <b>Яндекс LMS</b> — курсы → уроки → задачи со статусами.</li>
    <li>Клик по задаче открывает условие (панель) и файл решения <code>.py</code> рядом.</li>
    <li>Пишите код и жмите <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> — вердикт придёт в шапку панели.</li>
    <li>Кнопка <b>«Следующая задача»</b> в панели открывает следующую задачу урока без дерева.</li>
  </ol>

  <h2>ИИ-помощник</h2>
  <ol class="steps">
    <li><b>LMS: AI — ключи и провайдеры</b> (палитра команд или статус-бар задачи): API-ключ (OpenRouter, OpenAI, Mistral, Ollama) или локальный агент — <b>OpenCode CLI</b> / <b>Cline CLI</b>.</li>
    <li><b>Чат с ИИ в панели задачи</b>: спросите что угодно об условии или своём коде — контекст подставится сам. Чипы под чатом: решение, проверка, подсказки, исправление по ошибке проверки, PEP 8, локальная проверка на примерах из условия.</li>
    <li>Несколько ключей ротируются автоматически при лимитах; правила курса настраиваются в <code>yandexLms.ai.courseRules</code>.</li>
  </ol>

  <div class="hint">${ic('hints', 15)} Если панель условия не открылась (баг VS Code 1.142), команда <b>LMS: Условие — текстом</b> покажет условие через встроенный markdown-preview, а <b>LMS: Починить панель условия</b> перезагрузит webview.</div>
</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.getElementById('qr').addEventListener('click', () => vscode.postMessage({ type: 'qr' }));
  document.getElementById('login').addEventListener('click', () => vscode.postMessage({ type: 'login' }));
  document.getElementById('cookie').addEventListener('click', () => vscode.postMessage({ type: 'cookie' }));
</script>
</body>
</html>`;
  panel.webview.onDidReceiveMessage(async msg => {
    if (msg.type === 'qr') await vscode.commands.executeCommand('yandexLms.loginQr');
    if (msg.type === 'login') await vscode.commands.executeCommand('yandexLms.login');
    if (msg.type === 'cookie') await vscode.commands.executeCommand('yandexLms.loginByCookie');
  });
}

module.exports = { qrWebview, welcomeWebview };
