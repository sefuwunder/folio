// tests/vault-switch.test.js — vault path validation, settings persistence,
// dialog picker (mocked), traversal protection after a vault switch.
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateVaultPath, pickVaultDirectory, resolveVaultPath, VaultError,
} from '../src/vault.js';
import { getAppSetting, setAppSetting, loadAppSettings } from '../src/settings.js';

let dir;
beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'folio-vswitch-'));
});

describe('validateVaultPath', () => {
  test('rejects empty / missing / relative / root', () => {
    expect(() => validateVaultPath('')).toThrow(VaultError);
    expect(() => validateVaultPath(null)).toThrow(VaultError);
    expect(() => validateVaultPath(join(dir, 'nope'))).toThrow(VaultError);
    expect(() => validateVaultPath('relative/path')).toThrow(VaultError);
    expect(() => validateVaultPath('/')).toThrow(VaultError);
  });
  test('rejects a file that is not a directory', () => {
    const f = join(dir, 'note.md');
    writeFileSync(f, 'x');
    expect(() => validateVaultPath(f)).toThrow(VaultError);
  });
  test('rejects non-writable directories', () => {
    if (process.getuid && process.getuid() === 0) return; // root bypasses perms
    const sub = join(dir, 'locked');
    mkdirSync(sub);
    chmodSync(sub, 0o555);
    expect(() => validateVaultPath(sub)).toThrow(VaultError);
    chmodSync(sub, 0o755);
  });
  test('accepts a good directory, normalized', () => {
    const sub = join(dir, 'vault') + '/';
    mkdirSync(sub, { recursive: true });
    expect(validateVaultPath(sub)).toBe(join(dir, 'vault'));
  });
});

describe('app settings', () => {
  test('set/get round-trip, persisted as JSON', () => {
    const data = mkdtempSync(join(tmpdir(), 'folio-settings-'));
    setAppSetting(data, 'vault_path', '/tmp/vault-x');
    expect(getAppSetting(data, 'vault_path')).toBe('/tmp/vault-x');
    expect(loadAppSettings(data).vault_path).toBe('/tmp/vault-x');
    const raw = JSON.parse(readFileSync(join(data, 'app-settings.json'), 'utf8'));
    expect(raw.vault_path).toBe('/tmp/vault-x');
    rmSync(data, { recursive: true, force: true });
  });
  test('missing file → undefined', () => {
    const data = mkdtempSync(join(tmpdir(), 'folio-settings-'));
    expect(getAppSetting(data, 'vault_path')).toBeUndefined();
    rmSync(data, { recursive: true, force: true });
  });
});

describe('pickVaultDirectory (mocked runner)', () => {
  test('zenity success returns the path', async () => {
    const calls = [];
    const run = async (cmd, args) => { calls.push(cmd); return { code: 0, stdout: '/home/u/notes\n', timedOut: false }; };
    const r = await pickVaultDirectory({ run });
    expect(r).toEqual({ path: '/home/u/notes' });
    expect(calls).toEqual(['zenity']);
  });
  test('user cancel stops before kdialog', async () => {
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { code: 1, stdout: '', timedOut: false }; };
    const r = await pickVaultDirectory({ run });
    expect(r.cancelled).toBe(true);
    expect(calls).toEqual(['zenity']);
  });
  test('timeout → cancelled with timedOut flag', async () => {
    const run = async () => ({ code: null, stdout: '', timedOut: true });
    const r = await pickVaultDirectory({ run });
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(true);
  });
  test('zenity missing → falls back to kdialog', async () => {
    const calls = [];
    const run = async (cmd) => {
      calls.push(cmd);
      if (cmd === 'zenity') { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }
      return { code: 0, stdout: '/home/u/kde\n', timedOut: false };
    };
    const r = await pickVaultDirectory({ run });
    expect(r).toEqual({ path: '/home/u/kde' });
    expect(calls).toEqual(['zenity', 'kdialog']);
  });
  test('no dialog tools → available:false', async () => {
    const run = async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
    const r = await pickVaultDirectory({ run });
    expect(r).toEqual({ available: false });
  });
  test('broken tool (display failure) → tries next, then available:false', async () => {
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { code: 255, stdout: '', timedOut: false }; };
    const r = await pickVaultDirectory({ run });
    expect(r).toEqual({ available: false });
    expect(calls).toEqual(['zenity', 'kdialog']);
  });
});

describe('traversal protection survives a vault switch', () => {
  test('resolveVaultPath still jails relative paths under the new root', () => {
    const newRoot = validateVaultPath(dir);
    for (const bad of ['../x', 'a/../../etc/passwd', '..', '/abs', 'C:\\win']) {
      expect(() => resolveVaultPath(newRoot, bad)).toThrow(VaultError);
    }
    expect(resolveVaultPath(newRoot, 'a/b.md')).toBe(join(newRoot, 'a/b.md'));
  });
});
