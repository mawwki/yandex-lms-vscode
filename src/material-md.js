// Запасной рендер материала без webview: Markdown для встроенного предпросмотра
// VS Code и простой текст для редактора. Чистые функции без зависимости от
// vscode — тестируются напрямую (test/material-md.test.js).
const {
  pick, decodeEntities, sanitizeStatementHtml, htmlToText,
  materialDisplayTitle, materialTypeLabel, materialReadingMinutes
} = require('./util');

// ── URL ──
// Ссылки и картинки LMS приходят абсолютными или от корня сайта. Предпросмотр
// Markdown живёт на file://, поэтому относительные адреса надо достроить.
function resolveMaterialUrl(src, baseUrl) {
  const s = String(src || '').trim();
  if (!s || /^(data:|blob:|mailto:|tel:|#)/i.test(s)) return s;
  try { return new URL(s, baseUrl || undefined).toString(); } catch (e) { return s; }
}

function mdUrl(url) {
  return String(url || '')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function mdHeadingText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/([#*_`[\]])/g, '\\$1');
}

// ── код ──
const LANG_ALIASES = {
  py: 'python', python3: 'python', py3: 'python',
  js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash',
  csharp: 'csharp', 'c++': 'cpp', 'c#': 'csharp', golang: 'go'
};

function aliasLang(lang) {
  const k = String(lang || '').trim().toLowerCase();
  return LANG_ALIASES[k] || k;
}

// Язык берём из class="language-python" / data-language, а если разметка его
// не сохранила — узнаём Python по характерным конструкциям.
function detectCodeLanguage(attrs, code) {
  const src = String(attrs || '');
  let m = /(?:language-|lang-|brush:\s*)([\w+#.-]+)/i.exec(src);
  if (!m) m = /data-(?:language|lang)\s*=\s*["']([\w+#.-]+)["']/i.exec(src);
  if (m) return aliasLang(m[1]);
  const c = String(code || '');
  if (/^\s*(?:def|class|import|from|for|while|if|elif|else|print|return|with|try|except|raise|pass|lambda)\b/m.test(c) ||
      /\bprint\s*\(/.test(c)) return 'python';
  if (/^\s*\$ /m.test(c) ||
      /^\s*(?:npm|npx|pip|python|git|cd|ls|mkdir|rm|echo)\b/m.test(c)) return 'bash';
  return '';
}

function inlineCode(text) {
  const s = String(text || '');
  const runs = s.match(/`+/g) || [];
  const n = Math.max(1, ...runs.map(r => r.length + 1));
  const fence = '`'.repeat(n);
  const pad = /^`|`$/.test(s) ? ' ' : '';
  return fence + pad + s + pad + fence;
}

// ── строки разметки ──
function inlineHtmlToMd(html, baseUrl) {
  let s = String(html || '');
  // Инлайновый код обрабатываем первым: внутри него теги — это текст.
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, code) => {
    return inlineCode(decodeEntities(code.replace(/<[^>]+>/g, '')));
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    const text = decodeEntities(label.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return text;
    return '[' + text.replace(/([\[\]])/g, '\\$1') + '](' + mdUrl(resolveMaterialUrl(href, baseUrl)) + ')';
  });
  s = s.replace(/<br\s*\/?>/gi, '  \n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s);
}

function listToMd(inner, ordered, baseUrl) {
  const items = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(inner))) {
    const text = inlineHtmlToMd(m[1], baseUrl).replace(/\s+/g, ' ').trim();
    if (text) items.push((ordered ? '1. ' : '- ') + text);
  }
  return items.join('\n');
}

function tableToMd(tbl, baseUrl) {
  const rows = [...String(tbl || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(tr => [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(cell => inlineHtmlToMd(cell[1], baseUrl).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()))
    .filter(row => row.length && row.some(c => c));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => {
    const c = r.slice();
    while (c.length < width) c.push('');
    return c;
  });
  const out = ['| ' + norm[0].join(' | ') + ' |', '| ' + Array(width).fill('---').join(' | ') + ' |'];
  for (let i = 1; i < norm.length; i++) out.push('| ' + norm[i].join(' | ') + ' |');
  return '\n\n' + out.join('\n') + '\n\n';
}

// HTML материала → Markdown. Блоки кода вынимаем в плейсхолдеры, чтобы
// последующая нормализация пробелов не съела отступы и переводы строк.
function htmlToMaterialMarkdown(html, baseUrl) {
  let s = sanitizeStatementHtml(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  // В панели оглавление подписано отдельно; в Markdown делаем то же самое.
  s = s.replace(
    /<section([^>]*\bclass\s*=\s*["'][^"']*\bmaterial__plan\b[^"']*["'][^>]*)>/i,
    '<section$1><h2>Содержание</h2>'
  );

  const blocks = [];
  const hold = (text) => {
    blocks.push(text);
    return '\u0000MD' + (blocks.length - 1) + '\u0000';
  };

  // <pre> — до нормализации переводов строк.
  s = s.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (m, attrs, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, '').replace(/\r\n?/g, '\n'))
      .replace(/^\n+|\n+$/g, '');
    if (!code.trim()) return '';
    const lang = detectCodeLanguage(attrs + ' ' + String(inner).slice(0, 300), code);
    const runs = code.match(/`{3,}/g) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(r => r.length + 1)));
    return hold('\n\n' + fence + lang + '\n' + code + '\n' + fence + '\n\n');
  });

  // В обычном HTML перевод строки — пробел, а не граница абзаца.
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t]*\n[ \t]*/g, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ');

  s = s.replace(/<table\b[\s\S]*?<\/table>/gi, tbl => hold(tableToMd(tbl, baseUrl)));

  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!src) return '';
    const alt = decodeEntities((/\balt\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1] || '')
      .replace(/[\[\]]/g, '');
    return '\n\n![' + alt + '](' + mdUrl(resolveMaterialUrl(src, baseUrl)) + ')\n\n';
  });

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, level, inner) => {
    const lvl = Math.min(Number(level) + 1, 6);
    return '\n\n' + '#'.repeat(lvl) + ' ' + inlineHtmlToMd(inner, baseUrl).trim() + '\n\n';
  });

  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (m, inner) => '\n\n' + listToMd(inner, true, baseUrl) + '\n\n');
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (m, inner) => '\n\n' + listToMd(inner, false, baseUrl) + '\n\n');

  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) => {
    const text = inlineHtmlToMd(inner, baseUrl).trim().replace(/\n/g, '\n> ');
    return text ? '\n\n> ' + text + '\n\n' : '';
  });

  s = s.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  s = s.replace(/<\/(p|div|section|article|header|footer|aside|figure|figcaption|tr|thead|tbody|dt|dd|details|summary)>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li>/gi, '\n');

  s = inlineHtmlToMd(s, baseUrl);
  s = s.replace(/^[ \t]+/gm, '');
  s = s.replace(/\u0000MD(\d+)\u0000/g, (m, i) => blocks[Number(i)] || '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function materialMarkdown(current, baseUrl) {
  const detail = (current && current.detail) || {};
  const material = (current && current.material) || {};
  const content = String(pick(detail, 'content') || '');
  const title = materialDisplayTitle(detail.title ? detail : material);
  const typeLabel = materialTypeLabel(pick(detail, 'type') || pick(material, 'type'));
  const minutes = materialReadingMinutes(content);
  const crumbs = [current && current.courseTitle, current && current.lessonTitle].filter(Boolean);
  const body = htmlToMaterialMarkdown(content, baseUrl) ||
    '_Материал пуст или ещё не загружен в LMS._';
  const lines = ['# ' + mdHeadingText(title), ''];
  if (crumbs.length) lines.push('*' + crumbs.map(mdHeadingText).join(' › ') + '*', '');
  lines.push('`' + typeLabel + '`' + (minutes ? ' · ' + minutes + ' мин чтения' : ''));
  lines.push('', '---', '', body);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function materialPlainText(current) {
  const detail = (current && current.detail) || {};
  const material = (current && current.material) || {};
  const content = String(pick(detail, 'content') || '');
  const title = materialDisplayTitle(detail.title ? detail : material);
  const typeLabel = materialTypeLabel(pick(detail, 'type') || pick(material, 'type'));
  const minutes = materialReadingMinutes(content);
  const crumbs = [current && current.courseTitle, current && current.lessonTitle].filter(Boolean);
  const body = htmlToText(sanitizeStatementHtml(content)) || 'Материал пуст или ещё не загружен в LMS.';
  const lines = [title];
  if (crumbs.length) lines.push(crumbs.join(' › '));
  lines.push([typeLabel, minutes ? minutes + ' мин чтения' : ''].filter(Boolean).join(' · '));
  lines.push('─'.repeat(60), '', body, '');
  return lines.join('\n');
}

module.exports = {
  htmlToMaterialMarkdown,
  materialMarkdown,
  materialPlainText,
  resolveMaterialUrl,
  detectCodeLanguage
};
