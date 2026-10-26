import { describe, test, expect } from 'bun:test';
import { relatedNotes, parseTasks, groupToday, extractTags, buildTagGraph, layoutTagGraph } from '../src/mind.js';

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

describe('extractTags', () => {
  test('finds hashtags, lowercases, dedupes, sorts', () => {
    expect(extractTags('Meeting #Farm notes #tag and #farm again')).toEqual(['farm', 'tag']);
  });

  test('headings are not tags, but a hashtag inside a heading line is', () => {
    expect(extractTags('# Title\n## Section\n# Hello #farm')).toEqual(['farm']);
  });

  test('URL fragments, glued words, and ##tag are not tags', () => {
    expect(extractTags('see https://x.test/p#frag and word#tag and ##tag')).toEqual([]);
  });

  test('fenced code blocks and inline code spans are skipped', () => {
    expect(extractTags('```\n#code\n```\n`#inline` and #real')).toEqual(['real']);
  });

  test('bracketed and mid-line hashtags count', () => {
    expect(extractTags('see (#farm) and a word #tag-name_x here')).toEqual(['farm', 'tag-name_x']);
  });
});

describe('buildTagGraph', () => {
  const pool = [
    { path: 'b.md', name: 'b.md', body: 'soil #farm #soil', mtime: 2 },
    { path: 'a.md', name: 'a.md', body: 'seeds #farm', mtime: 1 },
    { path: 'c.md', name: 'c.md', body: 'no tags here', mtime: 3 },
  ];

  test('tags sorted, note lists sorted, untagged notes omitted', () => {
    const g = buildTagGraph(pool);
    expect(g.tags).toEqual([
      { name: 'farm', notes: ['a.md', 'b.md'] },
      { name: 'soil', notes: ['b.md'] },
    ]);
    expect(g.notes).toEqual([
      { path: 'a.md', name: 'a.md', tags: ['farm'] },
      { path: 'b.md', name: 'b.md', tags: ['farm', 'soil'] },
    ]);
  });
});

describe('layoutTagGraph', () => {
  const graph = buildTagGraph([
    { path: 'a.md', name: 'a.md', body: '#farm only', mtime: 1 },
    { path: 'b.md', name: 'b.md', body: '#farm #soil both', mtime: 2 },
    { path: 'c.md', name: 'c.md', body: '#soil only', mtime: 3 },
  ]);

  test('deterministic: same graph lays out identically', () => {
    expect(layoutTagGraph(graph)).toEqual(layoutTagGraph(graph));
  });

  test('single-tag notes ring clear of their tag node', () => {
    const laid = layoutTagGraph(graph);
    const farm = laid.tags.find((t) => t.name === 'farm');
    const a = laid.notes.find((n) => n.path === 'a.md');
    const d = Math.hypot(a.x - farm.x, a.y - farm.y);
    expect(d).toBeGreaterThan(60);
  });

  test('multi-tag note sits at its tags centroid', () => {
    const laid = layoutTagGraph(graph);
    const farm = laid.tags.find((t) => t.name === 'farm');
    const soil = laid.tags.find((t) => t.name === 'soil');
    const b = laid.notes.find((n) => n.path === 'b.md');
    expect(b.x).toBeCloseTo((farm.x + soil.x) / 2, 6);
    expect(b.y).toBeCloseTo((farm.y + soil.y) / 2, 6);
  });

  test('empty graph lays out empty', () => {
    expect(layoutTagGraph({ tags: [], notes: [] })).toEqual({ tags: [], notes: [] });
  });
});
