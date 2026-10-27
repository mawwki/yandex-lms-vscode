// Задания с вариантами ответа (schoolbook_markers / TEXT_ANSWER_PROBLEM).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { pick, escapeHtml, aiExtractJson, sanitizeStatementHtml } = require('./util');
const { debugEnabled } = require('./cfg');
const { diagDir, submitLog } = require('./diag');
const { aiChat } = require('./ai/chat');
const pool = require('./ai/pool');
const { ic } = require('./panel');

function isMarkersTask(detail) {
  if (!detail) return false;
  const tt = String(pick(detail, 'taskType') || '');
  const cp = String(pick(detail, 'contestProblemType') || '');
  return tt === 'schoolbook_markers' || cp === 'TEXT_ANSWER_PROBLEM';
}

function markersBlocks(problem) {
  if (!problem) return [];
  const sc = pick(problem, 'storeContainer');
  const mk = sc ? pick(sc, 'markers') : null;
  if (mk) {
    const layout = pick(mk, 'layout');
    if (Array.isArray(layout)) return layout;
  }
  const blocks = (pick(problem, 'markup') && pick(pick(problem, 'markup'), 'layout')) || pick(problem, 'layout') || [];
  return Array.isArray(blocks) ? blocks : [];
}

function markersMap(problem) {
  if (!problem) return {};
  const m = pick(problem, 'markers') || pick(problem, 'markerDefs') || {};
  return (m && typeof m === 'object') ? m : {};
}

function markerOptions(marker) {
  if (!marker) return [];
  const c = pick(marker, 'content') || marker;
  const o = pick(c, 'options');
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const choices = pick(o, 'choices', 'options', 'variants');
    if (Array.isArray(choices)) {
      return choices.map((ch, i) => {
        if (ch && typeof ch === 'object') {
          const val = pick(ch, 'value', 'id') !== undefined ? pick(ch, 'value', 'id') : i;
          const label = pick(ch, 'text', 'title', 'label') !== undefined ? pick(ch, 'text', 'title', 'label') : String(val);
          return { value: String(val), label: String(label) };
        }
        return { value: String(i), label: String(ch) };
      });
    }
    return [];
  }
  const opts = Array.isArray(o) ? o : (pick(c, 'options', 'variants', 'values', 'answers') || []);
  if (Array.isArray(opts)) {
    return opts.map((x, i) => {
      if (x && typeof x === 'object') {
        const val = pick(x, 'value', 'id') !== undefined ? pick(x, 'value', 'id') : i;
        const label = pick(x, 'text', 'title', 'label', 'content') !== undefined ? pick(x, 'text', 'title', 'label', 'content') : String(val);
        return { value: String(val), label: String(label) };
      }
      return { value: String(x !== undefined && x !== null ? x : i), label: String(x) };
    });
  }
  if (opts && typeof opts === 'object') {
    return Object.keys(opts).map(k => ({ value: String(k), label: String(opts[k]) }));
  }
  return [];
}

