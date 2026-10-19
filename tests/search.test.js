import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeNote } from '../src/vault.js';
import { searchVault } from '../src/search.js';

let root;
beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'folio-search-'));
  writeNote(root, 'meeting.md', '# Team meeting\nDiscussed the quarterly roadmap and budget.');
  writeNote(root, 'groceries.txt', 'milk eggs roadmap for dinner');
  writeNote(root, 'roadmap.md', '# Roadmap\nThe roadmap document lives here.');
});

describe('searchVault', () => {
  test('title matches rank above content matches', () => {
    const r = searchVault(root, 'roadmap');
    expect(r.length).toBe(3);
    expect(r[0].path).toBe('roadmap.md'); // title hit
  });

  test('content match found with snippet', () => {
    const r = searchVault(root, 'quarterly');
    expect(r.length).toBe(1);
    expect(r[0].path).toBe('meeting.md');
    expect(r[0].snippet.toLowerCase()).toContain('quarterly');
  });

  test('short queries return nothing', () => {
    expect(searchVault(root, 'x')).toEqual([]);
  });

  test('no match', () => {
    expect(searchVault(root, 'zyxwv')).toEqual([]);
  });

  test('multi-term', () => {
    const r = searchVault(root, 'team budget');
    expect(r[0].path).toBe('meeting.md');
  });
});
