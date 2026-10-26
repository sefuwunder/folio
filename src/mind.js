// src/mind.js — Folio's quiet intelligence, repurposed from abba's mind.ts.
//
// Deterministic and local: no network, no model, no telemetry. The UI
// renders its outputs as ordinary interface, never as "suggestions from
// an agent". Three surfaces use it:
//   - related notes: notes sharing language with the open note
//   - Today: open checklists grouped by folder, then file
//   - tag explorer: notes grouped by their hashtags, laid out as a graph
// A folio note is { path, name, body, mtime }. Notes carry no stored
// tags: hashtags in the body are read as implicit tags by extractTags —
// never written back into files, never shown inline. Keywords for
// Related still come from the file name, the folder path, and the body.

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

/**
 * Implicit tags: hashtags in a note's body, lowercased and deduplicated.
 * A hashtag is `#` followed immediately by word characters, at the start
 * of a line or after whitespace / an opening bracket — so markdown
 * headings (`# Title`), URL fragments (`page#section`), glued words
 * (`word#tag`), and `##tag` are not tags. Fenced code blocks and inline
 * code spans are skipped, like parseTasks skips fences.
 */
export function extractTags(body) {
  const tags = new Set();
  let inFence = false;
  for (const raw of String(body || '').split('\n')) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.replace(/`[^`]*`/g, ' ');
    for (const m of line.matchAll(/(?:^|[\s([])#([A-Za-z0-9_-]+)/g)) {
      tags.add(m[1].toLowerCase());
    }
  }
  return [...tags].sort();
}

/**
 * The tag graph of a vault: every tag with the notes carrying it, and
 * every tagged note with its tags. Untagged notes are omitted. Tags sort
 * by name, note lists by path — deterministic, so the explorer lays out
 * identically on every load.
 * Returns { tags: [{ name, notes: [path] }], notes: [{ path, name, tags }] }.
 */
export function buildTagGraph(pool) {
  const byTag = new Map();
  const notes = [];
  for (const note of pool) {
    const tags = extractTags(note.body || '');
    if (!tags.length) continue;
    notes.push({ path: note.path, name: note.name, tags });
    for (const t of tags) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(note.path);
    }
  }
  notes.sort((a, b) => a.path.localeCompare(b.path));
  const tags = [...byTag.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, paths]) => ({ name, notes: paths.sort() }));
  return { tags, notes };
}

/**
 * Deterministic layout for the tag graph, in world coordinates (the
 * canvas fits the view to the bounding box, so absolute scale is free).
 * Tags sit on a circle, alphabetical clockwise from the top. Notes with
 * one tag ring around that tag; notes with several tags sit at the
 * centroid of their tags, ringed only when several notes share the
 * exact same tag set. Returns { tags, notes } with x/y on every node.
 */
export function layoutTagGraph(graph) {
  const tags = graph.tags || [];
  const notes = graph.notes || [];
  const placed = new Map(); // tag name -> { x, y, angle }
  const tagNodes = [];
  if (tags.length === 1) {
    placed.set(tags[0].name, { x: 0, y: 0, angle: 0 });
    tagNodes.push({ name: tags[0].name, x: 0, y: 0, count: tags[0].notes.length });
  } else if (tags.length > 1) {
    const R = 180 + 45 * tags.length;
    tags.forEach((t, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / tags.length;
      const x = Math.cos(angle) * R;
      const y = Math.sin(angle) * R;
      placed.set(t.name, { x, y, angle });
      tagNodes.push({ name: t.name, x, y, count: t.notes.length });
    });
  }
  // Group notes by tag-set signature for the shared-centroid rings.
  const groups = new Map();
  for (const n of notes) {
    const sig = n.tags.join('|');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(n);
  }
  const seenInGroup = new Map();
  const noteNodes = [];
  for (const n of notes) {
    const sig = n.tags.join('|');
    const group = groups.get(sig);
    const j = seenInGroup.get(sig) || 0;
    seenInGroup.set(sig, j + 1);
    let x;
    let y;
    if (n.tags.length === 1) {
      const t = placed.get(n.tags[0]);
      const ringR = Math.max(120, group.length * 14);
      const a = t.angle + (j * 2 * Math.PI) / group.length;
      x = t.x + Math.cos(a) * ringR;
      y = t.y + Math.sin(a) * ringR;
    } else {
      let cx = 0;
      let cy = 0;
      for (const t of n.tags) {
        cx += placed.get(t).x;
        cy += placed.get(t).y;
      }
      cx /= n.tags.length;
      cy /= n.tags.length;
      if (group.length === 1) {
        x = cx;
        y = cy;
      } else {
        const ringR = Math.max(40, group.length * 14);
        const a = (j * 2 * Math.PI) / group.length;
        x = cx + Math.cos(a) * ringR;
        y = cy + Math.sin(a) * ringR;
      }
    }
    noteNodes.push({ path: n.path, name: n.name, x, y, tags: n.tags });
  }
  return { tags: tagNodes, notes: noteNodes };
}
