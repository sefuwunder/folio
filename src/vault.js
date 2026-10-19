// src/vault.js — filesystem operations for the Folio vault (shared ESM).
// All paths are vault-relative; traversal outside the vault is rejected.

import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, accessSync, constants } from 'node:fs';
import { join, normalize, sep, dirname, basename, extname, isAbsolute } from 'node:path';

export const NOTE_EXTS = new Set(['.md', '.txt']);
export const VIEW_EXTS = new Set(['.md', '.txt', '.pdf']);

export class VaultError extends Error {
  constructor(message, code = 'vault') { super(message); this.code = code; }
}

/**
 * Resolve a vault-relative path to an absolute path inside the vault root.
 * Throws VaultError('traversal') on escape attempts.
 */
export function resolveVaultPath(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) {
    throw new VaultError('absolute paths are not allowed', 'traversal');
  }
  const abs = normalize(join(root, clean));
  const rootN = normalize(root);
  if (abs !== rootN && !abs.startsWith(rootN + sep)) {
    throw new VaultError('path escapes the vault', 'traversal');
  }
  return abs;
}

/** Validate a file/folder name (single segment). */
export function validName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..') return false;
  if (/[\\/:*?"<>|]/.test(n)) return false;
  if (n.length > 200) return false;
  return true;
}

/** Recursive folder tree: [{name, path, children:[...]}]. */
export function folderTree(root) {
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        return { name: e.name, path: childRel, children: walk(join(dir, e.name), childRel) };
      });
  };
  return walk(root, '');
}

/**
 * Notes in a folder (non-recursive). Returns [{name, path, mtime, size, ext}].
 * Hidden files and non-viewable extensions are skipped.
 */
