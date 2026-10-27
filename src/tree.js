// Дерево: курсы → уроки → задания.
const vscode = require('vscode');
const { pick, asArray } = require('./util');
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
      const r = await this.lms.client.lessonTasks(el.courseId, el.lesson.id, el.groupId);
      if (debugEnabled()) {
        try {
          fs.writeFileSync(path.join(diagDir(), 'lesson-tasks-' + el.lesson.id + '.json'), JSON.stringify(r.json, null, 2), 'utf8');
        } catch (e) { }
      }
      const arr = asArray(r.json, ['tasks', 'items', 'data', 'results']);
      let list = [];
      if (r.status === 200 && arr) {
        // Плоский список задач или список групп с tasks — во втором случае
        // итерируем arr (r.json — объект, он не итерируется).
        const groups = Array.isArray(r.json) ? r.json : (arr.length && arr[0] && arr[0].tasks ? arr : [r.json]);
        for (const group of groups) {
          const tasks = pick(group, 'tasks') || pick(group, 'problems') || pick(group, 'items') || [];
          const typeName = pick(group, 'type') || pick(group, 'title') || '';
          for (const t of tasks) {
            if (!t) continue;
            list.push(new TaskNode(this.lms, t, el, typeName));
          }
        }
      } else {
        list = [errorItem('Не загрузились задания (HTTP ' + r.status + ')', r.text)];
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
    this.tooltip = rating !== undefined && rating !== null ? `Рейтинг: ${rating}` : lms.courseLabel(course);
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
    const deadline = pick(lesson, 'deadline');
    this.tooltip = [
      total !== undefined ? `Задач: ${passed || 0}/${total}` : null,
      deadline ? `Дедлайн: ${deadline}` : null
    ].filter(Boolean).join('\n') || undefined;
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
    const deadline = pick(task, 'deadline');
    const dl = deadline ? new Date(deadline) : null;
    const deadlineTxt = dl && !Number.isNaN(dl.getTime())
      ? dl.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
      : (deadline || '');
    this.tooltip = [
      typeName ? 'Тип: ' + typeName : null,
      scoreMax !== undefined ? 'Баллов: ' + scoreMax : null,
      deadlineTxt ? 'Дедлайн: ' + deadlineTxt : null
    ].filter(Boolean).join('\n') || undefined;
    // Дедлайн в описании не показываем — он есть в подсказке при наведении:
    // строка «до 11.01.2027» у каждого задания только засоряла список.
    const st = lms.statusOf(task);
    if (st && st.badge && (st.badge.icon || st.badge.desc)) {
      this.iconPath = new vscode.ThemeIcon(st.badge.icon || 'code', st.badge.color ? new vscode.ThemeColor(st.badge.color) : undefined);
      const scoreTxt = (st.score !== undefined && st.score !== null && scoreMax !== undefined)
        ? ` ${st.score}/${scoreMax}` : '';
      this.description = [st.badge.desc + scoreTxt, this.description].filter(Boolean).join(' · ');
      this.tooltip = [this.tooltip, 'Статус: ' + st.badge.desc].filter(Boolean).join(' — ').replace(/\n/g, ' · ');
    } else {
      this.iconPath = new vscode.ThemeIcon('code');
    }
  }
}

module.exports = { LmsTreeProvider, CourseNode, LessonNode, TaskNode, errorItem };
