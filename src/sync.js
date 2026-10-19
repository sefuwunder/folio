// src/sync.js — OpenDrive.com sync backend for Folio (server-side only).
//
// One backend, done well: the OpenDrive REST API
// (https://dev.opendrive.com/api/v1 — endpoints verified against rclone's
// production opendrive backend AND the official REST API Guide v1.2.0).
//
//   POST /session/login.json            {username, passwd} -> {SessionID,...}
//   POST /folder.json                   {session_id, folder_name, folder_sub_parent, ...} -> {FolderID}
//   GET  /folder/list.json/{sid}/{fid}  -> {Folders:[...], Files:[...]} (0=root)
//   POST /upload/create_file.json       {session_id, folder_id, file_name, open_if_exists}
//                                       -> {FileId, TempLocation, RequireHashOnly}
//   POST /upload/open_file_upload.json  {session_id, file_id, file_size} -> {TempLocation}
//   POST /upload/upload_file_chunk2.json/{sid}/{fid}?temp_location=&chunk_offset=&chunk_size=
//                                       multipart(file_data)
//   POST /upload/close_file_upload.json {session_id, file_id, file_size, temp_location, file_time}
//   PUT  /file/filesettings.json        {session_id, file_id, file_modification_time}
//   GET  /download/file.json/{fid}?session_id=
//
// Upload notes: create_file returns TempLocation directly (open_file_upload is
// a fallback); RequireHashOnly=1 means the bytes are already server-side, so
// chunks are skipped and we go straight to close; open_if_exists=1 avoids a
// 409 when re-uploading an existing name (overwrite). 423 = chunk in flight
// (wait + retry); 429 = rate limit (backoff, no re-login helps); 509 =
// bandwidth exceeded (surfaced, not retried).
// Deletion is intentionally absent: v1 never propagates deletes. (For
// reference: "delete" = POST /file/trash.json; permanent = DELETE
// /file.json/{sid}/{fid}; restore = POST /file/restore.json.)
//
// Sync model (manual "Sync now" only, v1):
//   - compare local vault files vs remote folder by relative path, sha256
//     (local) and mtime+size (remote), with a local manifest of last sync
//   - upload new/changed local files; download new/changed remote files
//   - conflicts (both sides changed): keep both — remote version is saved
//     locally with a " (conflict)" suffix; never silently overwrites
//   - v1 does NOT propagate deletions (safer; documented in README)
//   - every run reports honestly: uploaded N, downloaded M, conflicts (named),
//     errors with messages, timestamp. No canned "synced" label.
//
// Credentials live in Folio's settings store (data dir), server-side only.
// The session id is cached in memory and re-logged-in transparently on
// expiry (401 / session errors).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { walkVault } from './vault.js';

export const SYNC_EXTS = new Set(['.md', '.txt', '.pdf']);
export const DEFAULT_API_BASE = 'https://dev.opendrive.com/api/v1';
const CHUNK_SIZE = 10 * 1024 * 1024;

export class OpenDriveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

function nowIso() { return new Date().toISOString(); }

export function redactUsername(u) {
  const s = String(u || '');
  const at = s.indexOf('@');
  if (at <= 1) return (s[0] || '?') + '…';
  return s[0] + '…' + s.slice(at);
}

/** Parse an OpenDrive JSON response; throw OpenDriveError on API errors. */
function parseApi(bodyText, what) {
  let data;
  try { data = JSON.parse(bodyText); }
  catch {
    const e = new OpenDriveError('bad-json', `${what}: could not parse response`);
    e.data = null;
    throw e;
  }
  if (data && data.error) {
    const code = data.error.code ?? 'api';
    const msg = data.error.message || 'unknown API error';
    const e = new OpenDriveError(code, `${what}: ${msg}`);
    e.data = data; // kept so callers can inspect e.g. captcha_key
    throw e;
  }
  return data;
}

/** Pull a JSON error message out of a non-2xx body when possible. */
function httpError(status, what, bodyText) {
  let msg = `${what}: HTTP ${status}`;
  let data = null;
  try {
    data = JSON.parse(bodyText);
    if (data && data.error && data.error.message) msg = `${what}: ${data.error.message}`;
  } catch { /* keep generic message */ }
  const e = new OpenDriveError(status, msg);
  e.data = data;
  return e;
}

function isSessionError(e) {
  if (!(e instanceof OpenDriveError)) return false;
  if (e.code === 401) return true;
  return /session|expired|invalid|re-?login|does not exist|not logged/i.test(String(e.message));
}

