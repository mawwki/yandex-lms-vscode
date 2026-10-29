// Дерево: курсы → уроки → материалы и задания.
const vscode = require('vscode');
const {
  pick, asArray, materialTypeLabel, materialDisplayTitle,
  flattenLessonTasks, gradeRow, progressLine, deadlineInfo, roundScore
} = require('./util');
const { debugEnabled } = require('./cfg');
const fs = require('fs');
const path = require('path');
const { diagDir } = require('./diag');

function errorItem(message, detail) {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('warning');
  item.tooltip = detail ? String(detail).slice(0, 1500) : message;
  item.command = { command: 'yandexLms.diagnose', title: 'Диагностика API' };
  return item;
}

// Прогресс живёт в кэше Lms: он обновляется при раскрытии урока (из того же
// lessonTasks) и при сборе ведомости, поэтому полоска в дереве появляется
// без ожидания сети и переживает перезагрузку окна.
function progressOf(lms, mapName, id) {
  const map = lms && lms[mapName];
  if (!map || typeof map.get !== 'function' || id === undefined || id === null) return null;
  try { return map.get(String(id)) || null; } catch (e) { return null; }
}

function updatedText(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

class LmsTreeProvider {
  constructor(lms) {
    this.lms = lms;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.cache = new Map();
  }

  refresh() {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(el) {
    return el;
  }

  async getChildren(el) {
    if (!el) {
      if (!this.lms.profileJson) {
        const item = new vscode.TreeItem('Войти в LMS…', vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'yandexLms.loginMenu', title: 'Войти' };
        item.iconPath = new vscode.ThemeIcon('sign-in');
        return [item];
      }
      const courses = this.lms.courseList();
      if (!courses.length) {
        const item = new vscode.TreeItem('Курсы не найдены — обновите (LMS: Обновить список курсов)', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('warning');
        return [item];
      }
      return courses.map(c => new CourseNode(this.lms, c));
    }
    if (el instanceof CourseNode) {
      const key = 'course:' + el.course.id;
      if (this.cache.has(key)) return this.cache.get(key);
      const r = await this.lms.client.lessons(el.course.id, el.groupId);
      const arr = asArray(r.json, ['lessons', 'items', 'data', 'results', 'groups']);
      let list = [];
      if (r.status === 200 && arr) {
        list = arr.map(l => new LessonNode(this.lms, l, el));
      } else {
        list = [errorItem('Не загрузились уроки (HTTP ' + r.status + ')', r.text)];
      }
      this.cache.set(key, list);
      return list;
    }
    if (el instanceof LessonNode) {
      const key = 'lesson:' + el.lesson.id;
      if (this.cache.has(key)) return this.cache.get(key);
      // Материалы и задания грузим параллельно: раскрытие урока не должно
      // ждать двух последовательных запросов. Сбой материалов не ломает
      // список заданий — это дополнительный, необязательный раздел.
      const [tasksRes, materialsRes] = await Promise.all([
        this.lms.client.lessonTasks(el.courseId, el.lesson.id, el.groupId),
        this.lms.client.lessonMaterials(el.courseId, el.lesson.id, el.groupId)
      ]);
      const r = tasksRes;
      if (debugEnabled()) {
        try {
          fs.writeFileSync(path.join(diagDir(), 'lesson-tasks-' + el.lesson.id + '.json'), JSON.stringify(r.json, null, 2), 'utf8');
          fs.writeFileSync(path.join(diagDir(), 'lesson-materials-' + el.lesson.id + '.json'), JSON.stringify(materialsRes.json, null, 2), 'utf8');
        } catch (e) { }
      }
      let list = [];
      const materialsArr = materialsRes && materialsRes.status === 200
        ? asArray(materialsRes.json, ['materials', 'items', 'data', 'results'])
        : null;
      const materials = Array.isArray(materialsArr) ? materialsArr.filter(m => m && pick(m, 'id') !== undefined) : [];
      for (const m of materials) list.push(new MaterialNode(this.lms, m, el, materials));
      const arr = asArray(r.json, ['tasks', 'items', 'data', 'results']);
      if (r.status === 200 && arr) {
        // Разбор формы ответа (группы по тегу или плоский список) общий с
        // ведомостью оценок — src/util.js:flattenLessonTasks.
        const flat = flattenLessonTasks(r.json);
        for (const { task, typeName } of flat) list.push(new TaskNode(this.lms, task, el, typeName));
        // Прогресс урока считаем из тех же данных, что и список заданий:
        // lessonTasks уже содержит solution.score и scoreMax, отдельных
        // запросов на баллы не нужно.
        if (flat.length && typeof this.lms.noteLessonProgress === 'function') {
          this.lms.noteLessonProgress(el.courseId, el.lesson, flat.map(x => gradeRow(x.task, this.lms.statusOf(x.task))));
        }
      } else {
        list.push(errorItem('Не загрузились задания (HTTP ' + r.status + ')', r.text));
      }
      this.cache.set(key, list);
      this.lms.ensureStatuses(list);
      return list;
    }
    return [];
  }
}

class CourseNode extends vscode.TreeItem {
  constructor(lms, course) {
    super(lms.courseLabel(course), vscode.TreeItemCollapsibleState.Collapsed);
    this.course = course;
    this.courseId = course.id;
    this.groupId = pick(pick(course, 'group'), 'id');
    this.contextValue = 'lmsCourse';
    this.iconPath = new vscode.ThemeIcon('book');
    const rating = pick(course, 'rating');
    const prog = progressOf(lms, 'courseProgress', this.courseId);
    const bits = [];
    if (rating !== undefined && rating !== null) bits.push('Рейтинг: ' + roundScore(rating));
    if (prog && prog.total) bits.push(progressLine(prog, 10));
    if (prog && !prog.full) bits.push('Посчитано по ' + (prog.lessonsKnown || 0) + ' раскрытым урокам — «Мои оценки» считает весь курс');
    if (prog && prog.ts) bits.push('Обновлено: ' + updatedText(prog.ts));
    this.tooltip = bits.join('\n') || lms.courseLabel(course);
    // Полоска только когда известна вся сумма курса, иначе цифры выглядят
    // как настоящие, а по факту считают лишь раскрытые уроки.
    if (prog && prog.full && prog.total) this.description = progressLine(prog, 6);
  }
}

class LessonNode extends vscode.TreeItem {
  constructor(lms, lesson, courseNode) {
    super(pick(lesson, 'title') || pick(lesson, 'shortTitle', 'short_title') || 'Урок', vscode.TreeItemCollapsibleState.Collapsed);
    this.lesson = lesson;
    this.courseId = courseNode.courseId;
    this.groupId = courseNode.groupId;
    this.courseTitle = courseNode.label;
    this.contextValue = 'lmsLesson';
    this.iconPath = new vscode.ThemeIcon('notebook');
    const passed = pick(lesson, 'numPassed', 'num_passed');
    const total = pick(lesson, 'numTasks', 'num_tasks');
    const dl = deadlineInfo(pick(lesson, 'deadline'));
    const prog = progressOf(lms, 'progressMap', pick(lesson, 'id'));
    const bits = [];
    if (prog && prog.total) bits.push(progressLine(prog, 10));
    else if (total !== undefined) bits.push('Задач: ' + (passed || 0) + '/' + total);
    if (dl.state !== 'none') bits.push('Дедлайн: ' + dl.when + (dl.hint ? ' (' + dl.hint + ')' : ''));
    if (prog && prog.overdue) bits.push('Просрочено обязательных: ' + prog.overdue);
    this.tooltip = bits.join('\n') || undefined;
    if (prog && prog.total) this.description = progressLine(prog, 6);
  }
}

class MaterialNode extends vscode.TreeItem {
  constructor(lms, material, lessonNode, materials) {
    super(materialDisplayTitle(material), vscode.TreeItemCollapsibleState.None);
    this.material = material;
    this.materialId = pick(material, 'id');
    this.groupId = lessonNode.groupId;
    this.courseId = lessonNode.courseId;
    this.lessonId = lessonNode.lesson && lessonNode.lesson.id;
    this.courseTitle = lessonNode.courseTitle;
    this.lessonTitle = lessonNode.label;
    this.materials = Array.isArray(materials) ? materials : [];
    this.contextValue = 'lmsMaterial';
    this.iconPath = new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.blue'));
    this.description = materialTypeLabel(pick(material, 'type'));
    this.tooltip = [
      'Тип: ' + this.description,
      lessonNode.label ? 'Урок: ' + lessonNode.label : null,
      'Нажмите, чтобы читать в VS Code'
    ].filter(Boolean).join('\n');
    this.command = {
      command: 'yandexLms.openMaterial',
      title: 'Открыть материал',
      arguments: [this]
    };
  }
}

class TaskNode extends vscode.TreeItem {
  constructor(lms, task, lessonNode, typeName) {
    const title = pick(task, 'title') || pick(task, 'shortTitle', 'short_title') || 'Задача';
    super(title, vscode.TreeItemCollapsibleState.None);
    this.task = task;
    this.groupId = lessonNode.groupId;
    this.courseId = lessonNode.courseId;
    this.lessonId = lessonNode.lesson && lessonNode.lesson.id;
    this.courseTitle = lessonNode.courseTitle;
    this.lessonTitle = lessonNode.label;
    this.contextValue = 'lmsTask';
    this.command = {
      command: 'yandexLms.openTask',
      title: 'Открыть задание',
      arguments: [this]
    };
    const scoreMax = pick(task, 'scoreMax', 'score_max');
    const dl = deadlineInfo(pick(task, 'deadline'));
    const optional = !!(pick(task, 'isOptional', 'is_optional'));
    this.tooltip = [
      typeName ? 'Тип: ' + typeName : null,
      scoreMax !== undefined ? 'Баллов: ' + scoreMax : null,
      dl.state !== 'none' ? 'Дедлайн: ' + dl.when + (dl.hint ? ' (' + dl.hint + ')' : '') : null,
      optional ? 'Дополнительная задача' : null
    ].filter(Boolean).join('\n') || undefined;
    // Дедлайн в описании не показываем — он есть в подсказке при наведении:
    // строка «до 11.01.2027» у каждого задания только засоряла список.
    // Исключение — просроченная незачтённая задача: её надо видеть сразу.
    const st = lms.statusOf(task);
    if (st && st.badge && (st.badge.icon || st.badge.desc)) {
      this.iconPath = new vscode.ThemeIcon(st.badge.icon || 'code', st.badge.color ? new vscode.ThemeColor(st.badge.color) : undefined);
      const scoreTxt = (st.score !== undefined && st.score !== null && scoreMax !== undefined)
        ? ` ${st.score}/${scoreMax}` : '';
      this.description = [st.badge.desc + scoreTxt, this.description].filter(Boolean).join(' · ');
      if (dl.state === 'overdue' && st.badge.icon !== 'pass') this.description += ' · просрочено';
      this.tooltip = [this.tooltip, 'Статус: ' + st.badge.desc].filter(Boolean).join(' — ').replace(/\n/g, ' · ');
    } else {
      this.iconPath = new vscode.ThemeIcon('code');
    }
  }
}

module.exports = { LmsTreeProvider, CourseNode, LessonNode, MaterialNode, TaskNode, errorItem };
