// ИИ-автодополнение: следующая строка решения по условию задачи.
// Быстрое отключение при таймауте — провайдер не должен тормозить набор.
const vscode = require('vscode');
const { cfg } = require('./cfg');
const { aiChat } = require('./ai/chat');
const pool = require('./ai/pool');

class AiAutocomplete {
  constructor(lms) {
    this.lms = lms;
    this.timer = null;
    this.pending = null;
    this.cache = new Map();
    this.calls = [];
  }

  cancel() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      try { p.resolve(undefined); } catch (e) { }
    }
  }

  async provideInlineCompletionItems(document, position) {
    const lms = this.lms;
    if (!cfg().get('ai.autocomplete')) return undefined;
    const t = lms && lms.currentTask;
    if (!t || !t.filePath) return undefined;
    if (document.uri.fsPath !== t.filePath) return undefined;
    if (!pool.aiHasConfig()) return undefined;

    const text = document.getText();
    const upto = text.slice(0, document.offsetAt(position));
    const key = document.uri.fsPath + '|' + upto.length + '|' + upto.slice(-150);
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      return v ? [v] : undefined;
    }
    const now = Date.now();
    this.calls = this.calls.filter(x => now - x < 60000);
    const maxCalls = Number(cfg().get('ai.autocompleteMaxCalls') || 12);
    if (this.calls.length >= maxCalls) return undefined;

    const delay = Number(cfg().get('ai.autocompleteDelay') || 800);
    return new Promise((resolve) => {
      this.cancel();
      this.timer = setTimeout(async () => {
        this.timer = null;
        this.pending = null;
        let item = null;
        try {
          item = await this.ask(lms, upto);
          this.calls.push(Date.now());
        } catch (e) { item = null; }
        this.cache.set(key, item);
        if (this.cache.size > 80) {
          const first = this.cache.keys().next().value;
          this.cache.delete(first);
        }
        resolve(item ? [item] : undefined);
      }, delay);
      this.pending = { resolve };
    });
  }

  async ask(lms, upto) {
    const statement = lms.aiStatement();
    const lessons = lms.aiLessonsText();
    const prompt =
      'УСЛОВИЕ ЗАДАЧИ:\n' + (statement || '(условие неизвестно)') + '\n\n' +
      'КОД, НАПИСАННЫЙ УЧЕНИКОМ ДО КУРСОРА:\n' + upto.slice(-3000) + '\n\n' +
      lessons +
      'Ученик прошёл только базовый курс Python: ввод-вывод, строки, списки, циклы for/while, условия. Без модулей (import, sys), без классов и try/except.\n' +
      'Напиши ТОЛЬКО следующую строку кода (или 1-2 строки), которая продолжает решение по этому условию. ' +
      'Никаких пояснений, никакого markdown, никаких ``` — только код, готовый к вставке с правильным отступом. ' +
      'Если по условию для следующей строки нужно вывести результат — выведи его.';
    const raw = await aiChat(prompt, 'Ты — учитель Python курса Яндекс LMS. Ты даёшь только код, без пояснений.', 15000, null, { maxTokens: 80, temperature: 0, hedge: false, noPenalty: true });
    let s = String(raw || '').trim();
    s = s.replace(/^```(?:python)?/i, '').replace(/```\s*$/, '').trim();
    s = s.replace(/^(?:Вот|Ответ|Код|Next)[^\n:]*:\s*/i, '');
    const lines = s.split(/\r?\n/);
    const out = [];
    for (const l of lines) {
      if (out.length >= 2) break;
      if (!l.trim() && out.length === 0) continue;
      out.push(l);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    const code = out.join('\n');
    if (!code.trim()) return null;
    if (/^\s*(вот|ответ|код|следующ)/i.test(code.trim())) return null;
    return new vscode.InlineCompletionItem(code);
  }
}

module.exports = { AiAutocomplete };
