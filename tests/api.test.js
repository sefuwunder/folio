// tests/api.test.js — integration against a live server on a temp vault.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = 18038;
const BASE = `http://127.0.0.1:${PORT}`;
let vault, data, proc;

async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for server');
}

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'folio-api-vault-'));
  data = mkdtempSync(join(tmpdir(), 'folio-api-data-'));
  writeFileSync(join(vault, 'hello.md'), '# Hello\nworld');
  proc = Bun.spawn(['bun', 'src/server.ts'], {
    cwd: '/home/hatch/workspace/your_files/folio',
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      FOLIO_VAULT: vault, FOLIO_DATA: data,
      // point the OpenDrive client at a dead port: fast connection-refused
      // instead of hanging on the real internet (no tunnel in this sandbox)
      OPENDRIVE_API_BASE: 'http://127.0.0.1:1/api/v1',
    },
    stdout: 'ignore', stderr: 'ignore',
  });
  await waitFor(async () => (await fetch(`${BASE}/api/tree`)).ok);
});

afterAll(() => {
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  rmSync(vault, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const j = async (p, opts) => {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

describe('vault API', () => {
  test('tree + notes + file round-trip', async () => {
    let r = await j('/api/tree');
    expect(r.status).toBe(200);
    r = await j('/api/notes?recursive=1&snippet=1');
    expect(r.body.notes.map((n) => n.name)).toContain('hello.md');
    expect(r.body.notes[0].snippet).toContain('Hello');
    r = await j('/api/file?path=hello.md');
    expect(r.body.content).toContain('# Hello');
    r = await j('/api/file', { method: 'POST', body: JSON.stringify({ path: 'sub/n.txt', content: 'abc' }) });
    expect(r.status).toBe(201);
    r = await j('/api/file?path=sub/n.txt');
    expect(r.body.content).toBe('abc');
    r = await j('/api/rename', { method: 'POST', body: JSON.stringify({ path: 'sub/n.txt', name: 'm.txt' }) });
    expect(r.body.path).toBe('sub/m.txt');
    r = await j('/api/delete', { method: 'POST', body: JSON.stringify({ path: 'sub/m.txt' }) });
    expect(r.body.deleted).toBe('sub/m.txt');
  });

  test('traversal attack rejected', async () => {
    for (const p of ['../x', 'a/../../etc/passwd', '..%2f..%2fx']) {
      const r = await j(`/api/file?path=${p}`);
      expect([400, 403, 404]).toContain(r.status);
      expect(r.body.error || r.body.content === undefined).toBeTruthy();
    }
    // raw binary path too
    const r = await fetch(`${BASE}/raw/${encodeURIComponent('../../etc/hostname')}`);
    expect([400, 403, 404]).toContain(r.status);
  });

  test('search finds content', async () => {
    const r = await j('/api/search?q=world');
    expect(r.body.results.length).toBe(1);
    expect(r.body.results[0].path).toBe('hello.md');
  });

  test('pdf served as binary with right content-type', async () => {
    writeFileSync(join(vault, 'd.pdf'), Buffer.from('%PDF-1.4 test'));
    const r = await fetch(`${BASE}/raw/d.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(await r.text()).toContain('%PDF');
  });
});

describe('sync API', () => {
  test('status honest when not configured', async () => {
    const r = await j('/api/sync/status');
    expect(r.body.backend).toBe('opendrive');
    expect(r.body.available).toBe(false);
    expect(r.body.reason).toMatch(/not configured/i);
    expect(r.body.lastRun).toBeNull();
  });

  test('settings masked: password never returned', async () => {
    let r = await j('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ username: 'user@example.com', password: 's3cret!', remoteFolder: '/Folio' }),
    });
    expect(r.body.opendrive.configured).toBe(true);
    expect(r.body.opendrive.username).toBe('u…@example.com');
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('s3cret');
    r = await j('/api/settings');
    expect(JSON.stringify(r.body)).not.toContain('s3cret');
    expect(r.body.opendrive.configured).toBe(true);
  });

  test('sync run without reachable API fails honestly', async () => {
    const r = await j('/api/sync/run', { method: 'POST', body: JSON.stringify({}) });
    expect(r.body.result.ok).toBe(false);
    expect(r.body.result.note).toMatch(/login failed/i);
    // lastRun persisted
    const s = await j('/api/sync/status');
    expect(s.body.lastRun).toBeTruthy();
    expect(s.body.lastRun.ok).toBe(false);
  });

  test('test connection fails honestly with bad creds', async () => {
    const r = await j('/api/sync/test', { method: 'POST', body: JSON.stringify({}) });
    expect(r.body.ok).toBe(false);
  });

  test('disconnect clears credentials', async () => {
    await j('/api/settings/disconnect', { method: 'POST', body: JSON.stringify({}) });
    const r = await j('/api/settings');
    expect(r.body.opendrive.configured).toBe(false);
  });
});
