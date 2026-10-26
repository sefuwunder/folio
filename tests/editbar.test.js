import { describe, test, expect } from 'bun:test';
import { wrapSelection, prefixLines, numberLines, insertTable, insertDetails } from '../src/editbar.js';

describe('wrapSelection', () => {
  test('wraps the selection and keeps it on the inner text', () => {
    const r = wrapSelection('hello world', 6, 11, '**', '**', 'bold text');
    expect(r.value).toBe('hello **world**');
    expect([r.start, r.end]).toEqual([8, 13]);
  });

  test('empty selection inserts a placeholder and selects it', () => {
    const r = wrapSelection('hi', 2, 2, '**', '**', 'bold text');
    expect(r.value).toBe('hi**bold text**');
    expect([r.start, r.end]).toEqual([4, 13]);
  });
});

describe('prefixLines', () => {
  test('adds the prefix to every touched line', () => {
    const r = prefixLines('a\nb', 0, 3, '- ', /^[-*+]\s+/);
    expect(r.value).toBe('- a\n- b');
  });

  test('strips when every touched line already has it', () => {
    const r = prefixLines('- a\n- b', 0, 7, '- ', /^[-*+]\s+/);
    expect(r.value).toBe('a\nb');
  });

  test('partial: only missing lines gain the prefix', () => {
    const r = prefixLines('- a\nb', 0, 5, '- ', /^[-*+]\s+/);
    expect(r.value).toBe('- a\n- b');
  });

  test('heading toggle strips any heading level', () => {
    const r = prefixLines('## Hi\n# Yo', 0, 9, '## ', /^#{1,6}\s+/);
    expect(r.value).toBe('Hi\nYo');
  });

  test('task toggle strips checked markers too', () => {
    const r = prefixLines('- [x] done', 0, 11, '- [ ] ', /^-\s\[[ xX]\]\s+/);
    expect(r.value).toBe('done');
  });
});

describe('numberLines', () => {
  test('numbers sequentially and toggles back off', () => {
    const r = numberLines('a\nb\nc', 0, 5);
    expect(r.value).toBe('1. a\n2. b\n3. c');
    const back = numberLines(r.value, 0, r.value.length);
    expect(back.value).toBe('a\nb\nc');
  });
});

describe('insertTable', () => {
  test('skeleton at line start, first header selected', () => {
    const r = insertTable('', 0, 0);
    expect(r.value).toBe('| Header | Header |\n| --- | --- |\n|  |  |');
    expect([r.start, r.end]).toEqual([2, 8]);
  });

  test('mid-line insert starts on its own line', () => {
    const r = insertTable('hello', 5, 5);
    expect(r.value.startsWith('hello\n| Header')).toBe(true);
    expect([r.start, r.end]).toEqual([8, 14]);
  });
});

describe('insertDetails', () => {
  test('foldable skeleton, summary placeholder selected', () => {
    const r = insertDetails('', 0, 0);
    expect(r.value).toBe('<details>\n<summary>Summary</summary>\n\nContent\n\n</details>');
    expect([r.start, r.end]).toEqual([19, 26]);
  });
});
