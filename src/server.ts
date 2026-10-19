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
  folderTree, listNotes, readNote, writeNote, makeFolder,
  renameEntry, moveEntry, deleteEntry, resolveVaultPath, VaultError,
} from './vault.js';
import { searchVault } from './search.js';
import { plainText } from './markdown.js';
import {
  SYNC_EXTS, OpenDrive, odSync,
  loadSyncSettings, saveSyncSettings, maskedSettings,
  loadLastRun, saveLastRun, redactUsername,
} from './sync.js';

const PORT = Number(process.env.PORT || 3038);
const HOST = process.env.HOST || '127.0.0.1';
const VAULT = process.env.FOLIO_VAULT || join(process.env.HOME || '/tmp', 'workspace/your_files/folio/vault');
const DATA = process.env.FOLIO_DATA || join(process.env.HOME || '/tmp', 'workspace/your_files/folio/data');

mkdirSync(VAULT, { recursive: true });
mkdirSync(DATA, { recursive: true });

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
        return Response.json({ folders: folderTree(VAULT) });
      }
      if (pathname === '/api/notes' && req.method === 'GET') {
        const folder = url.searchParams.get('folder') || '';
        const recursive = url.searchParams.get('recursive') === '1';
        const withSnippet = url.searchParams.get('snippet') === '1';
        let notes: any[];
        if (recursive) {
          notes = listNotes(VAULT, '');
          const walkF = (folders: any[]) => {
            for (const f of folders) {
              notes.push(...listNotes(VAULT, f.path));
              walkF(f.children);
            }
          };
          walkF(folderTree(VAULT));
          notes.sort((a: any, b: any) => b.mtime - a.mtime);
        } else {
          notes = listNotes(VAULT, folder);
        }
        if (withSnippet) {
          for (const n of notes as any[]) {
            try {
              if (n.ext === '.pdf') { (n as any).snippet = 'PDF document'; continue; }
              const raw = readNote(VAULT, n.path);
              const text = n.ext === '.md' ? plainText(raw) : raw;
              (n as any).snippet = text.replace(/\s+/g, ' ').trim().slice(0, 140);
            } catch { (n as any).snippet = ''; }
          }
        }
        return Response.json({ notes });
      }
      if (pathname === '/api/file' && req.method === 'GET') {
        const path = url.searchParams.get('path') || '';
        const abs = resolveVaultPath(VAULT, path);
        const ext = extname(abs).toLowerCase();
        if (ext === '.pdf') {
          return Response.json({ error: 'use /raw for binary files' }, { status: 400 });
        }
        return Response.json({ path, content: readNote(VAULT, path), mtime: statSync(abs).mtimeMs });
      }
      // raw binary (PDF embed)
      if (pathname.startsWith('/raw/') && req.method === 'GET') {
        const rel = decodeURIComponent(pathname.slice(5));
        const abs = resolveVaultPath(VAULT, rel);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }
        const ext = extname(abs).toLowerCase();
        if (!SYNC_EXTS.has(ext)) return Response.json({ error: 'not viewable' }, { status: 400 });
        return new Response(Bun.file(abs), { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
      }
      if (pathname === '/api/file' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        const r = writeNote(VAULT, b.path, b.content);
        return Response.json(r, { status: 201 });
      }
      if (pathname === '/api/file' && req.method === 'PUT') {
        const b: any = await jsonBody(req);
        const r = writeNote(VAULT, b.path, b.content);
        return Response.json(r);
      }
      if (pathname === '/api/folder' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(makeFolder(VAULT, b.path), { status: 201 });
      }
      if (pathname === '/api/rename' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(renameEntry(VAULT, b.path, b.name));
      }
      if (pathname === '/api/move' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(moveEntry(VAULT, b.path, b.dest || ''));
      }
      if (pathname === '/api/delete' && req.method === 'POST') {
        const b: any = await jsonBody(req);
        return Response.json(deleteEntry(VAULT, b.path));
      }
      if (pathname === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return Response.json({ results: searchVault(VAULT, q) });
      }
      if (pathname === '/api/snippet' && req.method === 'GET') {
        const path = url.searchParams.get('path') || '';
        const abs = resolveVaultPath(VAULT, path);
        const ext = extname(abs).toLowerCase();
        if (ext === '.pdf') return Response.json({ snippet: 'PDF document' });
        const raw = readNote(VAULT, path);
        const text = ext === '.md' ? plainText(raw) : raw;
        return Response.json({ snippet: text.replace(/\s+/g, ' ').trim().slice(0, 140) });
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
        const result = await odSync(VAULT, {
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

console.log(`folio on http://${HOST}:${PORT} (vault: ${VAULT})`);
