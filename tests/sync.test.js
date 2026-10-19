import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenDrive, OpenDriveError, odSync, maskedSettings, saveSyncSettings, redactUsername } from '../src/sync.js';

/**
 * In-memory mock of the OpenDrive REST API (endpoints verified against
 * rclone's production opendrive backend).
 */
function createMock() {
  const s = {
    logins: 0,
    expireNext: 0, // number of upcoming API calls that should 401
    nextId: 1,
    folders: { '0': { name: '', parent: null, folders: new Map(), files: new Map() } }, // id -> {name,parent,folders:Map(name->id),files:Map(name->fileId)}
    files: new Map(), // fileId -> {name, folderId, content:Buffer, mtime (sec), size}
    uploads: new Map(), // tempLocation -> {fileId, size, chunks: Map(offset->Buffer)}
    calls: [],
    openCalls: 0, // open_file_upload.json hits (should be 0 when create returns TempLocation)
    chunkCalls: 0, // upload_file_chunk2.json hits
    closeCalls: [], // {file_time, file_hash} per close
    requireHashOnlyFor: new Set(), // filenames for which create returns RequireHashOnly: 1
    loginMode: 'ok', // 'ok' | 'verify' | 'captcha'
    throttleNext: 0, // upcoming folder-list calls that return 429
  };
  const fid = () => 'f' + (s.nextId++);
  const fileId = () => 'file' + (s.nextId++);

  function checkSession(sid) {
    if (s.expireNext > 0) { s.expireNext--; return false; }
    return sid === 'sess-1';
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const json = async () => req.json().catch(() => ({}));
      const ok = (obj) => Response.json(obj);
      const err = (code, message) => Response.json({ error: { code, message } });
      s.calls.push(`${req.method} ${p}`);

      if (p === '/api/v1/session/login.json' && req.method === 'POST') {
        const b = await json();
        s.logins++;
        if (b.username === 'user' && b.passwd === 'pass') {
          if (s.loginMode === 'verify') return ok({ SessionID: 'sess-1', UserName: 'user', RequiresVerification: 1 });
          return ok({ SessionID: 'sess-1', UserName: 'user' });
        }
        if (s.loginMode === 'captcha') return Response.json({ error: { code: 401, message: 'Invalid username or password' }, captcha_key: 'ck-1' }, { status: 401 });
        return err(401, 'Invalid username or password');
      }

      if (p === '/api/v1/folder.json' && req.method === 'POST') {
        const b = await json();
        if (!checkSession(b.session_id)) return new Response('unauthorized', { status: 401 });
        const id = fid();
        s.folders[id] = { name: b.folder_name, parent: b.folder_sub_parent, folders: new Map(), files: new Map() };
        s.folders[b.folder_sub_parent].folders.set(b.folder_name.toLowerCase(), id);
        return ok({ FolderID: id, Name: b.folder_name });
      }

      let m = p.match(/^\/api\/v1\/folder\/list\.json\/([^/]+)\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (s.throttleNext > 0) { s.throttleNext--; return new Response('slow down', { status: 429 }); }
        if (!checkSession(m[1])) return new Response('unauthorized', { status: 401 });
        const f = s.folders[m[2]];
        if (!f) return err(404, 'Folder not found');
        const Folders = [...f.folders.entries()].map(([name, id]) => ({
          FolderID: id, Name: s.folders[id].name, DateModified: Math.floor(Date.now() / 1000),
        }));
        const Files = [...f.files.values()].map(({ id, name }) => {
          const fl = s.files.get(id);
          return { FileId: id, FileHash: 'md5-' + id, Name: name, Size: String(fl.size), DateModified: String(fl.mtime) };
        });
        return ok({ Name: f.name, Folders, Files });
      }

      if (p === '/api/v1/upload/create_file.json' && req.method === 'POST') {
        const b = await json();
        if (!checkSession(b.session_id)) return new Response('unauthorized', { status: 401 });
        const key = b.file_name.toLowerCase();
        const existing = s.folders[b.folder_id].files.get(key);
        // 409 on name conflict unless open_if_exists=1 (verified API behavior)
        if (existing && b.open_if_exists !== 1) return err(409, 'File already exists');
        let id, tmp;
        if (existing) {
          id = existing.id; // open_if_exists=1 → overwrite in place
        } else {
          id = fileId();
          s.files.set(id, { name: b.file_name, folderId: b.folder_id, content: Buffer.alloc(0), mtime: Math.floor(Date.now() / 1000), size: 0 });
          s.folders[b.folder_id].files.set(key, { id, name: b.file_name });
        }
        tmp = 'tmp' + (s.nextId++);
        s.uploads.set(tmp, { fileId: id, size: 0, chunks: new Map() });
        // test hook: pretend the bytes are already server-side
        const hashOnly = s.requireHashOnlyFor.has(b.file_name) ? 1 : 0;
        return ok({ FileId: id, Name: b.file_name, TempLocation: tmp, RequireHashOnly: hashOnly });
      }

      if (p === '/api/v1/upload/open_file_upload.json' && req.method === 'POST') {
        const b = await json();
        if (!checkSession(b.session_id)) return new Response('unauthorized', { status: 401 });
        s.openCalls++;
        const tmp = 'tmp' + (s.nextId++);
        s.uploads.set(tmp, { fileId: b.file_id, size: b.file_size, chunks: new Map() });
        return ok({ TempLocation: tmp });
      }

      // v2 chunk endpoint: session/file in path, offsets in query, multipart carries only file_data
      m = p.match(/^\/api\/v1\/upload\/upload_file_chunk2\.json\/([^/]+)\/([^/]+)$/);
      if (m && req.method === 'POST') {
        if (!checkSession(m[1])) return new Response('unauthorized', { status: 401 });
        const fd = await req.formData();
        const up = s.uploads.get(url.searchParams.get('temp_location'));
        if (!up || up.fileId !== m[2]) return err(400, 'unknown temp location');
        const chunk = Buffer.from(await fd.get('file_data').arrayBuffer());
        up.chunks.set(Number(url.searchParams.get('chunk_offset')), chunk);
        s.chunkCalls++;
        return ok({ TotalWritten: chunk.length });
      }

      if (p === '/api/v1/upload/close_file_upload.json' && req.method === 'POST') {
        const b = await json();
        if (!checkSession(b.session_id)) return new Response('unauthorized', { status: 401 });
        const up = s.uploads.get(b.temp_location);
        if (!up) return err(400, 'unknown temp location');
        const parts = [...up.chunks.entries()].sort((a, b2) => a[0] - b2[0]).map(([, c]) => c);
        const fl = s.files.get(up.fileId);
        if (parts.length) { fl.content = Buffer.concat(parts); fl.size = fl.content.length; }
        // file_time in close sets the mtime atomically (verified API param)
        if (b.file_time) fl.mtime = Number(b.file_time);
        s.uploads.delete(b.temp_location);
        s.closeCalls.push({ file_time: b.file_time || null, file_hash: b.file_hash || null });
        return ok({ FileID: up.fileId, FileHash: 'md5-' + up.fileId, Size: fl.size });
      }

      if (p === '/api/v1/file/filesettings.json' && req.method === 'PUT') {
        const b = await json();
        if (!checkSession(b.session_id)) return new Response('unauthorized', { status: 401 });
        const fl = s.files.get(b.file_id);
        if (fl) fl.mtime = Number(b.file_modification_time);
        return ok({});
      }

      m = p.match(/^\/api\/v1\/download\/file\.json\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (!checkSession(url.searchParams.get('session_id') || '')) return new Response('unauthorized', { status: 401 });
        const fl = s.files.get(m[1]);
        if (!fl) return err(404, 'File not found');
        return new Response(fl.content, { headers: { 'Content-Type': 'application/octet-stream' } });
      }

      return new Response('mock: not implemented: ' + p, { status: 404 });
    },
  });

  // helper: find file entry by name (case-insensitive)
  s.findFile = (folderId, name) => {
    const e = s.folders[folderId].files.get(name.toLowerCase());
    return e ? { id: e.id, ...s.files.get(e.id) } : null;
  };
  s.port = server.port;
  s.stop = () => server.stop();
  return s;
}

