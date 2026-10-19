// src/server.ts — Folio: macOS-inspired notes organizer. Bun + zero deps.
// Vault = local folder (FOLIO_VAULT, default ~/workspace/your_files/folio/vault).
// Sync state + settings live in FOLIO_DATA (default <tree>/data).
// Binds 127.0.0.1:3038.
//
// Sync backend: OpenDrive.com REST API (see src/sync.js). Credentials are
// stored server-side in the data dir; the browser only ever sees masked
// status ("Connected as u…" / "Not connected"). Tokens/sessions never leave
// the server.

import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import {
  folderTree, listNotes, listNotesRecursive, readNote, writeNote, makeFolder,
  renameEntry, moveEntry, deleteEntry, resolveVaultPath, VaultError,
  validateVaultPath, pickVaultDirectory,
} from './vault.js';
import { getAppSetting, setAppSetting } from './settings.js';
import { searchVault } from './search.js';
import { plainText } from './markdown.js';
import {
  SYNC_EXTS, OpenDrive, odSync,
  loadSyncSettings, saveSyncSettings, maskedSettings,
  loadLastRun, saveLastRun, redactUsername,
} from './sync.js';

const PORT = Number(process.env.PORT || 3038);
const HOST = process.env.HOST || '127.0.0.1';
const VAULT_DEFAULT = process.env.FOLIO_VAULT || join(process.env.HOME || '/tmp', 'workspace/your_files/folio/vault');
const DATA = process.env.FOLIO_DATA || join(process.env.HOME || '/tmp', 'workspace/your_files/folio/data');

mkdirSync(DATA, { recursive: true });

// Vault path: persisted app setting wins, then FOLIO_VAULT env, then default.
// A stale setting (folder moved/deleted) falls back to the default, loudly.
let vault = VAULT_DEFAULT;
let vaultSource = process.env.FOLIO_VAULT ? 'env' : 'default';
const savedVault = getAppSetting(DATA, 'vault_path');
if (savedVault) {
  try {
    vault = validateVaultPath(savedVault);
    vaultSource = 'settings';
  } catch (e: any) {
    console.warn(`saved vault_path invalid (${savedVault}): ${e?.message} — using default`);
  }
}
mkdirSync(vault, { recursive: true });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const errJson = (e: any) => {
  const code = e instanceof VaultError ? (e.code === 'traversal' ? 403 : 400) : 500;
  return Response.json({ error: String(e?.message || e) }, { status: code });
};

const jsonBody = async (req: Request) => {
  try { return await req.json(); } catch { return {}; }
};

