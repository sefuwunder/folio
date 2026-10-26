import { describe, test, expect } from 'bun:test';
import { relatedNotes, parseTasks, groupToday } from '../src/mind.js';

describe('relatedNotes', () => {
  const pool = [
    { path: 'a.md', name: 'a.md', body: 'garden tomato soil compost', mtime: 100 },
    { path: 'b.md', name: 'b.md', body: 'tomato sauce basil garden harvest', mtime: 200 },
    { path: 'c.md', name: 'c.md', body: 'quantum physics entanglement', mtime: 300 },
  ];

  test('needs 2+ shared keywords, excludes self, ranks overlap then recency', () => {
    const note = { path: 'n.md', name: 'n.md', body: 'my tomato garden soil plan', mtime: 400 };
    const rel = relatedNotes(note, pool);
    expect(rel.map((r) => r.path)).toEqual(['a.md', 'b.md']);
    expect(rel[0].score).toBe(3);
    expect(rel[1].score).toBe(2);
  });

  test('one shared keyword is not enough', () => {
    const note = { path: 'n.md', name: 'n.md', body: 'quantum cooking', mtime: 400 };
    expect(relatedNotes(note, pool)).toEqual([]);
  });

  test('folder words count as keywords', () => {
    const note = { path: 'Garden/plan.md', name: 'plan.md', body: 'soil seeds', mtime: 400 };
    const rel = relatedNotes(note, pool);
    expect(rel.map((r) => r.path)).toEqual(['a.md']);
  });

  test('limit and recency tie-break', () => {
    const big = [
      { path: 'x.md', name: 'x.md', body: 'apple banana cherry', mtime: 10 },
      { path: 'y.md', name: 'y.md', body: 'apple banana cherry', mtime: 20 },
      { path: 'z.md', name: 'z.md', body: 'apple banana cherry', mtime: 30 },
    ];
    const note = { path: 'n.md', name: 'n.md', body: 'apple banana', mtime: 40 };
    expect(relatedNotes(note, big, 2).map((r) => r.path)).toEqual(['z.md', 'y.md']);
  });
});

describe('parseTasks', () => {
  test('checked, unchecked, and fenced blocks skipped', () => {
    const body = '- [ ] open one\n- [x] done one\n```\n- [ ] not a task\n```\n* [X] done two';
    const tasks = parseTasks(body);
    expect(tasks).toEqual([
      { text: 'open one', done: false },
      { text: 'done one', done: true },
      { text: 'done two', done: true },
    ]);
  });

  test('text capped at 120 chars', () => {
    const tasks = parseTasks('- [ ] ' + 'a'.repeat(130));
    expect(tasks[0].text.length).toBe(120);
  });
});

describe('groupToday', () => {
  const NOW = 1_800_000_000_000;
  const pool = [
    { path: 'Work/a.md', name: 'a.md', body: '- [ ] one\n- [x] two\n- [ ] three', mtime: NOW },
    { path: 'Work/b.md', name: 'b.md', body: '- [x] all done', mtime: NOW - 1000 },
    { path: 'c.md', name: 'c.md', body: '- [x] old done', mtime: NOW - 8 * 864e5 },
    { path: 'd.md', name: 'd.md', body: 'no tasks here', mtime: NOW },
    { path: 'e.md', name: 'e.md', body: '- [ ] solo', mtime: NOW },
  ];

  test('groups open tasks by folder then file, wrapped-up is recent-only', () => {
    const { open, wrapped } = groupToday(pool, NOW);
    expect(open.map((g) => g.folder)).toEqual(['', 'Work']);
    expect(open[0].files.map((f) => f.path)).toEqual(['e.md']);
    expect(open[1].files).toEqual([{ path: 'Work/a.md', name: 'a.md', open: ['one', 'three'], done: 1, total: 3 }]);
    expect(wrapped).toEqual([{ path: 'Work/b.md', name: 'b.md', total: 1 }]);
  });
});
