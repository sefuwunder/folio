// src/mind.js — Folio's quiet intelligence, repurposed from abba's mind.ts.
//
// Deterministic and local: no network, no model, no telemetry. The UI
// renders its outputs as ordinary interface, never as "suggestions from
// an agent". Two surfaces use it:
//   - related notes: notes sharing language with the open note
//   - Today: open checklists grouped by folder, then file
// A folio note is { path, name, body, mtime }. Unlike abba, folio notes
// have no tags or lifecycle status, so keywords come from the file name,
// the folder path, and the body.

export const STOP = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,us,do,does,did,will,would,can,could,should,have,has,had,not,no,yes,so,such,than,too,very,just,about,into,over,after,before,up,down,out,off,again,once,here,there,when,where,why,how,what,which,who,whom,all,any,both,each,few,more,most,other,some,only,own,same".split(",")
);

export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function keywordSet(note) {
  const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
  const base = note.name.replace(/\.[^.]+$/, '');
  return new Set(tokens(`${base} ${dir.replace(/\//g, ' ')} ${note.body || ''}`));
}

/**
 * Related notes, found by shared language — shown in the UI under a plain
 * "Related" heading. Deterministic; ties break by recency, then path.
 * Returns [{ path, name, score, mtime }], at most `limit`, never the note itself.
 */
export function relatedNotes(note, pool, limit = 3) {
  const mine = keywordSet(note);
  if (!mine.size) return [];
  const scored = [];
  for (const other of pool) {
    if (other.path === note.path) continue;
    const theirs = keywordSet(other);
    let overlap = 0;
    for (const w of mine) if (theirs.has(w)) overlap++;
    if (overlap >= 2) scored.push({ n: other, s: overlap });
  }
  scored.sort((a, b) => b.s - a.s || b.n.mtime - a.n.mtime || a.n.path.localeCompare(b.n.path));
  return scored.slice(0, limit).map(({ n, s }) => ({ path: n.path, name: n.name, score: s, mtime: n.mtime }));
}

/** Parse markdown checklist items, skipping fenced code blocks. */
export function parseTasks(body) {
  const out = [];
  let inPre = false;
  for (const raw of String(body || '').split('\n')) {
    if (/^```/.test(raw)) { inPre = !inPre; continue; }
    if (inPre) continue;
    const m = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m) out.push({ text: m[2].trim().slice(0, 120), done: m[1] !== ' ' });
  }
  return out;
}

const WRAPPED_WINDOW_MS = 7 * 864e5;

/**
 * Group a vault's notes into Today's view: files with open tasks, grouped
 * by folder then file, plus files wrapped up (all tasks done) in the last
 * 7 days. Folders sort alphabetically (vault root first), files by name.
 * Pure function of the pool + now, so tests need no filesystem.
 */
export function groupToday(pool, nowMs = Date.now()) {
  const byFolder = new Map();
  const wrapped = [];
  for (const note of pool) {
    const tasks = parseTasks(note.body || '');
    if (!tasks.length) continue;
    const done = tasks.filter((t) => t.done).length;
    const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
    if (done === tasks.length) {
      if ((note.mtime || 0) >= nowMs - WRAPPED_WINDOW_MS) {
        wrapped.push({ path: note.path, name: note.name, total: tasks.length });
      }
      continue;
    }
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    byFolder.get(dir).push({
      path: note.path,
      name: note.name,
      open: tasks.filter((t) => !t.done).map((t) => t.text),
      done,
      total: tasks.length,
    });
  }
  const open = [...byFolder.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, files]) => ({
      folder,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  wrapped.sort((a, b) => a.name.localeCompare(b.name));
  return { open, wrapped };
}