export function listNotes(root, rel = '') {
  const dir = resolveVaultPath(root, rel);
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw new VaultError(`cannot read folder: ${rel}`, 'notfound'); }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && VIEW_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => {
      const st = statSync(join(dir, e.name));
      const p = rel ? `${rel}/${e.name}` : e.name;
      return { name: e.name, path: p, mtime: st.mtimeMs, size: st.size, ext: extname(e.name).toLowerCase() };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Notes in a folder and all its descendant folders (recursive).
 * Returns the same shape as listNotes, sorted newest-first.
 * rel = '' walks the whole vault. Unknown folder → VaultError('notfound').
 */
export function listNotesRecursive(root, rel = '') {
  const abs = resolveVaultPath(root, rel); // throws VaultError('traversal') on escape
  let st;
  try { st = statSync(abs); }
  catch { throw new VaultError(`folder not found: ${rel}`, 'notfound'); }
  if (!st.isDirectory()) throw new VaultError(`not a folder: ${rel}`, 'notfound');
  const out = [];
  const walk = (dirAbs, dirRel) => {
    out.push(...listNotes(root, dirRel));
    let entries = [];
    try { entries = readdirSync(dirAbs, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      walk(join(dirAbs, e.name), dirRel ? `${dirRel}/${e.name}` : e.name);
    }
  };
  walk(abs, rel);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Read a note's content as UTF-8 text (.md/.txt). */
export function readNote(root, rel) {
  const abs = resolveVaultPath(root, rel);
  if (!NOTE_EXTS.has(extname(abs).toLowerCase())) {
    throw new VaultError('not a text note', 'type');
  }
  try { return readFileSync(abs, 'utf8'); }
  catch { throw new VaultError(`cannot read note: ${rel}`, 'notfound'); }
}

/** Write (create or overwrite) a note. Creates parent folders as needed. */
export function writeNote(root, rel, content) {
  if (!validName(basename(rel))) throw new VaultError('invalid file name', 'name');
  if (!NOTE_EXTS.has(extname(rel).toLowerCase())) throw new VaultError('only .md and .txt notes can be edited', 'type');
  const abs = resolveVaultPath(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, String(content ?? ''), 'utf8');
  const st = statSync(abs);
  return { path: rel, mtime: st.mtimeMs, size: st.size };
}

/** Create a folder (nested ok). */
export function makeFolder(root, rel) {
  if (!validName(basename(rel))) throw new VaultError('invalid folder name', 'name');
  const abs = resolveVaultPath(root, rel);
  if (existsSync(abs)) throw new VaultError('already exists', 'exists');
  mkdirSync(abs, { recursive: true });
  return { path: rel };
}

/** Rename a note or folder within its parent directory. */
export function renameEntry(root, rel, newName) {
  if (!validName(newName)) throw new VaultError('invalid name', 'name');
  const abs = resolveVaultPath(root, rel);
  if (!existsSync(abs)) throw new VaultError('not found', 'notfound');
  const parent = dirname(rel);
  const destRel = parent === '.' ? newName : `${parent}/${newName}`;
  const dest = resolveVaultPath(root, destRel);
  if (existsSync(dest)) throw new VaultError('a file or folder with that name already exists', 'exists');
  renameSync(abs, dest);
  return { path: destRel };
}

/** Move a note or folder into another folder. Returns the new path. */
export function moveEntry(root, rel, destFolder) {
  const abs = resolveVaultPath(root, rel);
  if (!existsSync(abs)) throw new VaultError('not found', 'notfound');
  const destDir = resolveVaultPath(root, destFolder || '');
  if (!statSync(destDir).isDirectory()) throw new VaultError('destination is not a folder', 'type');
  const name = basename(rel);
  const destRel = destFolder ? `${destFolder}/${name}` : name;
  const dest = resolveVaultPath(root, destRel);
  // cannot move a folder into itself or its own descendant
  const absN = normalize(abs);
  const destN = normalize(dest);
  if (destN === absN || destN.startsWith(absN + sep)) {
    throw new VaultError('cannot move a folder into itself', 'move');
  }
  if (existsSync(dest)) throw new VaultError('destination already has that name', 'exists');
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(abs, dest);
  return { path: destRel };
}

/** Delete a note or folder (folders delete recursively). */
export function deleteEntry(root, rel) {
  const abs = resolveVaultPath(root, rel);
  if (!existsSync(abs)) throw new VaultError('not found', 'notfound');
  rmSync(abs, { recursive: true, force: true });
  return { deleted: rel };
}

/** Validate a user-chosen vault root: absolute, exists, is a readable+writable dir. */
export function validateVaultPath(p) {
  const s = String(p || '').trim();
  if (!s) throw new VaultError('no folder given', 'invalid');
  if (s.includes('\0')) throw new VaultError('invalid folder path', 'invalid');
  if (!isAbsolute(s)) throw new VaultError('folder path must be absolute', 'invalid');
  const abs0 = normalize(s);
  if (abs0 === sep) throw new VaultError('refusing to use the filesystem root as a vault', 'invalid');
  const abs = abs0.replace(/\/+$/, '');
  let st;
  try { st = statSync(abs); }
  catch { throw new VaultError('folder does not exist: ' + abs, 'invalid'); }
  if (!st.isDirectory()) throw new VaultError('not a folder: ' + abs, 'invalid');
  try { accessSync(abs, constants.R_OK | constants.W_OK); }
  catch { throw new VaultError('folder is not readable and writable: ' + abs, 'invalid'); }
  return abs;
}

const DIALOG_TIMEOUT_MS = 60000;

/** Default dialog runner: Bun.spawn with a 60s timeout (user may take time choosing). */
async function defaultDialogRun(cmd, args, { timeoutMs = DIALOG_TIMEOUT_MS } = {}) {
  let proc;
  try {
    proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  } catch (e) {
    const err = new Error(`dialog tool not available: ${cmd}`);
    err.code = 'ENOENT';
    throw err;
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
  let code, stdout;
  try {
    [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  } finally {
    clearTimeout(timer);
  }
  if (code === 127) {
    const err = new Error(`dialog tool not available: ${cmd}`);
    err.code = 'ENOENT';
    throw err;
  }
  return { code, stdout, timedOut };
}

/**
 * Pop a REAL native OS directory dialog (zenity, then kdialog) so the user
 * can choose a vault folder. Returns {path} | {cancelled:true, timedOut?} |
 * {available:false}. The runner is injectable for tests.
 */
export async function pickVaultDirectory(deps = {}) {
  const run = deps.run || defaultDialogRun;
  const tools = [
    { cmd: 'zenity', args: ['--file-selection', '--directory', '--title=Choose vault folder'] },
    { cmd: 'kdialog', args: ['--getexistingdirectory', '--title', 'Choose vault folder'] },
  ];
  for (const t of tools) {
    let r;
    try {
      r = await run(t.cmd, t.args, { timeoutMs: DIALOG_TIMEOUT_MS });
    } catch (e) {
      if (e && (e.code === 'ENOENT' || /ENOENT|not found/i.test(String(e.message)))) continue;
      throw e;
    }
    if (r.timedOut) return { cancelled: true, timedOut: true };
    const picked = String(r.stdout || '').trim();
    if (r.code === 0 && picked) return { path: picked };
    // exit 1 / empty output = the user dismissed the dialog — respect that.
    if (r.code === 1 || (r.code === 0 && !picked)) return { cancelled: true };
    // anything else (no display, broken tool, …) → try the next tool
  }
  return { available: false };
}

/** Walk the vault yielding {path, ext, mtime, size} for syncable note files. */
export function walkVault(root, exts = NOTE_EXTS) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, childRel);
      else if (e.isFile() && exts.has(extname(e.name).toLowerCase())) {
        const st = statSync(full);
        out.push({ path: childRel, ext: extname(e.name).toLowerCase(), mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(root, '');
  return out;
}