async function serveStatic(pathname: string): Promise<Response | null> {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel.includes('..')) return null;
  const roots = ['public', '.'];
  for (const root of roots) {
    const f = Bun.file(`${root}/${rel}`);
    if (await f.exists()) {
      const ext = '.' + rel.split('.').pop()!;
      return new Response(f, { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
    }
  }
  return null;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    try {
      // ----- vault API -----
      if (pathname === '/api/tree' && req.method === 'GET') {
        return Response.json({ folders: folderTree(vault) });
      }
      if (pathname === '/api/notes' && req.method === 'GET') {
        const folder = url.searchParams.get('folder') || '';
        const recursive = url.searchParams.get('recursive') === '1';
        const withSnippet = url.searchParams.get('snippet') === '1';
        let notes: any[];
        if (recursive) {
          // scoped subtree: folder = '' means the whole vault ("All Notes").
          // Unknown folder → VaultError → errJson, never a full-vault dump.
          notes = listNotesRecursive(vault, folder);
        } else {
          notes = listNotes(vault, folder);
        }
        if (withSnippet) {
          for (const n of notes as any[]) {
            try {
              if (n.ext === '.pdf') { (n as any).snippet = 'PDF document'; continue; }
              const raw = readNote(vault, n.path);
              const text = n.ext === '.md' ? plainText(raw) : raw;
              (n as any).snippet = text.replace(/\s+/g, ' ').trim().slice(0, 140);
            } catch { (n as any).snippet = ''; }
          }
        }
        return Response.json({ notes });
      }
      if (pathname === '/api/file' && req.method === 'GET') {
        const path = url.searchParams.get('path') || '';
        const abs = resolveVaultPath(vault, path);
        const ext = extname(abs).toLowerCase();
        if (ext === '.pdf') {
          return Response.json({ error: 'use /raw for binary files' }, { status: 400 });
        }
        return Response.json({ path, content: readNote(vault, path), mtime: statSync(abs).mtimeMs });
      }
      // raw binary (PDF embed)
      if (pathname.startsWith('/raw/') && req.method === 'GET') {
        const rel = decodeURIComponent(pathname.slice(5));
        const abs = resolveVaultPath(vault, rel);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }
        const ext = extname(abs).toLowerCase();
        if (!SYNC_EXTS.has(ext)) return Response.json({ error: 'not viewable' }, { status: 400 });
        return new Response(Bun.file(abs), { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
      }
      if (pathname === '/api/file' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        const r = writeNote(vault, b.path, b.content);
        return Response.json(r, { status: 201 });
      }
      if (pathname === '/api/file' && req.method === 'PUT') {
        const b: any = await jsonBody(req);
        const r = writeNote(vault, b.path, b.content);
        return Response.json(r);
      }
      if (pathname === '/api/folder' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(makeFolder(vault, b.path), { status: 201 });
      }
      if (pathname === '/api/rename' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(renameEntry(vault, b.path, b.name));
      }
      if (pathname === '/api/move' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(moveEntry(vault, b.path, b.dest || ''));
      }
      if (pathname === '/api/delete' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(deleteEntry(vault, b.path));
      }
      if (pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return Response.json({ results: searchVault(vault, q) });
      }
      if (pathname === '/api/snippet' && req.method === 'GET') {
        const path = url.searchParams.get('path') || '';
        const abs = resolveVaultPath(vault, path);
        const ext = extname(abs).toLowerCase();
        if (ext === '.pdf') return Response.json({ snippet: 'PDF document' });
        const raw = readNote(vault, path);
        const text = ext === '.md' ? plainText(raw) : raw;
        return Response.json({ snippet: text.replace(/\s+/g, ' ').trim().slice(0, 140) });
      }

      // ----- vault location -----
      if (pathname === '/api/vault/info' && req.method === 'GET') {
        return Response.json({ path: vault, source: vaultSource });
      }
      if (pathname === '/api/vault/set' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        const abs = validateVaultPath(b.path);
        setAppSetting(DATA, 'vault_path', abs);
        vault = abs;
        vaultSource = 'settings';
        console.log(`folio vault switched to ${vault}`);
        return Response.json({ path: vault });
      }
      if (pathname === '/api/vault/browse' && req.method === 'POST') {
        // Pop a REAL native OS directory dialog (zenity, then kdialog).
        // The server runs on the user's own machine, so it appears on
        // their screen. ~60s timeout — choosing takes a while.
        const r = await pickVaultDirectory();
        if ((r as any).path) {
          const abs = validateVaultPath((r as any).path);
          setAppSetting(DATA, 'vault_path', abs);
          vault = abs;
          vaultSource = 'settings';
          console.log(`folio vault switched to ${vault}`);
          return Response.json({ path: vault });
        }
        if ((r as any).cancelled) return Response.json({ cancelled: true });
        return Response.json({ available: false });
      }

      // ----- sync settings (masked; password never leaves the server) -----
      if (pathname === '/api/settings' && req.method === 'GET') {
        return Response.json({ opendrive: maskedSettings(DATA) });
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        const patch: any = {};
        if ('username' in b) patch.username = String(b.username || '').trim().slice(0, 200);
        if ('password' in b) patch.password = String(b.password || '').slice(0, 500);
        if ('remoteFolder' in b) {
          let rf = String(b.remoteFolder || '/Folio').trim().slice(0, 200) || '/Folio';
          if (!rf.startsWith('/')) rf = '/' + rf;
          patch.remoteFolder = rf;
        }
        saveSyncSettings(DATA, patch);
        return Response.json({ ok: true, opendrive: maskedSettings(DATA) });
      }
      if (pathname === '/api/settings/disconnect' && req.method === 'POST') {
        saveSyncSettings(DATA, { username: '', password: '' });
        return Response.json({ ok: true, opendrive: maskedSettings(DATA) });
      }

      // ----- sync -----
      if (pathname === '/api/sync/status' && req.method === 'GET') {
        const s = loadSyncSettings(DATA);
        const masked = maskedSettings(DATA);
        const lastRun = loadLastRun(DATA);
        const available = !!(s.username && s.password);
        return Response.json({
          backend: 'opendrive',
          available,
          reason: available
            ? ''
            : 'not configured: OpenDrive username/password not set (see Settings in the sync panel)',
          connectedAs: masked.username,
          remoteFolder: masked.remoteFolder,
          lastRun,
        });
      }
      if (pathname === '/api/sync/test' && req.method === 'POST') {
        const s = loadSyncSettings(DATA);
        if (!s.username || !s.password) {
          return Response.json({ ok: false, error: 'not configured: OpenDrive username/password not set' });
        }
        const od = new OpenDrive({ apiBase: process.env.OPENDRIVE_API_BASE || undefined });
        try {
          const info = await od.login(s.username, s.password);
          return Response.json({ ok: true, user: info.UserName || redactUsername(s.username) });
        } catch (e: any) {
          return Response.json({ ok: false, error: String(e?.message || e).slice(0, 300) });
        }
      }
      if (pathname === '/api/sync/run' && req.method === 'POST') {
        const s = loadSyncSettings(DATA);
        const result = await odSync(vault, {
          username: s.username, password: s.password,
          remoteFolder: s.remoteFolder || '/Folio',
          dataDir: DATA,
          apiBase: process.env.OPENDRIVE_API_BASE || undefined,
        });
        saveLastRun(DATA, result);
        return Response.json({ result });
      }

      const st = await serveStatic(pathname);
      if (st) return st;
      return new Response('not found', { status: 404 });
    } catch (e: any) {
      console.error(e);
      return errJson(e);
    }
  },
});

console.log(`folio on http://${HOST}:${PORT} (vault: ${vault})`);
