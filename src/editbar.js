// src/editbar.js — pure text operations for folio's markdown edit bar.
//
// Every function takes (value, start, end) — the textarea content and its
// selection — and returns { value, start, end }, the new content and the
// selection to place afterwards. No DOM here, so bun:test covers them
// directly; public/app.js just applies the result to the textarea.

/** Replace the selection with `text`; select the [selStart, selEnd) span of it. */
function replaceSel(value, start, end, text, selStart, selEnd) {
  const next = value.slice(0, start) + text + value.slice(end);
  return { value: next, start: start + selStart, end: start + selEnd };
}

/** Wrap the selection in `before`/`after`; with no selection, insert a placeholder and select it. */
export function wrapSelection(value, start, end, before, after, placeholder) {
  if (start === end) {
    return replaceSel(value, start, end, before + placeholder + after, before.length, before.length + placeholder.length);
  }
  const inner = value.slice(start, end);
  return { value: value.slice(0, start) + before + inner + after + value.slice(end), start: start + before.length, end: end + before.length };
}

/** Expand a selection to the full lines it touches. Returns [lineStart, lineEnd, lines]. */
function touchedLines(value, start, end) {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = value.length;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  return [lineStart, lineEnd, lines];
}

/**
 * Prefix every touched line, or strip the prefix if every touched line
 * already has it. `strip` matches the prefix to remove (defaults to the
 * literal prefix); the new selection covers the whole touched block.
 */
export function prefixLines(value, start, end, prefix, strip) {
  const [lineStart, lineEnd, lines] = touchedLines(value, start, end);
  const re = strip || new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const allHave = lines.every((l) => re.test(l));
  const next = lines.map((l) => (allHave ? l.replace(re, '') : re.test(l) ? l : prefix + l)).join('\n');
  const out = value.slice(0, lineStart) + next + value.slice(lineEnd);
  return { value: out, start: lineStart, end: lineStart + next.length };
}

/** Number the touched lines 1., 2., 3. — or strip numbering if all are already numbered. */
export function numberLines(value, start, end) {
  const [lineStart, lineEnd, lines] = touchedLines(value, start, end);
  const re = /^\d+[.)]\s+/;
  const allHave = lines.every((l) => re.test(l));
  const next = allHave
    ? lines.map((l) => l.replace(re, '')).join('\n')
    : lines.map((l, k) => (re.test(l) ? l : `${k + 1}. ${l}`)).join('\n');
  const out = value.slice(0, lineStart) + next + value.slice(lineEnd);
  return { value: out, start: lineStart, end: lineStart + next.length };
}

/** Insert a block (table, details, …) at the cursor, keeping it on its own lines. */
function insertBlock(value, start, end, block, selStart, selEnd) {
  let text = block;
  if (start > 0 && value[start - 1] !== '\n') text = '\n' + text;
  if (end < value.length && value[end] !== '\n') text = text + '\n';
  return replaceSel(value, start, end, text, selStart, selEnd);
}

/** Insert a 2-column table skeleton; selects the first header cell's text. */
export function insertTable(value, start, end) {
  const block = '| Header | Header |\n| --- | --- |\n|  |  |';
  const atLineStart = start === 0 || value[start - 1] === '\n';
  // selection offset of the first "Header" inside the inserted text
  const firstHeader = (atLineStart ? 0 : 1) + 2;
  return insertBlock(value, start, end, block, firstHeader, firstHeader + 6);
}

/** Insert a foldable <details> section; selects the summary placeholder. */
export function insertDetails(value, start, end) {
  const block = '<details>\n<summary>Summary</summary>\n\nContent\n\n</details>';
  const atLineStart = start === 0 || value[start - 1] === '\n';
  const summaryAt = (atLineStart ? 0 : 1) + '<details>\n<summary>'.length;
  return insertBlock(value, start, end, block, summaryAt, summaryAt + 7);
}
