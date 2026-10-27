// Диагностические команды: только по явному вызову пользователя. Автозапуска нет:
// обход всех курсов — тяжёлая операция и для API, и для диска.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pick, asArray } = require('./util');
const { UA } = require('./client');
const { diagDir } = require('./diag');

function attach(Lms) {
  // Обход курсов → уроков → заданий: где в условиях есть картинки.
  Lms.prototype.scanImages = async function () {
    const out = { ts: new Date().toISOString(), found: [], errors: [] };
    const all = [];
    try {
      if (!this.profileJson) await this.refreshProfile(true);
      const courses = this.courseList();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LMS: сканирую задания на картинки…' }, async () => {
        for (const course of courses) {
          const cid = pick(course, 'id');
          const gid = pick(pick(course, 'group'), 'id') || pick(course, 'groupId') ||
            (Array.isArray(pick(course, 'groups')) && pick(course, 'groups').length ? pick(pick(course, 'groups')[0], 'id') : undefined);
          if (!cid || !gid) continue;
          const lr = await this.client.lessons(cid, gid);
          const lessons = asArray(lr.json, ['lessons', 'items', 'data', 'results', 'groups']) || [];
          for (const lesson of lessons) {
            const lid = pick(lesson, 'id');
            if (!lid) continue;
            const tr = await this.client.lessonTasks(cid, lid, gid);
            const groups = Array.isArray(tr.json) ? tr.json : (asArray(tr.json, ['tasks', 'items', 'data', 'results']) || []);
            for (const g of groups) {
              const tasks = pick(g, 'tasks') || pick(g, 'problems') || pick(g, 'items') || [];
              for (const t of tasks) {
                const tid = pick(t, 'id');
                if (!tid) continue;
                const det = await this.client.task(tid, gid);
                if (det.status !== 200 || !det.json) {
                  out.errors.push({ taskId: tid, status: det.status });
                  continue;
                }
                const html = String(pick(det.json, 'description', 'statement', 'content') || '');
                const sc = pick(det.json, 'storeContainer');
                const mk = sc ? pick(sc, 'markers') : null;
                const blocks = mk ? (pick(mk, 'layout') || []) : [];
                let markerHtml = '';
                for (const b of blocks) {
                  const c = pick(b, 'content') || {};
                  const txt = pick(c, 'text');
                  if (txt) markerHtml += String(txt) + '\n';
                }
                const rec = {
                  taskId: tid, title: pick(det.json, 'title'), lesson: pick(lesson, 'title'),
                  isMarkers: this.isMarkersTask(det.json),
                  description: html, markers: markerHtml,
                  storeContainer: sc || null
                };
                all.push(rec);
                const imgs = [...(html + '\n' + markerHtml).matchAll(/<img[^>]*?src\s*=\s*["']([^"']+)["']/gi)].map(x => x[1]);
                if (imgs.length) out.found.push({ taskId: tid, title: rec.title, lesson: rec.lesson, isMarkers: rec.isMarkers, imgs });
              }
            }
          }
        }
      });
    } catch (e) {
      out.errors.push({ error: String(e.message || e) });
    }
    try {
      fs.writeFileSync(path.join(diagDir(), 'images-scan.json'), JSON.stringify(out, null, 2), 'utf8');
      fs.writeFileSync(path.join(diagDir(), 'task-descriptions.json'), JSON.stringify(all, null, 2), 'utf8');
    } catch (e) { }
    this.output().appendLine('LMS: заданий с картинками: ' + out.found.length);
    for (const f of out.found) this.output().appendLine('  ' + f.taskId + ' ' + f.title + ' → ' + f.imgs.join(', '));
    vscode.window.showInformationMessage('LMS: заданий с картинками: ' + out.found.length + ' (отчёт в ' + path.join(diagDir(), 'images-scan.json') + ')');
    return out;
  };

  // Зонд: прозвон известных эндпоинтов. Используется только из диагностики.
  Lms.prototype.probe = async function (reason) {
    const dir = diagDir();
    const t = this.currentTask;
    const sid = t && t.solutionId;
    const taskId = t && t.taskId;
    const gid = t && t.groupId;
    const cid = t && t.courseId;
    const lid = t && t.lessonId;
    const results = [];

    const hits = [
      `/api/problems/solution/${sid}`,
      `/api/proxy/problems/solution/${sid}`,
      `/api/student/solutions/${sid}`,
      `/api/proxy/student/solutions/${sid}`,
      `/api/student/tasks/${taskId}/solution`,
      `/api/proxy/student/tasks/${taskId}/solution`,
      `/api/student/problems/solution/${sid}`,
      `/api/proxy/student/problems/solution/${sid}`
    ];
    if (cid && lid) {
      hits.push(`/api/courses/${cid}/groups/${gid}/lessons/${lid}/tasks/${taskId}/solution`);
    }
    const page = cid && lid ? `/courses/${cid}/groups/${gid}/lessons/${lid}/tasks/${taskId}` : null;
    const urls = hits.map(u => ['GET', u]);
    if (page) urls.push(['GET', page]);

    for (const [method, url] of urls) {
      const rec = { method, url, status: null, body: '' };
      try {
        const res = await this.client.raw(method, this.client.base + url, { headers: {} });
        rec.status = res.status;
        rec.finalUrl = res.finalUrl;
        rec.body = (await res.text()).slice(0, 6000);
        if (rec.status === 200 && /solutions\//.test(url)) {
          try { fs.writeFileSync(path.join(dir, 'solution-latest.json'), rec.body, 'utf8'); } catch (e2) { }
        }
      } catch (e) { rec.error = String(e.message || e); }
      results.push(rec);
      this.output().appendLine(`probe GET ${url} → ${rec.status}`);
    }

    const file = path.join(dir, 'probe-latest.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), reason: reason || 'manual', base: this.client.base, results }, null, 2), 'utf8');
    } catch (e) { }
    this.output().appendLine('=== Зонд: ' + file + ' ===');
    return results;
  };

  Lms.prototype.discoverApiPaths = async function () {
    const paths = new Set();
    const bundles = [];
    const htmlRes = await this.client.raw('GET', this.client.base + '/');
    const html = await htmlRes.text().catch(() => '');
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]);
    for (const src of srcs.slice(0, 12)) {
      const url = src.startsWith('//') ? 'https:' + src : (src.startsWith('/') ? this.client.base + src : src);
      bundles.push(url);
      let code = '';
      try {
        const r = await this.client.raw('GET', url);
        code = await r.text().catch(() => '');
      } catch (e) { continue; }
      if (!code) continue;
      for (const m of code.matchAll(/["'`](\/api\/[A-Za-z0-9_\-./%${}?:=&]+)["'`]/g)) paths.add(m[1]);
    }
    return { paths: [...paths].sort(), bundles };
  };

  Lms.prototype.collectReport = async function (reason) {
    const dir = diagDir();
    const report = {
      ts: new Date().toISOString(),
      reason: reason || 'manual',
      base: this.client.base,
      ua: UA,
      cookies: [...this.jar.map.keys()],
      steps: [],
      scripts: [],
      apiPaths: [],
      currentTask: null,
      task: null,
      solution: null
    };
    const save = (name, text) => {
      try { fs.writeFileSync(path.join(dir, name), text, 'utf8'); return name; } catch (e) { return null; }
    };
    const grab = async (name, url) => {
      try {
        const r = await this.client.raw('GET', url, { headers: { 'Accept': 'text/html,application/javascript,*/*' } });
        const text = await r.text();
        report.steps.push({ name, url, status: r.status, len: text.length, finalUrl: r.finalUrl || url });
        return { status: r.status, text, finalUrl: r.finalUrl || url };
      } catch (e) {
        report.steps.push({ name, url, error: String(e.message || e) });
        return null;
      }
    };

    const t0 = this.currentTask;
    if (t0 && t0.taskUrl) {
      const page = await grab('taskPage', t0.taskUrl);
      if (page) save('task-page.html', page.text);
    }
    if (t0) {
      report.currentTask = { taskId: t0.taskId, solutionId: t0.solutionId, compilerId: t0.compilerId, compilers: t0.compilers, groupId: t0.groupId, filePath: t0.filePath, taskUrl: t0.taskUrl };
      try {
        const tr = await this.client.task(t0.taskId, t0.groupId);
        report.task = { status: tr.status, body: String(tr.text || '').slice(0, 30000) };
      } catch (e) { report.task = { error: String(e.message || e) }; }
      if (t0.solutionId) {
        const sr = await this.solutionState(t0.solutionId);
        if (sr) report.solution = { status: sr.status, body: String(sr.text || '').slice(0, 60000) };
      }
    }
    if (this.lastAttempts && this.lastAttempts.length) report.attempts = this.lastAttempts;

    const file = save('report-latest.json', JSON.stringify(report, null, 2));
    this.output().appendLine('=== Отчёт сохранён: ' + path.join(dir, file) + ' ===');
    return { dir, file: path.join(dir, file || 'report-latest.json'), report };
  };

  Lms.prototype.diagnose = async function () {
    const out = this.output();
    out.clear();
    out.appendLine('=== Диагностика Яндекс LMS ===');
    out.appendLine('Базовый URL: ' + this.client.base);
    out.appendLine('Куки в хранилище: ' + (this.jar.isEmpty() ? 'нет' : [...this.jar.map.keys()].join(', ')));

    const dump = {
      ts: new Date().toISOString(),
      base: this.client.base,
      cookies: [...this.jar.map.keys()],
      steps: [],
      apiPaths: []
    };
    const record = (name, r, extra) => {
      const body = (r && r.text) || '';
      dump.steps.push(Object.assign({ name, status: r ? r.status : null, url: r ? r.url : null, body: body.slice(0, 6000) }, extra || {}));
      out.appendLine('');
      out.appendLine(`--- ${name} → HTTP ${r ? r.status : 'ERR'}`);
      out.appendLine(body.slice(0, 400));
    };
    const tryGet = async (name, ep) => {
      try {
        const r = await this.client.api('GET', ep);
        record(name, r, { endpoint: ep });
        return r;
      } catch (e) {
        out.appendLine(`--- ${name} → ОШИБКА: ${e.message}`);
        dump.steps.push({ name, endpoint: ep, error: String(e.message || e) });
        return null;
      }
    };

    await tryGet('profile', '/api/profile?withCoursesSummary=true&withExpelled=true&withChildren=true&withParents=true');

    const courses = this.courseList();
    dump.courseCount = courses.length;
    if (courses.length) {
      const c = courses[0];
      const gid = pick(pick(c, 'group'), 'id');
      dump.firstCourse = { id: pick(c, 'id'), title: pick(c, 'title'), groupId: gid };
      const r = await tryGet('lessons', `/api/student/lessons?courseId=${c.id}&groupId=${gid}`);
      if (r && r.status === 200 && r.json) {
        const lessons = asArray(r.json, ['lessons', 'items', 'data', 'results']) || [];
        if (lessons.length) {
          const lid = pick(lessons[0], 'id');
          await tryGet('lessonTasks', `/api/student/lessonTasks?courseId=${c.id}&lessonId=${lid}&groupId=${gid}`);
        }
      }
    }

    out.appendLine('');
    out.appendLine('Сканирую JS-бандл LMS в поисках реальных эндпоинтов…');
    try {
      const found = await this.discoverApiPaths();
      dump.apiPaths = found.paths;
      dump.bundles = found.bundles;
      out.appendLine('Найдено эндпоинтов в бандле: ' + found.paths.length);
      for (const p of found.paths.slice(0, 120)) out.appendLine('  ' + p);
    } catch (e) {
      out.appendLine('Сканирование бандла не удалось: ' + (e.message || e));
    }

    if (this.lastAttempts.length) {
      out.appendLine('');
      out.appendLine('=== Последние попытки отправки решения ===');
      for (const a of this.lastAttempts) {
        out.appendLine(`${a.status}  ${a.label}`);
        out.appendLine('   ' + String(a.detail || '').replace(/\n/g, '\n   '));
      }
    }

    let file = '';
    try {
      file = path.join(diagDir(), 'dump.json');
      fs.writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
      out.appendLine('');
      out.appendLine('Полный отчёт сохранён: ' + file);
    } catch (e) {
      out.appendLine('Не удалось сохранить отчёт: ' + (e.message || e));
    }

    out.show(true);
    vscode.window.showInformationMessage('LMS: диагностика записана в Output → «Yandex LMS».' + (file ? ' Файл: ' + file : ''));
  };
}

module.exports = { attach };
