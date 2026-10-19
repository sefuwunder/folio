// src/markdown.js — minimal zero-dependency markdown renderer (shared ESM).
// Supports: headings, bold, italic, inline code, code blocks, links,
// unordered/ordered lists, task checkboxes, blockquotes, hr, paragraphs.
// HTML-escapes input first; output is safe to inject.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  let out = esc(s);
  // inline code first (protect from other transforms)
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
  return out;
}

/** Render a markdown string to an HTML fragment. */
export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let listStack = []; // 'ul' | 'ol'

  const closeLists = () => {
    while (listStack.length) html.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line)) {
      if (inCode) {
        html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeLists();
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // blank line
    if (/^\s*$/.test(line)) { closeLists(); i++; continue; }

    // headings
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      closeLists();
      const lvl = m[1].length;
      html.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // hr
    if (/^(\*\*\*|---|___)\s*$/.test(line)) {
      closeLists();
      html.push('<hr>');
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      closeLists();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${q.map((l) => inline(l)).join('<br>')}</blockquote>`);
      continue;
    }

    // task checkbox / list items
    m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      const kind = /^\d/.test(m[2]) ? 'ol' : 'ul';
      if (listStack[listStack.length - 1] !== kind) {
        closeLists();
        html.push(`<${kind}>`);
        listStack.push(kind);
      }
      let item = m[3];
      const cb = item.match(/^\[([ xX])\]\s+(.*)$/);
      if (cb) {
        const checked = cb[1].toLowerCase() === 'x';
        html.push(`<li class="task"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${inline(cb[2])}</li>`);
      } else {
        html.push(`<li>${inline(item)}</li>`);
      }
      i++;
      continue;
    }

    // paragraph (gather soft-wrapped lines)
    closeLists();
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^(#{1,6}\s|```|>\s?|(\s*([-*+]|\d+[.)])\s+)|(\*\*\*|---|___)\s*$)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  closeLists();
  return html.join('\n');
}

/** Plain-text excerpt of markdown for list snippets/search. */
export function plainText(src) {
  return String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|\*|_)/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*[-*+]|\s*\d+[.)])\s+\[[ xX]\]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
