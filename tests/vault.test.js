import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveVaultPath, validName, folderTree, listNotes, readNote,
  writeNote, makeFolder, renameEntry, moveEntry, deleteEntry, VaultError,
} from '../src/vault.js';

let root;
beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'folio-vault-'));
});

describe('resolveVaultPath', () => {
  test('traversal rejected', () => {
    for (const bad of ['../x', 'a/../../etc/passwd', '..', '/abs/path', 'C:\\win']) {
      expect(() => resolveVaultPath(root, bad)).toThrow(VaultError);
    }
  });
  test('normal paths resolve inside', () => {
    const p = resolveVaultPath(root, 'a/b.md');
    expect(p.startsWith(root)).toBe(true);
  });
});

describe('validName', () => {
  test('rejects bad names', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x:y', 'x*y', 'x?y']) {
      expect(validName(bad)).toBe(false);
    }
    expect(validName('notes 2024.md')).toBe(true);
  });
});

describe('vault CRUD', () => {
  test('write/read/list round-trip', () => {
    writeNote(root, 'a.md', '# hi');
    writeNote(root, 'sub/b.txt', 'plain');
    expect(readNote(root, 'a.md')).toBe('# hi');
    expect(listNotes(root, '').map((n) => n.name)).toEqual(['a.md']);
    expect(listNotes(root, 'sub').map((n) => n.name)).toEqual(['b.txt']);
  });

  test('write rejects non-text extensions and bad names', () => {
    expect(() => writeNote(root, 'x.pdf', 'no')).toThrow(VaultError);
    expect(() => writeNote(root, '../evil.md', 'no')).toThrow(VaultError);
  });

  test('makeFolder + folderTree nesting', () => {
    makeFolder(root, 'a/b/c');
    const t = folderTree(root);
    expect(t[0].name).toBe('a');
    expect(t[0].children[0].children[0].name).toBe('c');
  });

  test('rename entry + conflict', () => {
    writeNote(root, 'a.md', '1');
    writeNote(root, 'b.md', '2');
    expect(() => renameEntry(root, 'a.md', 'b.md')).toThrow(VaultError);
    const r = renameEntry(root, 'a.md', 'c.md');
    expect(r.path).toBe('c.md');
    expect(readNote(root, 'c.md')).toBe('1');
  });

  test('move note into folder', () => {
    writeNote(root, 'a.md', '1');
    makeFolder(root, 'f');
    const r = moveEntry(root, 'a.md', 'f');
    expect(r.path).toBe('f/a.md');
    expect(listNotes(root, '').length).toBe(0);
  });

  test('cannot move folder into itself or descendant', () => {
    makeFolder(root, 'a/b');
    expect(() => moveEntry(root, 'a', 'a/b')).toThrow(VaultError);
    expect(() => moveEntry(root, 'a', 'a')).toThrow(VaultError);
  });

  test('delete recursive', () => {
    writeNote(root, 'a/b.md', '1');
    deleteEntry(root, 'a');
    expect(listNotes(root, '').length).toBe(0);
    expect(() => deleteEntry(root, 'nope.md')).toThrow(VaultError);
  });

  test('pdf listed but not readable as text', () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(root, 'd.pdf'), Buffer.from('%PDF'));
    expect(listNotes(root, '').map((n) => n.name)).toEqual(['d.pdf']);
    expect(() => readNote(root, 'd.pdf')).toThrow(VaultError);
  });
});
