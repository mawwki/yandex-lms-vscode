// Подсветка Python в материалах: токены и безопасное экранирование.
const test = require('node:test');
const assert = require('node:assert');
const { highlightPython, highlightCodeBlocks } = require('../src/highlight');

test('highlightPython размечает переменные, циклы, числа и строки', () => {
  const html = highlightPython('counter = 0\nwhile counter < 100:\n    print("Я выучу Python")  # цикл\n    counter += 1');
  assert.ok(html.includes('<span class="tok-var">counter</span>'));
  assert.ok(html.includes('<span class="tok-op">=</span>'));
  assert.ok(html.includes('<span class="tok-num">0</span>'));
  assert.ok(html.includes('<span class="tok-kw">while</span>'));
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes('<span class="tok-num">100</span>'));
  assert.ok(html.includes('<span class="tok-builtin">print</span>'));
  assert.ok(html.includes('<span class="tok-str">&quot;Я выучу Python&quot;</span>'));
  assert.ok(html.includes('<span class="tok-com"># цикл</span>'));
  assert.ok(html.includes('<span class="tok-op">+=</span>'));
});

test('highlightPython выделяет имена функций, классов и декораторы', () => {
  const html = highlightPython('@cache\ndef greet(name):\n    return f"Привет, {name}"\n\nclass Cat:\n    pass');
  assert.ok(html.includes('<span class="tok-dec">@cache</span>'));
  assert.ok(html.includes('<span class="tok-kw2">def</span>'));
  assert.ok(html.includes('<span class="tok-fn">greet</span>'));
  assert.ok(html.includes('<span class="tok-kw">return</span>'));
  assert.ok(html.includes('<span class="tok-str">f&quot;Привет, {name}&quot;</span>'));
  assert.ok(html.includes('<span class="tok-kw2">class</span>'));
  assert.ok(html.includes('<span class="tok-cls">Cat</span>'));
  assert.ok(html.includes('<span class="tok-kw">pass</span>'));
});

test('highlightPython понимает тройные строки, константы и числа', () => {
  const html = highlightPython('"""doc"""\nif x is None:\n    y = 0xFF + 1_000 + 3.14 + .5 + 1e-3');
  assert.ok(html.includes('<span class="tok-str">&quot;&quot;&quot;doc&quot;&quot;&quot;</span>'));
  assert.ok(html.includes('<span class="tok-kw">if</span>'));
  assert.ok(html.includes('<span class="tok-kw2">is</span>'));
  assert.ok(html.includes('<span class="tok-const">None</span>'));
  assert.ok(html.includes('<span class="tok-num">0xFF</span>'));
  assert.ok(html.includes('<span class="tok-num">1_000</span>'));
  assert.ok(html.includes('<span class="tok-num">3.14</span>'));
  assert.ok(html.includes('<span class="tok-num">.5</span>'));
  assert.ok(html.includes('<span class="tok-num">1e-3</span>'));
});

test('highlightPython экранирует HTML внутри кода', () => {
  const html = highlightPython('if a < b and c > d:  # <script>alert(1)</script>\nx = "&"');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes('&gt;'));
});

test('highlightCodeBlocks подсвечивает только Python-блоки', () => {
  const py = '<pre><code class="language-python">if a &lt; b:\n    print(a)</code></pre>';
  const out = highlightCodeBlocks(py);
  assert.ok(out.includes('tok-kw'));
  assert.ok(out.includes('tok-builtin'));
  assert.ok(out.includes('&lt;'));
  assert.ok(out.includes('class="language-python"'));

  const text = '<pre><code class="language-text">if a &lt; b</code></pre>';
  assert.strictEqual(highlightCodeBlocks(text), text);
});

test('highlightCodeBlocks сохраняет атрибуты блоков', () => {
  const src = '<pre class="code"><code class="language-py" data-x="1">print(1)</code></pre>';
  const out = highlightCodeBlocks(src);
  assert.ok(out.startsWith('<pre class="code"><code class="language-py" data-x="1">'));
  assert.ok(out.includes('tok-builtin'));
});