/** Transient transport/rate errors: wait and retry WITHOUT re-login. */
function isTransientError(e) {
  if (!(e instanceof OpenDriveError)) return false;
  // 408 timeout, 423 chunk in flight, 429 rate limit, 5xx server errors.
  // (509 bandwidth-exceeded is deliberately excluded: retrying won't help.)
  return [408, 423, 429, 500, 502, 503, 504].includes(e.code);
}

/**
 * True when the login response indicates the account is waiting on 2FA
 * verification. Conservative on purpose: only explicit pending signals,
 * never a substring scan that could false-positive on e.g. EmailVerified.
 */
function loginNeedsVerification(data) {
  if (!data || typeof data !== 'object') return false;
  for (const v of [data.RequiresVerification, data.requiresVerification,
                   data.PendingVerification, data.pendingVerification,
                   data.NeedsVerification, data.needsVerification]) {
    if (v === 1 || v === '1' || v === true) return true;
  }
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && /verif/i.test(k) && /pend/i.test(v)) return true;
  }
  return false;
}

/**
 * Low-level OpenDrive API client. fetchFn is injectable for tests.
 * Credentials are supplied to login(); the session is cached in memory.
 */
export class OpenDrive {
  constructor({ apiBase = DEFAULT_API_BASE, fetchFn = fetch, timeoutMs = 20000 } = {}) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.username = null;
    this.password = null;
  }

  get signal() { return AbortSignal.timeout(this.timeoutMs); }

  async login(username, password) {
    this.username = username;
    this.password = password;
    const res = await this.fetchFn(`${this.apiBase}/session/login.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passwd: password }),
      signal: this.signal,
    });
    let data;
    try {
      data = parseApi(await res.text(), 'login');
    } catch (e) {
      // Repeated failures trigger a captcha challenge (captcha_key in the 401).
      if (e instanceof OpenDriveError && e.code === 401 && e.data && e.data.captcha_key) {
        throw new OpenDriveError(401, 'login: OpenDrive is asking for a captcha after repeated failed logins — sign in once at opendrive.com, then retry');
      }
      throw e;
    }
    if (loginNeedsVerification(data)) {
      throw new OpenDriveError('verification',
        'login: this OpenDrive account needs 2FA verification — complete it at opendrive.com, then retry');
    }
    if (!data.SessionID) throw new OpenDriveError('login', 'login: no session id returned');
    this.sessionId = data.SessionID;
    return data;
  }

  /**
   * Run fn(); on session expiry re-login and retry; on transient errors
   * (rate limit, chunk-in-flight, 5xx) wait with backoff and retry without
   * re-login. Bounded attempts; anything else throws immediately.
   */
  async withSession(fn) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (isSessionError(e) && this.username) {
          await this.login(this.username, this.password); // throws on bad creds/captcha/2FA → exits loop
          continue;
        }
        if (isTransientError(e)) {
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
          continue;
        }
        throw e;
      }
    }
    throw last;
  }

  async api(method, path, { json, raw } = {}) {
    const sid = () => this.sessionId;
    const call = async () => {
      const res = await this.fetchFn(`${this.apiBase}${path}`, {
        method,
        headers: json ? { 'Content-Type': 'application/json' } : undefined,
        body: json ? JSON.stringify({ session_id: sid(), ...json }) : undefined,
        signal: this.signal,
      });
      if (res.status === 401) throw new OpenDriveError(401, 'unauthorized (session may have expired)');
      if (!res.ok) throw httpError(res.status, path, await res.text().catch(() => ''));
      if (raw) return res;
      return parseApi(await res.text(), path);
    };
    return this.withSession(call);
  }

  /** GET that embeds the session id in the path (folder list style). */
  async apiGetSessionPath(pathTemplate) {
    const call = async () => {
      const path = pathTemplate.replace('{sid}', this.sessionId);
      const res = await this.fetchFn(`${this.apiBase}${path}`, { signal: this.signal });
      if (res.status === 401) throw new OpenDriveError(401, 'unauthorized (session may have expired)');
      if (!res.ok) throw httpError(res.status, path, await res.text().catch(() => ''));
      return parseApi(await res.text(), path);
    };
    return this.withSession(call);
  }

  /** Ensure a '/'-separated remote folder path exists; return its folder id. */
  async ensureFolderPath(remoteFolder) {
    const segs = String(remoteFolder || '/Folio').split('/').filter(Boolean);
    let parentId = '0'; // OpenDrive root
    for (const seg of segs) {
      const list = await this.apiGetSessionPath(`/folder/list.json/{sid}/${parentId}`);
      const found = (list.Folders || []).find((f) => String(f.Name).toLowerCase() === seg.toLowerCase());
      if (found) { parentId = found.FolderID; continue; }
      const created = await this.api('POST', '/folder.json', {
        json: {
          folder_name: seg, folder_sub_parent: parentId,
          folder_is_public: 0, folder_public_upl: 0, folder_public_display: 0, folder_public_dnl: 0,
        },
      });
      if (!created.FolderID) throw new OpenDriveError('folder', `could not create remote folder '${seg}'`);
      parentId = created.FolderID;
    }
    return parentId;
  }

  /** Recursively list a folder → Map<relPath, {id, name, mtime, size, dirId}>. */
  async listRecursive(folderId) {
    const out = new Map();
    const walk = async (fid, prefix) => {
      const list = await this.apiGetSessionPath(`/folder/list.json/{sid}/${fid}`);
      for (const f of list.Folders || []) {
        await walk(f.FolderID, prefix ? `${prefix}/${f.Name}` : f.Name);
      }
      for (const file of list.Files || []) {
        const rel = prefix ? `${prefix}/${file.Name}` : file.Name;
        out.set(rel, {
          id: file.FileId || file.FileID,
          name: file.Name,
          mtime: Number(file.DateModified) * 1000 || 0,
          size: Number(file.Size) || 0,
          hash: file.FileHash || null,
          dirId: fid,
        });
      }
    };
    await walk(folderId, '');
    return out;
  }

  /**
   * Full chunked upload (v2 chunk endpoint). Returns { id, mtime, size }.
   * - open_if_exists=1: re-uploading an existing name overwrites instead of 409.
   * - RequireHashOnly=1: bytes already server-side → skip straight to close.
   * - TempLocation comes from create_file; open_file_upload is the fallback.
   */
  async uploadFile(folderId, name, absPath) {
    const size = statSync(absPath).size;
    const localMtimeSec = Math.floor(statSync(absPath).mtimeMs / 1000);

    // 1. create (or open existing for overwrite)
    const created = await this.api('POST', '/upload/create_file.json', {
      json: { folder_id: folderId, file_name: name, open_if_exists: 1 },
    });
    const fileId = created.FileId || created.FileID;
    if (!fileId) throw new OpenDriveError('upload', 'create_file: no file id returned');
    let tempLocation = created.TempLocation || created.Temp_Location || null;
    const hashOnly = created.RequireHashOnly === 1 || created.RequireHashOnly === '1';

    if (!hashOnly) {
      // 2. open (skipped when create already gave us a TempLocation)
      if (!tempLocation) {
        const opened = await this.api('POST', '/upload/open_file_upload.json', {
          json: { file_id: fileId, file_size: size },
        });
        tempLocation = opened.TempLocation;
      }
      if (!tempLocation) throw new OpenDriveError('upload', 'upload: no temp location returned');

      // 3. chunks via the v2 endpoint: session/file in path, offsets in query,
      //    multipart carries only file_data. The URL is built inside the retry
      //    closure so a re-login refreshes the session id.
      const buf = readFileSync(absPath);
      let offset = 0;
      while (offset < size) {
        const chunk = buf.subarray(offset, Math.min(offset + CHUNK_SIZE, size));
        const reply = await this.withSession(async () => {
          const form = new FormData();
          form.set('file_data', new Blob([chunk]), name);
          const url =
            `${this.apiBase}/upload/upload_file_chunk2.json/${this.sessionId}/${fileId}` +
            `?temp_location=${encodeURIComponent(tempLocation)}` +
            `&chunk_offset=${offset}&chunk_size=${chunk.length}`;
          const res = await this.fetchFn(url, { method: 'POST', body: form, signal: this.signal });
          if (res.status === 401) throw new OpenDriveError(401, 'unauthorized (session may have expired)');
          if (!res.ok) throw httpError(res.status, 'upload_file_chunk2', await res.text().catch(() => ''));
          return parseApi(await res.text(), 'upload_file_chunk2');
        });
        if (Number(reply.TotalWritten) !== chunk.length) {
          throw new OpenDriveError('upload', `incomplete chunk write (${reply.TotalWritten}/${chunk.length})`);
        }
        offset += chunk.length;
      }
    }

    // 4. close (file_time sets the mtime atomically where honored)
    const closed = await this.api('POST', '/upload/close_file_upload.json', {
      json: {
        file_id: fileId, file_size: size, temp_location: tempLocation,
        file_time: String(localMtimeSec),
      },
    });
    const remoteId = closed.FileID || closed.FileId || fileId;

    // 5. belt-and-braces mtime set (same value; harmless if close already
    //    applied it). Only transient failures are tolerated here: the bytes
    //    are safe even if metadata fails, and the next sync self-heals.
    try {
      await this.api('PUT', '/file/filesettings.json', {
        json: { file_id: remoteId, file_modification_time: String(localMtimeSec) },
      });
    } catch (e) {
      if (!isTransientError(e)) throw e;
    }
    return { id: remoteId, mtime: localMtimeSec * 1000, size };
  }

  /** Download a remote file → Buffer. */
  async downloadFile(fileId) {
    const call = async () => {
      const res = await this.fetchFn(
        `${this.apiBase}/download/file.json/${fileId}?session_id=${encodeURIComponent(this.sessionId)}`,
        { signal: this.signal }
      );
      if (res.status === 401) throw new OpenDriveError(401, 'unauthorized (session may have expired)');
      if (!res.ok) throw httpError(res.status, 'download', await res.text().catch(() => ''));
      return Buffer.from(await res.arrayBuffer());
    };
    return this.withSession(call);
  }
}

// ---------------- manifest ----------------

function manifestPath(dataDir) { return join(dataDir, 'opendrive-manifest.json'); }

function loadManifest(dataDir) {
  try { return JSON.parse(readFileSync(manifestPath(dataDir), 'utf8')); }
  catch { return {}; }
}

function saveManifest(dataDir, m) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(manifestPath(dataDir), JSON.stringify(m, null, 2));
}

function localState(abs) {
  try {
    const st = statSync(abs);
    return { mtime: st.mtimeMs, size: st.size, hash: sha256File(abs) };
  } catch { return null; }
}

function conflictName(rel) {
  const dot = rel.lastIndexOf('.');
  return dot > 0 ? `${rel.slice(0, dot)} (conflict)${rel.slice(dot)}` : `${rel} (conflict)`;
}

// ---------------- sync engine ----------------

/**
 * Two-way sync between the vault and an OpenDrive remote folder.
 * settings: { username, password, remoteFolder='/Folio', dataDir, apiBase? }
 * deps: { fetch } (injectable for tests)
 * Returns a lastRun-style result. Never throws — errors are reported.
 */
export async function odSync(vaultRoot, settings, deps = {}) {
  const at = nowIso();
  const fail = (note, errors = []) => ({ at, ok: false, up: 0, down: 0, conflicts: [], errors, note });
  const { username, password } = settings || {};
  if (!username || !password) {
    return fail('not configured: OpenDrive username/password not set (see Settings)');
  }
  const remoteFolder = settings.remoteFolder || '/Folio';
  const dataDir = settings.dataDir;
  const od = new OpenDrive({ apiBase: settings.apiBase || DEFAULT_API_BASE, fetchFn: deps.fetch || fetch });

  const errors = [];
  const uploaded = [];
  const downloaded = [];
  const conflicts = [];
  try {
    await od.login(username, password);
  } catch (e) {
    return fail(`login failed: ${String(e?.message || e).slice(0, 200)}`);
  }

  let folderId;
  try {
    folderId = await od.ensureFolderPath(remoteFolder);
  } catch (e) {
    return fail(`could not access remote folder '${remoteFolder}': ${String(e?.message || e).slice(0, 200)}`);
  }

  let remote;
  try { remote = await od.listRecursive(folderId); }
  catch (e) { return fail(`could not list remote folder: ${String(e?.message || e).slice(0, 200)}`); }

  // map remote folder ids per directory for uploads into subfolders
  const folderIds = new Map([['', folderId]]);
  const ensureRemoteDir = async (relDir) => {
    if (folderIds.has(relDir)) return folderIds.get(relDir);
    const parent = relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : '';
    const parentId = await ensureRemoteDir(parent);
    const list = await od.apiGetSessionPath(`/folder/list.json/{sid}/${parentId}`);
    const leaf = relDir.slice(relDir.lastIndexOf('/') + 1);
    const found = (list.Folders || []).find((f) => String(f.Name).toLowerCase() === leaf.toLowerCase());
    let id;
    if (found) id = found.FolderID;
    else {
      const created = await od.api('POST', '/folder.json', {
        json: { folder_name: leaf, folder_sub_parent: parentId, folder_is_public: 0, folder_public_upl: 0, folder_public_display: 0, folder_public_dnl: 0 },
      });
      id = created.FolderID;
    }
    folderIds.set(relDir, id);
    return id;
  };

  const local = walkVault(vaultRoot, SYNC_EXTS);
  const localByPath = new Map(local.map((f) => [f.path, f]));
  const manifest = loadManifest(dataDir);
  const newManifest = {};

  const allPaths = new Set([...localByPath.keys(), ...remote.keys()]);
  for (const rel of [...allPaths].sort()) {
    const abs = join(vaultRoot, rel);
    const l = localByPath.get(rel);
    const r = remote.get(rel);
    const prev = manifest[rel];
    try {
      if (l && r) {
        const ls = localState(abs);
        const localChanged = !prev || prev.hash !== ls.hash;
        const remoteChanged = !prev || Math.abs((prev.mtime || 0) - r.mtime) > 1000 || prev.size !== r.size;
        if (!localChanged && !remoteChanged) { newManifest[rel] = prev; continue; }
        if (localChanged && !remoteChanged) {
          const meta = await od.uploadFile(r.dirId || folderId, basename(rel), abs);
          uploaded.push(rel);
          newManifest[rel] = { hash: localState(abs).hash, mtime: meta.mtime, size: meta.size };
        } else if (!localChanged && remoteChanged) {
          const buf = await od.downloadFile(r.id);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, buf);
          try { utimesSync(abs, new Date(r.mtime), new Date(r.mtime)); } catch { /* best effort */ }
          downloaded.push(rel);
          newManifest[rel] = { hash: localState(abs).hash, mtime: r.mtime, size: r.size };
        } else {
          // conflict: keep local original, save remote aside with " (conflict)" suffix
          const cRel = conflictName(rel);
          const buf = await od.downloadFile(r.id);
          const cAbs = join(vaultRoot, cRel);
          mkdirSync(dirname(cAbs), { recursive: true });
          writeFileSync(cAbs, buf);
          conflicts.push({ path: rel, copy: cRel });
          // stabilize: remember this remote state so we don't re-flag next run
          newManifest[rel] = { hash: localState(abs).hash, mtime: r.mtime, size: r.size };
        }
      } else if (l && !r) {
        if (prev) {
          // was synced before but is gone remotely — v1 does not propagate
          // deletes; stop tracking it rather than re-uploading.
          // (manifest entry dropped)
        } else {
          const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
          const dirId = await ensureRemoteDir(dirRel);
          const meta = await od.uploadFile(dirId, basename(rel), abs);
          uploaded.push(rel);
          newManifest[rel] = { hash: localState(abs).hash, mtime: meta.mtime, size: meta.size };
        }
      } else if (!l && r) {
        if (prev) {
          // deleted locally — v1 does not propagate deletes; do not resurrect.
          // (manifest entry dropped)
        } else {
          const buf = await od.downloadFile(r.id);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, buf);
          try { utimesSync(abs, new Date(r.mtime), new Date(r.mtime)); } catch { /* best effort */ }
          downloaded.push(rel);
          newManifest[rel] = { hash: localState(abs).hash, mtime: r.mtime, size: r.size };
        }
      }
    } catch (e) {
      errors.push(`${rel}: ${String(e?.message || e).slice(0, 140)}`);
      if (prev) newManifest[rel] = prev;
    }
    if (errors.length >= 10) break;
  }

  saveManifest(dataDir, newManifest);
  const note = `OpenDrive sync (${remoteFolder}): ${uploaded.length} uploaded, ${downloaded.length} downloaded` +
    (conflicts.length ? `, ${conflicts.length} conflict(s)` : '') +
    (errors.length ? `, ${errors.length} error(s)` : '');
  return {
    at, ok: errors.length === 0,
    up: uploaded.length, down: downloaded.length,
    uploaded, downloaded, conflicts, errors: errors.slice(0, 10), note,
  };
}

// ---------------- settings store (server-side; password never leaves) ----------------

export function loadSyncSettings(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, 'sync-settings.json'), 'utf8')); }
  catch { return {}; }
}

export function saveSyncSettings(dataDir, patch) {
  const cur = loadSyncSettings(dataDir);
  const next = { ...cur, ...patch };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'sync-settings.json'), JSON.stringify(next, null, 2));
  return next;
}

/** Masked settings for the browser: never includes the password. */
export function maskedSettings(dataDir) {
  const s = loadSyncSettings(dataDir);
  return {
    configured: !!(s.username && s.password),
    username: s.username ? redactUsername(s.username) : null,
    remoteFolder: s.remoteFolder || '/Folio',
  };
}

export function loadLastRun(dataDir) {
  try { return JSON.parse(readFileSync(join(dataDir, 'sync-last.json'), 'utf8')); }
  catch { return null; }
}

export function saveLastRun(dataDir, result) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'sync-last.json'), JSON.stringify(result, null, 2));
}
