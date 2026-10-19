// src/search.js — full-text search across the vault (shared ESM).

import { walkVault, readNote, NOTE_EXTS } from './vault.js';
import { plainText } from './markdown.js';

/**
 * Search title + content of .md/.txt notes. Returns up to `limit` hits:
 * [{path, name, score, snippet}] sorted by score desc.
 * Title matches score highest; content frequency next; recency breaks ties.
 */
export function searchVault(root, query, limit = 25) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const files = walkVault(root, NOTE_EXTS);
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = [];

  for (const f of files) {
    let content;
    try { content = readNote(root, f.path); }
    catch { continue; }
    const text = f.ext === '.md' ? plainText(content) : content;
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    const titleL = name.toLowerCase();
    const textL = text.toLowerCase();
    let score = 0;
    let firstIdx = -1;
    for (const t of terms) {
      if (titleL.includes(t)) score += 50;
      let idx = textL.indexOf(t);
      let count = 0;
      while (idx !== -1 && count < 20) {
        count++;
        if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
        idx = textL.indexOf(t, idx + t.length);
      }
      score += Math.min(count, 10) * 5;
    }
    if (score > 0) {
      hits.push({ path: f.path, name, mtime: f.mtime, score, snippet: snippetFor(text, firstIdx, terms) });
    }
  }

  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return hits.slice(0, limit).map(({ path, name, score, snippet }) => ({ path, name, score, snippet }));
}

function snippetFor(text, idx, terms) {
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + 120);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s;
}
