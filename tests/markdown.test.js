import { describe, test, expect } from 'bun:test';
import { renderMarkdown, plainText } from '../src/markdown.js';

describe('renderMarkdown', () => {
  test('headings', () => {
    expect(renderMarkdown('# Hello')).toContain('<h1>Hello</h1>');
    expect(renderMarkdown('### Sub')).toContain('<h3>Sub</h3>');
  });

  test('bold / italic / inline code', () => {
    const h = renderMarkdown('**bold** and *ital* and `code`');
    expect(h).toContain('<strong>bold</strong>');
    expect(h).toContain('<em>ital</em>');
    expect(h).toContain('<code>code</code>');
  });

  test('code blocks preserve content unescaped-ish and unformatted', () => {
    const h = renderMarkdown('```\n**not bold**\n```');
    expect(h).toContain('<pre><code>');
    expect(h).toContain('**not bold**');
    expect(h).not.toContain('<strong>');
  });

  test('links', () => {
    expect(renderMarkdown('[t](https://x.y)')).toContain('<a href="https://x.y"');
  });

  test('lists and task checkboxes', () => {
    const h = renderMarkdown('- a\n- [x] done\n- [ ] todo\n1. one\n2. two');
    expect(h).toContain('<ul>');
    expect(h).toContain('<ol>');
    expect(h).toContain('type="checkbox"');
    expect(h).toContain('checked');
  });

  test('preview task checkboxes are enabled and carry their source line', () => {
    const h = renderMarkdown('# Head\n\n- [ ] first\n- [x] second');
    expect(h).not.toContain('disabled');
    expect(h).toContain('class="task-check" data-line="2"');
    expect(h).toContain('class="task-check" data-line="3"');
  });

  test('blockquotes and hr', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote>');
    expect(renderMarkdown('---')).toContain('<hr>');
  });

  test('HTML is escaped (XSS-safe)', () => {
    const h = renderMarkdown('<script>alert(1)</script>');
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
  });

  test('paragraphs', () => {
    expect(renderMarkdown('hello\nworld')).toContain('<p>');
  });

  test('mermaid fence becomes a diagram hook, not a code block', () => {
    const h = renderMarkdown('```mermaid\nflowchart TD\n  A-->B\n```');
    expect(h).toContain('<pre class="mermaid">');
    expect(h).toContain('flowchart TD');
    expect(h).not.toContain('<pre><code>');
  });

  test('mermaid fence is case/space tolerant and escapes source', () => {
    const h = renderMarkdown('``` Mermaid\nA-->B & <C>\n```');
    expect(h).toContain('<pre class="mermaid">');
    expect(h).toContain('A--&gt;B &amp; &lt;C&gt;');
  });

  test('other fences are still plain code blocks', () => {
    const h = renderMarkdown('```js\nconst x = 1;\n```');
    expect(h).toContain('<pre><code>');
    expect(h).not.toContain('class="mermaid"');
  });

  test('mermaid source is stripped from plain-text snippets', () => {
    expect(plainText('```mermaid\nflowchart TD\n  A-->B\n```')).toBe('');
  });

  test('pipe tables render with alignment', () => {
    const h = renderMarkdown('| Name | Age |\n| --- | ---: |\n| Ada | 36 |\n| Bob | 41 |');
    expect(h).toContain('<table>');
    expect(h).toContain('<th>Name</th>');
    expect(h).toContain('<th style="text-align:right">Age</th>');
    expect(h).toContain('<td>Ada</td>');
    expect(h).toContain('<td style="text-align:right">36</td>');
  });

  test('a pipe row without a valid separator is not a table', () => {
    const h = renderMarkdown('| A |\n| -- |\n| 1 |');
    expect(h).not.toContain('<table>');
  });

  test('details blocks fold, render markdown inside, and close', () => {
    const h = renderMarkdown('<details>\n<summary>Click me</summary>\n\nSome **bold** text\n\n</details>\n\nAfter');
    expect(h).toContain('<details>');
    expect(h).toContain('<summary>Click me</summary>');
    expect(h).toContain('<p>Some <strong>bold</strong> text</p>');
    expect(h).toContain('</details>');
    expect(h).toContain('<p>After</p>');
  });

  test('details open variant works, attributes stay escaped', () => {
    expect(renderMarkdown('<details open>\n<summary>S</summary>\nBody\n</details>')).toContain('<details open>');
    const evil = renderMarkdown('<details onclick="alert(1)">\n<summary>x</summary>\n</details>');
    expect(evil).not.toContain('onclick="alert');
    expect(evil).toContain('&lt;details');
  });

  test('stray closing tags render as escaped text, never hang', () => {
    const h = renderMarkdown('hello\n</details>\nworld');
    expect(h).toContain('<p>hello</p>');
    expect(h).toContain('&lt;/details&gt;');
    expect(h).toContain('<p>world</p>');
  });

  test('unclosed details auto-closes at end of document', () => {
    const h = renderMarkdown('<details>\n<summary>S</summary>\nBody');
    expect(h).toContain('<details>');
    expect(h).toContain('</details>');
  });
});

describe('plainText', () => {
  test('strips formatting', () => {
    expect(plainText('# Hi **there** `x`')).toBe('Hi there x');
    expect(plainText('[t](https://x)')).toBe('t');
  });
});
