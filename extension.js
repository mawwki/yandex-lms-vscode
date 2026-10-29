// Точка входа: сборка сервиса и регистрация команд.
const vscode = require('vscode');
const { Lms, SECRET_LOGIN } = require('./src/lms');
const { pick } = require('./src/util');
const { qrWebview, welcomeWebview } = require('./src/webviews');
const { AiAutocomplete } = require('./src/autocomplete');
const { initPool, aiPersistNow } = require('./src/ai/pool');
const { pruneOldFiles } = require('./src/diag');
const { scheduleWebviewRepair } = require('./src/repair');

async function activate(context) {
  const lms = new Lms(context);
  await lms.init();

  // Панель пробуется при каждом открытии задачи (пересоздания лечат #342842),
  // поэтому старый флаг «сломано» больше не блокирует — сбрасываем.
  lms.setWebviewBroken(false);

  // Пул ИИ-ключей (включая OpenCode CLI) — в SecretStorage; легаси-ключ из
  // settings.json переносится туда же автоматически.
  await initPool(context);

  // Куки Google для Объектива (Ctrl+Alt+G) — из SecretStorage.
  try { await lms.lensInit(); } catch (e) { }

  // Диагностические файлы старше 7 дней удаляем — не копим личные данные.
  pruneOldFiles();
  // Мусорные per-task папки условий от старых версий — тоже.
  try { lms.pruneViewDirs(); } catch (e) { }

  context.subscriptions.push(lms);

  try {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('lms', lms.docProvider));
  } catch (e) { }

  // ИИ-автодополнение: следующая строка решения по условию задачи.
  const ac = new AiAutocomplete(lms);
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ language: 'python', pattern: '**/*.py' }, ac));
  context.subscriptions.push({ dispose: () => ac.cancel() });

  const lmsView = vscode.window.createTreeView('yandexLms.tree', { treeDataProvider: lms.tree, showCollapseAll: true });
  context.subscriptions.push(lmsView);

  // Клик по иконке LMS: сохраняем изменения и закрываем все вкладки редактора —
  // рабочая область остаётся чистой под одну задачу (поведение 1.3.x).
  context.subscriptions.push(lmsView.onDidChangeVisibility(e => {
    if (!e.visible) return;
    lms.closeAllTabs().catch(() => { });
  }));

  const afterLogin = (profile, fallbackName) => {
    const name = pick(profile.profile, 'firstName', 'first_name', 'fullName', 'full_name', 'login');
    lms.statusBar.text = '$(check) LMS: ' + (name || fallbackName || 'вход выполнен');
    lms.tree.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('yandexLms.login', async () => {
      const login = await vscode.window.showInputBox({ prompt: 'Логин Яндекса (почта)', ignoreFocusOut: true });
      if (!login) return;
      const password = await vscode.window.showInputBox({ prompt: 'Пароль Яндекса', password: true, ignoreFocusOut: true });
      if (!password) return;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: авторизация…' }, async () => {
          lms.jar.clear();
          const profile = await lms.client.loginWithPassword(login.trim(), password);
          lms.profileJson = profile;
          await lms.persist();
          await context.secrets.store(SECRET_LOGIN, login.trim());
          afterLogin(profile, login.trim());
        });
        vscode.window.showInformationMessage('LMS: вход выполнен и сохранён.');
      } catch (e) {
        lms.jar.clear();
        await lms.persist();
        vscode.window.showErrorMessage('LMS: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.loginMenu', async () => {
      const items = [
        { label: '$(device-camera) Войти по QR-коду (телефон)', description: 'Откроется QR — отсканируйте в приложении Яндекс', cmd: 'yandexLms.loginQr' },
        { label: '$(key) Войти (логин и пароль Яндекса)', description: 'Без 2FA', cmd: 'yandexLms.login' },
        { label: '$(clippy) Войти по cookie', description: 'Скопируйте Cookie из браузера', cmd: 'yandexLms.loginByCookie' },
        { label: '$(sign-out) Выйти', description: 'Забыть сессию', cmd: 'yandexLms.logout' }
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Яндекс LMS — вход' });
      if (!picked) return;
      await vscode.commands.executeCommand(picked.cmd);
    }),

    vscode.commands.registerCommand('yandexLms.loginQr', async () => {
      const abort = { cancelled: false };
      let panel;
      try {
        panel = await qrWebview(context);
      } catch (e) {
        vscode.window.showErrorMessage('LMS: не удалось открыть окно QR — ' + (e.message || e));
        return;
      }
      let link = null;
      let webviewReady = false;
      const pushLink = () => {
        if (!link || !webviewReady) return;
        try { panel.webview.postMessage({ type: 'qr', link }); } catch (e) { }
      };
      panel.onDidDispose(() => { abort.cancelled = true; });
      panel.webview.onDidReceiveMessage(async msg => {
        const m = msg || {};
        if (m.type === 'ready') {
          webviewReady = true;
          pushLink();
        }
        if (m.type === 'cancel') {
          abort.cancelled = true;
          try { panel.dispose(); } catch (e) { }
        }
      });
      let settled = false;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: ожидаю подтверждение QR…' }, async () => {
          lms.jar.clear();
          const profile = await lms.client.loginQr(async qrLink => {
            link = qrLink;
            pushLink();
          }, abort);
          settled = true;
          lms.profileJson = profile;
          await lms.persist();
          afterLogin(profile, null);
        });
        try { panel.webview.postMessage({ type: 'status', ok: true }); } catch (e) { }
        vscode.window.showInformationMessage('LMS: вход по QR выполнен и сохранён.');
      } catch (e) {
        if (!settled) {
          lms.jar.clear();
          await lms.persist();
        }
        if (abort.cancelled) return;
        try { panel.webview.postMessage({ type: 'status', error: 'Ошибка: ' + (e.message || e) }); } catch (x) { }
        vscode.window.showErrorMessage('LMS: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.loginByCookie', async () => {
      const cookie = await vscode.window.showInputBox({
        prompt: 'Вставьте строку Cookie для lms.yandex.ru (F12 → Network → Request Headers → Cookie)',
        placeHolder: 'Session_id=...; yandexuid=...; csrftoken=...',
        ignoreFocusOut: true
      });
      if (!cookie) return;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: проверяю cookie…' }, async () => {
          lms.jar.clear();
          const profile = await lms.client.loginWithCookieString(cookie.trim());
          lms.profileJson = profile;
          await lms.persist();
          afterLogin(profile, null);
        });
        vscode.window.showInformationMessage('LMS: вход по cookie выполнен и сохранён.');
      } catch (e) {
        lms.jar.clear();
        await lms.persist();
        vscode.window.showErrorMessage('LMS: ' + (e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.logout', async () => {
      lms.jar.clear();
      lms.profileJson = null;
      await lms.persist();
      await context.secrets.delete(SECRET_LOGIN);
      lms.statusBar.text = '$(circle-slash) LMS: не вход';
      lms.tree.refresh();
      vscode.window.showInformationMessage('LMS: выход выполнен.');
    }),

    vscode.commands.registerCommand('yandexLms.refresh', async () => {
      if (!await lms.ensureAuth()) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: обновляю…' }, async () => {
        await lms.refreshProfile(false);
      });
    }),

    vscode.commands.registerCommand('yandexLms.grades', async (node) => {
      await lms.openGrades(node);
    }),

    vscode.commands.registerCommand('yandexLms.openTask', async (node) => {
      if (!node) {
        vscode.window.showWarningMessage('LMS: выберите задачу в панели «Яндекс LMS».');
        return;
      }
      await lms.openTask(node);
    }),

    vscode.commands.registerCommand('yandexLms.openMaterial', async (node) => {
      try {
        await lms.openMaterial(node);
      } catch (e) {
        lms.output().appendLine('LMS material: ошибка openMaterial: ' + (e && e.stack || e));
        vscode.window.showErrorMessage('LMS: не удалось открыть материал: ' + (e && e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.openLessonMaterials', async (node) => {
      try {
        await lms.openLessonMaterials(node);
      } catch (e) {
        lms.output().appendLine('LMS material: ошибка openLessonMaterials: ' + (e && e.stack || e));
        vscode.window.showErrorMessage('LMS: не удалось открыть материалы урока: ' + (e && e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.materialInBrowser', async (node) => {
      try {
        await lms.materialInBrowser(node);
      } catch (e) {
        lms.output().appendLine('LMS material: ошибка materialInBrowser: ' + (e && e.stack || e));
        vscode.window.showErrorMessage('LMS: не удалось открыть материал в браузере: ' + (e && e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.materialText', async () => {
      try {
        await lms.openMaterialText();
      } catch (e) {
        lms.output().appendLine('LMS material: ошибка materialText: ' + (e && e.stack || e));
        vscode.window.showErrorMessage('LMS: не удалось открыть материал текстом: ' + (e && e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.materialPanel', async () => {
      try {
        await lms.retryMaterialPanel();
      } catch (e) {
        lms.output().appendLine('LMS material: ошибка materialPanel: ' + (e && e.stack || e));
        vscode.window.showErrorMessage('LMS: не удалось открыть панель материала: ' + (e && e.message || e));
      }
    }),

    vscode.commands.registerCommand('yandexLms.submit', async (node) => {
      if (await lms.selectNode(node)) return;
      await lms.submitCurrent();
    }),

    vscode.commands.registerCommand('yandexLms.pullSolution', async (node) => {
      if (await lms.selectNode(node)) return;
      if (!lms.currentTask) {
        vscode.window.showWarningMessage('LMS: сначала откройте задание.');
        return;
      }
      await lms.pullSolution(lms.currentTask);
    }),

    vscode.commands.registerCommand('yandexLms.runLocal', async () => {
      await lms.runLocal();
    }),

    vscode.commands.registerCommand('yandexLms.openInBrowser', async (node) => {
      if (await lms.selectNode(node)) return;
      await lms.openCurrentInBrowser();
    }),

    vscode.commands.registerCommand('yandexLms.lens', async (node) => {
      if (await lms.selectNode(node)) return;
      await lms.lensTask();
    }),

    vscode.commands.registerCommand('yandexLms.diagnose', async () => {
      await lms.diagnose();
    }),

    vscode.commands.registerCommand('yandexLms.showLog', async () => {
      lms.output().show(true);
    }),

    vscode.commands.registerCommand('yandexLms.collect', async () => {
      const r = await lms.collectReport('manual');
      lms.output().show(true);
      vscode.window.showInformationMessage('LMS: отчёт сохранён в ' + r.file);
    }),

    vscode.commands.registerCommand('yandexLms.taskMenu', async () => { await lms.taskMenu(); }),
    vscode.commands.registerCommand('yandexLms.findImages', async () => { await lms.scanImages(); }),
    vscode.commands.registerCommand('yandexLms.answer', async (node) => { if (await lms.selectNode(node)) return; await lms.markersPickAndSend(); }),
    vscode.commands.registerCommand('yandexLms.pep8', async (node) => { if (await lms.selectNode(node)) return; await lms.pep8Check(); }),

    vscode.commands.registerCommand('yandexLms.showPanel', async () => {
      lms.setWebviewBroken(false);
      lms.forcePanel = true;
      lms.panelAttempt = 0;
      if (lms.panel) { try { lms.panel.dispose(); } catch (e) { } lms.panel = null; }
      await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask && lms.currentTask.taskId)) || { title: lms.currentTask && lms.currentTask.taskTitle });
    }),
    vscode.commands.registerCommand('yandexLms.showText', async () => { lms.forcePanel = false; await lms.showTaskDoc(true); }),
    vscode.commands.registerCommand('yandexLms.fixWebview', async () => {
      lms.webviewBroken = false;
      try {
        await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
        vscode.window.showInformationMessage('LMS: webview перезагружены.');
      } catch (e) {
        vscode.window.showErrorMessage('LMS: не удалось перезагрузить webview: ' + (e.message || e));
      }
    }),
    vscode.commands.registerCommand('yandexLms.fixWebviewProfile', async () => {
      if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('LMS: закройте VS Code, удалите папку «Service Worker» в профиле и запустите VS Code снова.');
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        'Починка webview: вы закрываете VS Code (сам, без принудительного убийства), расширение чистит кэш service worker и запускает VS Code снова. Сначала сохраните несохранённые файлы.',
        { modal: true },
        'Сохранено, закрываю'
      );
      if (pick !== 'Сохранено, закрываю') return;
      try {
        const f = scheduleWebviewRepair();
        lms.output().appendLine('LMS: починка webview запланирована: ' + f);
        vscode.window.showInformationMessage('LMS: закройте VS Code — после выхода кэш будет очищен и VS Code откроется заново.');
        // Мягкое закрытие окна: сработают стандартные предупреждения о несохранённых файлах.
        setTimeout(() => {
          try { vscode.commands.executeCommand('workbench.action.quit'); } catch (e) { }
        }, 1500);
      } catch (e) {
        vscode.window.showErrorMessage('LMS: не удалось запланировать починку: ' + (e.message || e));
      }
    }),
    vscode.commands.registerCommand('yandexLms.refreshStatus', async (node) => { if (await lms.selectNode(node)) return; await lms.reloadCurrentTask(); }),

    vscode.commands.registerCommand('yandexLms.aiHints', async (node) => { if (await lms.selectNode(node)) return; await lms.aiRun('hints'); }),
    vscode.commands.registerCommand('yandexLms.aiSolve', async (node) => { if (await lms.selectNode(node)) return; await lms.aiRun('solve'); }),
    vscode.commands.registerCommand('yandexLms.aiCheck', async (node) => { if (await lms.selectNode(node)) return; await lms.aiRun('check'); }),
    vscode.commands.registerCommand('yandexLms.aiFix', async (node) => { if (await lms.selectNode(node)) return; await lms.aiFix(); }),
    vscode.commands.registerCommand('yandexLms.details', async (node) => {
      if (await lms.selectNode(node)) return;
      const d = await lms.refreshContestLogs();
      await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask && lms.currentTask.taskId)) || { title: lms.currentTask && lms.currentTask.taskTitle });
      vscode.window.showInformationMessage(d ? 'LMS: подробности проверки показаны в панели.' : 'LMS: деталей проверки нет (задача ещё не проверялась).');
    }),
    vscode.commands.registerCommand('yandexLms.aiForget', async () => {
      lms.aiLessons = [];
      await lms.context.globalState.update('yandexLms.aiLessons', []);
      if (lms.currentTask) {
        await lms.showTaskPanel(lms.detailCache.get(String(lms.currentTask.taskId)) || { title: lms.currentTask.taskTitle });
      }
      vscode.window.showInformationMessage('LMS: память ошибок очищена.');
    }),
    vscode.commands.registerCommand('yandexLms.aiClear', async (node) => { if (await lms.selectNode(node)) return; await lms.aiClear(); }),
    vscode.commands.registerCommand('yandexLms.aiKeys', async () => { await lms.aiKeysUI(); }),
    vscode.commands.registerCommand('yandexLms.aiSettings', async () => { await lms.aiSettingsUI(); }),
    vscode.commands.registerCommand('yandexLms.settings', async (section) => {
      await lms.openSettings(typeof section === 'string' ? section : undefined);
    }),
    vscode.commands.registerCommand('yandexLms.aiTest', async () => { await lms.aiTest(); }),
    vscode.commands.registerCommand('yandexLms.aiOpencode', async () => { await lms.aiAddOpenCode(); }),
    vscode.commands.registerCommand('yandexLms.aiCline', async () => { await lms.aiAddCline(); }),

    vscode.commands.registerCommand('yandexLms.welcome', async () => {
      await welcomeWebview(context);
    })
  );

  const seen = await context.globalState.get('yandexLms.welcomeShown');
  if (!seen && lms.jar.isEmpty()) {
    await context.globalState.update('yandexLms.welcomeShown', true);
    await welcomeWebview(context);
  }
}

function deactivate() {
  // Пул ключей сохраняется с дебаунсом — при закрытии окна дописываем сразу.
  try { aiPersistNow(); } catch (e) { }
}

module.exports = { activate, deactivate };
