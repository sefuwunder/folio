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
});

describe('plainText', () => {
  test('strips formatting', () => {
    expect(plainText('# Hi **there** `x`')).toBe('Hi there x');
    expect(plainText('[t](https://x)')).toBe('t');
  });
});
