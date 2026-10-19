// tests/vault-api.test.js — vault switch endpoints against a live server.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 18039;
const BASE = `http://127.0.0.1:${PORT}`;
let vaultA, vaultB, data, proc;

const ENV = {
  ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
  OPENDRIVE_API_BASE: 'http://127.0.0.1:1/api/v1',
};

async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for server');
}

function spawn(extraEnv = {}) {
  return Bun.spawn(['bun', 'src/server.ts'], {
    cwd: '/home/hatch/workspace/your_files/folio',
    env: { ...ENV, FOLIO_VAULT: vaultA, FOLIO_DATA: data, ...extraEnv },
    stdout: 'ignore', stderr: 'ignore',
  });
}

const j = async (p, opts) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

beforeAll(async () => {
  vaultA = mkdtempSync(join(tmpdir(), 'folio-va-'));
  vaultB = mkdtempSync(join(tmpdir(), 'folio-vb-'));
  data = mkdtempSync(join(tmpdir(), 'folio-vdata-'));
  writeFileSync(join(vaultA, 'a.md'), '# A');
  writeFileSync(join(vaultB, 'b.md'), '# B');
  proc = spawn();
  await waitFor(async () => (await fetch(`${BASE}/api/vault/info`)).ok);
});

afterAll(() => {
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  for (const d of [vaultA, vaultB, data]) rmSync(d, { recursive: true, force: true });
});

describe('vault location API', () => {
  test('info reports the env vault', async () => {
    const r = await j('/api/vault/info');
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(vaultA);
    expect(r.body.source).toBe('env');
  });
  test('switch to another vault: tree + notes reflect it', async () => {
    let r = await j('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: vaultB }) });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(vaultB);
    r = await j('/api/vault/info');
    expect(r.body.path).toBe(vaultB);
    expect(r.body.source).toBe('settings');
    r = await j('/api/notes?recursive=1');
    expect(r.body.notes.map((n) => n.name)).toEqual(['b.md']);
  });
  test('traversal still rejected after switch', async () => {
    const r = await j('/api/file?path=../../etc/passwd');
    expect(r.status).toBe(403);
  });
  test('invalid paths rejected', async () => {
    let r = await j('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: join(vaultB, 'b.md') }) });
    expect(r.status).toBe(400);
    r = await j('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: join(vaultB, 'nope') }) });
    expect(r.status).toBe(400);
    r = await j('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: 'relative' }) });
    expect(r.status).toBe(400);
    // vault unchanged
    r = await j('/api/vault/info');
    expect(r.body.path).toBe(vaultB);
  });
  test('switch back to the original vault', async () => {
    let r = await j('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: vaultA }) });
    expect(r.status).toBe(200);
    r = await j('/api/notes?recursive=1');
    expect(r.body.notes.map((n) => n.name)).toEqual(['a.md']);
  });
  test('persisted vault survives a server restart', async () => {
    // current vault is vaultA (settings); restart must restore it from disk
    const saved = JSON.parse(readFileSync(join(data, 'app-settings.json'), 'utf8'));
    expect(saved.vault_path).toBe(vaultA);
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => setTimeout(r, 400));
    proc = spawn();
    await waitFor(async () => (await fetch(`${BASE}/api/vault/info`)).ok);
    const r = await j('/api/vault/info');
    expect(r.body.path).toBe(vaultA);
    expect(r.body.source).toBe('settings');
  });
  test('browse without dialog tools → available:false', async () => {
    for (const bin of ['zenity', 'kdialog']) {
      const w = Bun.spawnSync(['which', bin], { stdout: 'ignore', stderr: 'ignore' });
      if (w.exitCode === 0) return; // real dialog present — can't test headless
    }
    const r = await j('/api/vault/browse', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
  });
});

describe('scoped recursive notes (folder depth)', () => {
  // seed a 3-level tree into vaultA (current vault after prior tests — re-assert it)
  test('setup nested tree', async () => {
    await j('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: vaultA }) });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(vaultA, 'Projects', '2026', 'Q1'), { recursive: true });
    writeFileSync(join(vaultA, 'Projects', 'a.md'), '# a');
    writeFileSync(join(vaultA, 'Projects', '2026', 'b.md'), '# b');
    writeFileSync(join(vaultA, 'Projects', '2026', 'Q1', 'c.md'), '# c');
    expect(true).toBe(true);
  });
  test('folder=Projects&recursive=1 returns the whole subtree', async () => {
    const r = await j('/api/notes?folder=Projects&recursive=1&snippet=1');
    expect(r.status).toBe(200);
    const paths = r.body.notes.map((n) => n.path).sort();
    expect(paths).toEqual(['Projects/2026/Q1/c.md', 'Projects/2026/b.md', 'Projects/a.md']);
  });
  test('folder=Projects/2026 scopes to that subtree only', async () => {
    const r = await j('/api/notes?folder=Projects%2F2026&recursive=1');
    expect(r.status).toBe(200);
    const paths = r.body.notes.map((n) => n.path).sort();
    expect(paths).toEqual(['Projects/2026/Q1/c.md', 'Projects/2026/b.md']);
  });
  test('recursive=1 with no folder = whole vault (All Notes unchanged)', async () => {
    const r = await j('/api/notes?recursive=1');
    expect(r.status).toBe(200);
    const names = r.body.notes.map((n) => n.name);
    expect(names).toContain('a.md');
    expect(names).toContain('c.md');
    expect(names).toContain('a.md'); // root seed file from beforeAll still there
  });
  test('unknown folder → error, never a full-vault dump', async () => {
    const r = await j('/api/notes?folder=Nope&recursive=1');
    expect(r.status).not.toBe(200);
    expect(r.body.error).toBeTruthy();
  });
  test('traversal rejected', async () => {
    const r = await j('/api/notes?folder=' + encodeURIComponent('..') + '&recursive=1');
    expect(r.status).toBe(403);
  });
  test('non-recursive folder listing unchanged (direct children only)', async () => {
    const r = await j('/api/notes?folder=Projects');
    expect(r.status).toBe(200);
    expect(r.body.notes.map((n) => n.path)).toEqual(['Projects/a.md']);
  });
});