function attach(Lms) {
  Lms.prototype.isMarkersTask = function (detail) { return isMarkersTask(detail); };

  // Определение задания с вариантами: основная ручка + два фолбэка.
  Lms.prototype.fetchProblemDefinition = async function (t) {
    const sid = t && t.solutionId;
    const tid = t && t.taskId;
    const gid = t && t.groupId;
    const cand = [];
    if (sid) {
      cand.push({ m: 'GET', u: `/api/proxy/problems/solution/${sid}` });
      cand.push({ m: 'GET', u: `/api/problems/solution/${sid}` });
    }
    if (tid) {
      cand.push({ m: 'POST', u: '/api/student/problems/solution/', body: { problem_id: tid } });
      if (gid) cand.push({ m: 'GET', u: `/api/student/tasks/${tid}?groupId=${gid}` });
    }
    for (const c of cand) {
      try {
        const opts = c.m === 'POST'
          ? { headers: Object.assign(this.client.apiHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify(c.body) }
          : { headers: this.client.apiHeaders() };
        const res = await this.client.raw(c.m, this.client.base + c.u, opts);
        const text = await res.text();
        if (res.status === 200 && text) {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { }
          const pd = json ? (pick(json, 'problemDefinition') || pick(json, 'problem') || json) : null;
          if (json) {
            if (debugEnabled()) {
              try { fs.writeFileSync(path.join(diagDir(), 'problem-definition.json'), JSON.stringify(json, null, 2), 'utf8'); } catch (e) { }
            }
            return { data: json, problem: pd, source: c.u };
          }
        }
      } catch (e) { }
    }
    return { data: null, problem: null, source: null };
  };

  Lms.prototype.markersBlocks = function (problem) { return markersBlocks(problem); };
  Lms.prototype.markersMap = function (problem) { return markersMap(problem); };
  Lms.prototype.markerOptions = function (marker) { return markerOptions(marker); };

  Lms.prototype.markersPanelHtml = function () {
    const t = this.currentTask;
    if (!t || !t.isMarkers) return '';
    const problem = t.problemDefinition || null;
    const blocks = markersBlocks(problem);
    const map = markersMap(problem);
    const out = [];
    out.push('<div class="markers-question">');
    const desc = this.currentStatementHtml || '';
    if (desc && desc.trim()) {
      const clean = desc.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      out.push('<div class="marker-text">' + clean + '</div>');
    }
    if (blocks.length) {
      for (const b of blocks) {
        const kind = pick(b, 'kind');
        const content = pick(b, 'content') || {};
        if (kind === 'text' || pick(content, 'text')) {
          const raw = String(pick(content, 'text') || '');
          // сначала — уже подставленная картинка-ресурс (openTask кладёт её в inlinedText)
          const inlined = this.inlinedText && this.inlinedText.get(raw);
          if (inlined) {
            out.push('<div class="marker-text">' + inlined + '</div>');
          } else if (/<[a-z][\s\S]*>/i.test(raw)) {
            const html = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
            out.push('<div class="marker-text">' + html + '</div>');
          } else if (/\{resource:\d+\}/.test(raw)) {
            // ресурс не подгрузился — понятная заглушка вместо сырого {resource:1}
            out.push('<div class="marker-text res-missing">Картинка задания не загрузилась — откройте задание в браузере и обновите статус здесь.</div>');
          } else {
            // обычный текст-вопрос — как абзац, не как код
            out.push('<div class="marker-text"><p>' + escapeHtml(raw).replace(/\r?\n/g, '<br>') + '</p></div>');
          }
          continue;
        }
        const id = pick(content, 'id');
        const marker = (id !== undefined && map[id]) ? map[id] : content;
        const opts = markerOptions(marker);
        const type = String(pick(marker, 'type') || 'radio');
        if (!opts.length) {
          // Задание со свободным ответом (TEXT_ANSWER): на сайте поле ввода.
          const key = id !== undefined ? String(id) : 'answer';
          out.push('<div class="marker-textinput"><input type="text" data-marker="' + escapeHtml(key) + '" placeholder="Впишите ответ…" autocomplete="off"><span class="ti-hint">свободный ответ</span></div>');
          continue;
        }
        out.push('<div class="marker-options" data-marker="' + escapeHtml(String(id !== undefined ? id : '')) + '">');
        for (const o of opts) {
          const inputType = type === 'checkbox' ? 'checkbox' : 'radio';
          const nameAttr = type === 'checkbox' ? '' : ' name="m' + escapeHtml(String(id !== undefined ? id : '')) + '"';
          out.push('<label class="opt"><input type="' + inputType + '"' + nameAttr + ' data-marker="' + escapeHtml(String(id !== undefined ? id : '')) + '" value="' + escapeHtml(o.value) + '"> <span>' + escapeHtml(o.label) + '</span></label>');
        }
        out.push('</div>');
      }
    } else {
      // Условие — HTML от LMS: тот же санитайзер, что и в обычной панели.
      const desc2 = sanitizeStatementHtml(t.markersQuestion || '');
      out.push(desc2 ? '<div class="marker-text">' + desc2 + '</div>' : '<p>Условие с вариантами ответа не пришло от API. Откройте задание в браузере.</p>');
    }
    out.push('</div>');
    out.push('<div class="send-row"><button data-act="markersSubmit" class="btn primary">Ответить</button><button data-act="aiAnswer" class="btn secondary">' + ic('answer') + 'AI: выбрать ответ</button></div>');
    return out.join('\n');
  };

  Lms.prototype.markersAnswer = async function (answer) {
    const t = this.currentTask;
    if (!t || !t.solutionId) {
      vscode.window.showWarningMessage('LMS: у задания нет решения на сервере.');
      return;
    }
    if (!answer || !Object.keys(answer).length) {
      vscode.window.showWarningMessage('LMS: сначала выберите вариант или впишите ответ.');
      return;
    }
    const payload = JSON.stringify(answer);
    const urls = [
      `/api/student/solutions/${t.solutionId}/attempt`,
      `/api/proxy/student/solutions/${t.solutionId}/attempt`
    ];
    for (const u of urls) {
      try {
        const f = new FormData();
        f.append('file', new Blob([payload], { type: 'application/json' }), 'solution.json');
        const res = await this.client.raw('POST', this.client.base + u, { headers: this.client.apiHeaders(), body: f });
        const text = await res.text();
        submitLog({ label: 'markersAnswer', method: 'POST', url: u, status: res.status, req: payload, res: text.slice(0, 2000) });
        if (res.status >= 200 && res.status < 300) {
          // Жёлтый «На проверке» в дереве сразу, без ожидания API.
          this.statusMap.set(String(t.taskId), { type: 'uploaded', verdict: '', badge: { icon: 'sync', color: 'charts.yellow', desc: 'На проверке' } });
          this.tree.refresh();
          vscode.window.showInformationMessage('LMS: ответ отправлен!');
          await this.reloadCurrentTask();
          return;
        }
        this.output().appendLine('markersAnswer ' + u + ' → ' + res.status + ' ' + text.slice(0, 200));
      } catch (e) {
        this.output().appendLine('markersAnswer error: ' + (e.message || e));
      }
    }
    vscode.window.showErrorMessage('LMS: не удалось отправить ответ.');
  };

  Lms.prototype.markersPickAndSend = async function () {
    const t = this.currentTask;
    if (!t || !t.isMarkers) {
      vscode.window.showWarningMessage('LMS: это не задание с вариантами ответа.');
      return;
    }
    const problem = t.problemDefinition || null;
    const map = markersMap(problem);
    const items = [];
    for (const b of markersBlocks(problem)) {
      const content = pick(b, 'content') || {};
      const id = pick(content, 'id');
      const marker = (id !== undefined && map[id]) ? map[id] : content;
      const opts = markerOptions(marker);
      if (!opts.length) continue;
      opts.forEach((o, i) => items.push({ label: o.label, description: 'вариант ' + (i + 1), marker: id, value: o.value }));
    }
    if (!items.length) {
      // Свободный ответ — спрашиваем значение через поле ввода.
      const map = markersMap(problem);
      let markerId = null;
      for (const b of markersBlocks(problem)) {
        const content = pick(b, 'content') || {};
        if (pick(content, 'text') !== undefined) continue;
        const id = pick(content, 'id');
        const marker = (id !== undefined && map[id]) ? map[id] : content;
        if (!markerOptions(marker).length) {
          markerId = id !== undefined ? String(id) : 'answer';
          break;
        }
      }
      if (!markerId) {
        vscode.window.showWarningMessage('LMS: варианты ответа не пришли от API — откройте задание в браузере.');
        return;
      }
      const value = await vscode.window.showInputBox({ prompt: 'Впишите ответ для отправки в LMS', ignoreFocusOut: true });
      if (value === undefined || !value.trim()) return;
      const payload = {};
      payload[markerId] = value.trim();
      await this.markersAnswer(payload);
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Выберите ответ' });
    if (!picked) return;
    const payload = {};
    payload[String(picked.marker)] = picked.value;
    await this.markersAnswer(payload);
  };

  Lms.prototype.aiChooseAnswer = async function () {
    const t = this.currentTask;
    if (!t || !t.isMarkers) {
      vscode.window.showWarningMessage('LMS: это не задание с вариантами ответа.');
      return;
    }
    if (!pool.aiHasConfig()) {
      const go = await vscode.window.showInformationMessage('ИИ не настроен. Добавить провайдера (API-ключ или OpenCode CLI) сейчас?', 'Настроить');
      if (go === 'Настроить') await this.aiKeysUI();
      return;
    }
    const question = t.markersQuestion || '';
    const entries = [];
    const problem = t.problemDefinition || null;
    const map = markersMap(problem);
    for (const b of markersBlocks(problem)) {
      const content = pick(b, 'content') || {};
      const id = pick(content, 'id');
      const marker = (id !== undefined && map[id]) ? map[id] : content;
      const o = markerOptions(marker);
      entries.push({
        marker: id !== undefined ? id : 'answer',
        options: o,
        free: !o.length
      });
    }
    if (!entries.length) {
      vscode.window.showWarningMessage('LMS: задания для ответа не пришли от API.');
      return;
    }
    const questionText = question || (t.markersText || '');
    vscode.window.showInformationMessage('LMS: ИИ выбирает ответ...');
    try {
      const prompt =
        'Вопрос задания (курс «Программирование на Python»):\n' + questionText + '\n\n' +
        'Поля для ответа:\n' + entries.map((e) => {
          if (e.free) {
            return 'Маркер ' + JSON.stringify(String(e.marker)) + ': свободный ответ (число или короткий текст — посчитай сам, как это делал бы новичок)';
          }
          return 'Маркер ' + JSON.stringify(String(e.marker)) + ' (варианты):\n' + e.options.map(x => '  - value=' + JSON.stringify(x.value) + ' | ' + x.label).join('\n');
        }).join('\n\n') +
        '\n' + this.aiLessonsText() +
        'Определи правильный ответ для КАЖДОГО маркера. Для маркеров с вариантами используй точное value из списка; для свободных — посчитай и верни результат (только число/текст, без пояснений).\n' +
        'Ответь ТОЛЬКО JSON без пояснений: {"answers":{"<marker id>":"<value>"}}';
      const raw = await aiChat(prompt, this.aiSystemPrompt() + ' Ты — эксперт по основам Python и по заданиям этого курса.', 60000, null, { maxTokens: 400, temperature: 0 });
      const json = aiExtractJson(raw);
      const answers = pick(json, 'answers') || json;
      if (!answers || typeof answers !== 'object') throw new Error('Модель не вернула ответы.');
      this.aiChatAdd('ai', 'ИИ выбрал: ' + JSON.stringify(answers));
      await this.showTaskPanel(this.detailCache.get(String(t.taskId)) || { title: t.taskTitle });
      const choice = await vscode.window.showQuickPick(
        Object.keys(answers).map(k => ({ label: 'Отправить: ' + k + ' = ' + answers[k], value: answers[k], key: k })),
        { placeHolder: 'ИИ предлагает ответ — отправить?' }
      );
      if (!choice) return;
      const payload = {};
      payload[choice.key] = choice.value;
      await this.markersAnswer(payload);
    } catch (e) {
      vscode.window.showErrorMessage('LMS: ИИ: ' + (e.message || e));
    }
  };
}

module.exports = { attach, isMarkersTask, markersBlocks, markersMap, markerOptions };
