// tests/vault-recursive.test.js — listNotesRecursive: subtree walks, 3 levels,
// unknown-folder handling, traversal rejection, mtime ordering.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listNotesRecursive, VaultError } from '../src/vault.js';

let root;
const T0 = Date.now() - 100000;

function note(rel, ageMs) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '# ' + rel);
  const t = new Date(T0 - ageMs);
  utimesSync(abs, t, t);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'folio-vr-'));
  // 3-level tree, notes at every level; older = smaller ageMs is newer
  note('root.md', 100);                 // newest
  note('Projects/a.md', 200);
  note('Projects/2026/b.md', 300);
  note('Projects/2026/Q1/c.md', 400);   // oldest
  note('Other/d.md', 250);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('listNotesRecursive', () => {
  test('whole vault: all 5 notes, newest first', () => {
    const ns = listNotesRecursive(root, '');
    expect(ns.map((n) => n.path)).toEqual([
      'root.md', 'Projects/a.md', 'Other/d.md', 'Projects/2026/b.md', 'Projects/2026/Q1/c.md',
    ]);
  });

  test('subtree Projects: 3 notes with full relative paths', () => {
    const ns = listNotesRecursive(root, 'Projects');
    expect(ns.map((n) => n.path)).toEqual([
      'Projects/a.md', 'Projects/2026/b.md', 'Projects/2026/Q1/c.md',
    ]);
  });

  test('subtree Projects/2026 scopes correctly', () => {
    const ns = listNotesRecursive(root, 'Projects/2026');
    expect(ns.map((n) => n.path)).toEqual(['Projects/2026/b.md', 'Projects/2026/Q1/c.md']);
  });

  test('leaf folder returns only its own notes', () => {
    const ns = listNotesRecursive(root, 'Projects/2026/Q1');
    expect(ns.map((n) => n.path)).toEqual(['Projects/2026/Q1/c.md']);
  });

  test('empty subtree returns []', () => {
    mkdirSync(join(root, 'Empty', 'Deep'), { recursive: true });
    expect(listNotesRecursive(root, 'Empty')).toEqual([]);
  });

  test('unknown folder → VaultError(notfound)', () => {
    try {
      listNotesRecursive(root, 'Nope');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect(e.code).toBe('notfound');
    }
  });

  test('path to a file (not a folder) → notfound', () => {
    try {
      listNotesRecursive(root, 'root.md');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('notfound');
    }
  });

  test('traversal rejected', () => {
    for (const bad of ['..', '../..', 'Projects/../../../etc']) {
      try {
        listNotesRecursive(root, bad);
        throw new Error('should have thrown for ' + bad);
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        expect(e.code).toBe('traversal');
      }
    }
  });

  test('hidden folders are skipped', () => {
    note('.hidden/x.md', 50);
    expect(listNotesRecursive(root, '').some((n) => n.path.includes('.hidden'))).toBe(false);
  });
});