let vault, data, mock;
beforeEach(() => {
  mock?.stop?.();
  if (vault) rmSync(vault, { recursive: true, force: true });
  if (data) rmSync(data, { recursive: true, force: true });
  vault = mkdtempSync(join(tmpdir(), 'folio-vault-'));
  data = mkdtempSync(join(tmpdir(), 'folio-data-'));
  mock = createMock();
});

const settings = () => ({
  username: 'user', password: 'pass',
  remoteFolder: '/Folio', dataDir: data,
  apiBase: `http://127.0.0.1:${mock.port}/api/v1`,
});

function writeLocal(rel, content) {
  const abs = join(vault, rel);
  mkdirSync(join(vault, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''), { recursive: true });
  writeFileSync(abs, content);
}

describe('OpenDrive login', () => {
  test('bad credentials → honest failure', async () => {
    const r = await odSync(vault, { ...settings(), password: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/login failed/i);
  });

  test('missing credentials → not configured', async () => {
    const r = await odSync(vault, { ...settings(), username: '', password: '' });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/not configured/i);
  });
});

describe('odSync', () => {
  test('uploads new local files; second run is a no-op', async () => {
    writeLocal('a.md', '# hello');
    writeLocal('sub/b.txt', 'text');
    // pdf binary-safe
    writeLocal('doc.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));

    const r1 = await odSync(vault, settings());
    expect(r1.ok).toBe(true);
    expect(r1.up).toBe(3);
    expect(r1.down).toBe(0);

    const r2 = await odSync(vault, settings());
    expect(r2.ok).toBe(true);
    expect(r2.up).toBe(0);
    expect(r2.down).toBe(0);
    expect(r2.conflicts).toEqual([]);
  });

  test('downloads new remote files', async () => {
    writeLocal('a.md', 'local');
    await odSync(vault, settings());
    // add a file directly on "remote"
    const folderId = 'f1'; // /Folio created first → f1
    const id = 'fileX';
    mock.files.set(id, { name: 'remote.md', folderId, content: Buffer.from('from cloud'), mtime: Math.floor(Date.now() / 1000), size: 10 });
    mock.folders[folderId].files.set('remote.md', { id, name: 'remote.md' });

    const r = await odSync(vault, settings());
    expect(r.down).toBe(1);
    expect(r.downloaded).toEqual(['remote.md']);
    expect(readFileSync(join(vault, 'remote.md'), 'utf8')).toBe('from cloud');
  });

  test('conflict: both changed → keep both, remote saved with (conflict) suffix', async () => {
    writeLocal('a.md', 'v1');
    await odSync(vault, settings());
    // change both sides
    writeLocal('a.md', 'local v2');
    const folderId = 'f1';
    const entry = mock.findFile(folderId, 'a.md');
    const fl = mock.files.get(entry.id);
    fl.content = Buffer.from('remote v2');
    fl.mtime = Math.floor(Date.now() / 1000) + 100;
    fl.size = fl.content.length;

    const r = await odSync(vault, settings());
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0].copy).toBe('a (conflict).md');
    // originals intact
    expect(readFileSync(join(vault, 'a.md'), 'utf8')).toBe('local v2');
    expect(readFileSync(join(vault, 'a (conflict).md'), 'utf8')).toBe('remote v2');

    // next run: conflict copy uploads as new, original stable
    const r2 = await odSync(vault, settings());
    expect(r2.up).toBe(1);
    expect(r2.downloaded).toEqual([]);
    expect(r2.conflicts).toEqual([]);
  });

  test('session expiry → transparent re-login', async () => {
    writeLocal('a.md', 'x');
    mock.expireNext = 2; // first two API calls 401
    const loginsBefore = mock.logins;
    const r = await odSync(vault, settings());
    expect(r.ok).toBe(true);
    expect(r.up).toBe(1);
    expect(mock.logins).toBeGreaterThan(loginsBefore);
  });

  test('remote folder created when missing (nested)', async () => {
    writeLocal('a.md', 'x');
    const r = await odSync(vault, { ...settings(), remoteFolder: '/Folio/Deep/Nest' });
    expect(r.ok).toBe(true);
    expect(r.up).toBe(1);
  });

  test('deletes are NOT propagated', async () => {
    writeLocal('a.md', 'x');
    writeLocal('b.md', 'y');
    await odSync(vault, settings());
    // delete locally → next sync must not resurrect or re-upload
    rmSync(join(vault, 'b.md'));
    const r = await odSync(vault, settings());
    expect(r.up).toBe(0);
    expect(r.down).toBe(0);
    expect(readFileSync(join(vault, 'a.md'), 'utf8')).toBe('x');
    // remote still has b.md (untouched)
    expect(mock.findFile('f1', 'b.md')).toBeTruthy();
  });

  test('remote delete does not cause re-upload', async () => {
    writeLocal('a.md', 'x');
    await odSync(vault, settings());
    // delete on remote side
    const folderId = 'f1';
    const entry = mock.findFile(folderId, 'a.md');
    mock.files.delete(entry.id);
    mock.folders[folderId].files.delete('a.md');
    const r = await odSync(vault, settings());
    expect(r.up).toBe(0);
    expect(r.downloaded).toEqual([]);
  });

  test('local change re-uploads over existing remote name (open_if_exists, no 409)', async () => {
    writeLocal('a.md', 'v1');
    const r1 = await odSync(vault, settings());
    expect(r1.ok).toBe(true);
    const before = mock.findFile('f1', 'a.md');
    writeLocal('a.md', 'v2 with more content');
    const r2 = await odSync(vault, settings());
    expect(r2.ok).toBe(true);
    expect(r2.up).toBe(1);
    expect(r2.errors).toEqual([]);
    // overwritten in place: same remote id, new content
    const after = mock.findFile('f1', 'a.md');
    expect(after.id).toBe(before.id);
    expect(after.content.toString()).toBe('v2 with more content');
    // third run is a no-op again
    const r3 = await odSync(vault, settings());
    expect(r3.up).toBe(0);
    expect(r3.down).toBe(0);
  });

  test('create_file TempLocation is used; open_file_upload skipped; close sends file_time', async () => {
    writeLocal('a.md', 'x');
    const r = await odSync(vault, settings());
    expect(r.ok).toBe(true);
    expect(mock.openCalls).toBe(0);
    expect(mock.chunkCalls).toBe(1); // v2 chunk endpoint
    expect(mock.closeCalls.length).toBe(1);
    expect(mock.closeCalls[0].file_time).toBeTruthy();
  });

  test('RequireHashOnly=1 skips chunk upload entirely', async () => {
    mock.requireHashOnlyFor.add('skip.md');
    writeLocal('skip.md', 'already there');
    writeLocal('normal.md', 'fresh');
    const chunksBefore = mock.chunkCalls;
    const r = await odSync(vault, settings());
    expect(r.ok).toBe(true);
    expect(r.up).toBe(2);
    // only normal.md produced chunk calls
    expect(mock.chunkCalls).toBe(chunksBefore + 1);
    expect(mock.closeCalls.length).toBe(2);
  });

  test('2FA pending verification surfaces honestly', async () => {
    mock.loginMode = 'verify';
    writeLocal('a.md', 'x');
    const r = await odSync(vault, settings());
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/2FA|verification/i);
  });

  test('captcha challenge surfaces honestly', async () => {
    mock.loginMode = 'captcha';
    const r = await odSync(vault, { ...settings(), password: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/captcha/i);
  });

  test('429 rate limit backs off without re-login', async () => {
    writeLocal('a.md', 'x');
    mock.throttleNext = 1; // first folder-list call gets 429
    const loginsBefore = mock.logins;
    const r = await odSync(vault, settings());
    expect(r.ok).toBe(true);
    expect(r.up).toBe(1);
    expect(mock.logins).toBe(loginsBefore + 1); // exactly one login (the initial); no re-login on 429
  });
});

describe('settings masking', () => {
  test('password never appears in masked settings', () => {
    saveSyncSettings(data, { username: 'user@example.com', password: 's3cret', remoteFolder: '/Folio' });
    const m = maskedSettings(data);
    expect(m.configured).toBe(true);
    expect(m.username).toBe('u…@example.com');
    expect(JSON.stringify(m)).not.toContain('s3cret');
    expect(JSON.stringify(m)).not.toContain('password');
  });

  test('redactUsername', () => {
    expect(redactUsername('user@example.com')).toBe('u…@example.com');
  });
});

describe('OpenDrive client', () => {
  test('ensureFolderPath is idempotent', async () => {
    const od = new OpenDrive({ apiBase: `http://127.0.0.1:${mock.port}/api/v1` });
    await od.login('user', 'pass');
    const a = await od.ensureFolderPath('/Folio');
    const b = await od.ensureFolderPath('/Folio');
    expect(a).toBe(b);
  });

  test('wrong password throws OpenDriveError', async () => {
    const od = new OpenDrive({ apiBase: `http://127.0.0.1:${mock.port}/api/v1` });
    await expect(od.login('user', 'nope')).rejects.toBeInstanceOf(OpenDriveError);
  });
});
