// src/markdown.js — minimal zero-dependency markdown renderer (shared ESM).
// Supports: headings, bold, italic, inline code, code blocks, links,
// unordered/ordered lists, task checkboxes, blockquotes, hr, paragraphs,
// GFM-style pipe tables, and <details> foldable sections.
// A ```mermaid fenced block renders as <pre class="mermaid"> (the client
// lazy-loads the locally vendored Mermaid bundle to turn it into a diagram);
// every other fence renders as a plain code block.
// HTML-escapes input first; output is safe to inject. The only raw HTML
// ever emitted is a bare <details>/<details open>/<summary> foldable
// block — any other tag (or attributes on details) stays escaped text.

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
  let codeLang = '';
  let codeBuf = [];
  let inDetails = false;
  let listStack = []; // 'ul' | 'ol'

  const closeLists = () => {
    while (listStack.length) html.push(`</${listStack.pop()}>`);
  };

  // A pipe table starts with a | header row + a | --- | separator row
  // (each separator cell needs 3+ dashes, optional alignment colons).
  const isTableStart = (idx) => {
    if (!/^\|.*\|\s*$/.test(lines[idx] || '')) return false;
    const sep = lines[idx + 1] || '';
    if (!/^\|[\s:|-]+\|\s*$/.test(sep)) return false;
    return sep.replace(/^\||\|$/g, '').split('|').every((c) => /^:?-{3,}:?$/.test(c.trim()));
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block (```mermaid becomes a diagram hook, not code)
    if (/^```/.test(line)) {
      if (inCode) {
        if (codeLang === 'mermaid') {
          html.push(`<pre class="mermaid">${esc(codeBuf.join('\n'))}</pre>`);
        } else {
          html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        }
        codeBuf = [];
        inCode = false;
        codeLang = '';
      } else {
        closeLists();
        inCode = true;
        codeLang = line.slice(3).trim().toLowerCase();
      }
      i++;
      continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // foldable section: bare <details> or <details open> only — any other
    // tag or attribute stays escaped text (see the paragraph branch)
    if (/^<details(\s+open)?>\s*$/.test(line)) {
      closeLists();
      html.push(/^<details\s+open/.test(line) ? '<details open>' : '<details>');
      inDetails = true;
      i++;
      continue;
    }
    if (inDetails && /^<\/details>\s*$/.test(line)) {
      closeLists();
      html.push('</details>');
      inDetails = false;
      i++;
      continue;
    }
    if (inDetails) {
      const sm = line.match(/^<summary>(.*)<\/summary>\s*$/);
      if (sm) {
        html.push(`<summary>${inline(sm[1])}</summary>`);
        i++;
        continue;
      }
    }

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
        // Enabled, with its source line number: preview clicks toggle it
        // (see onPreviewClick in app.js). Tasks in code blocks never reach
        // here — they render as plain code text.
        html.push(`<li class="task"><input type="checkbox" class="task-check" data-line="${i}"${checked ? ' checked' : ''}> ${inline(cb[2])}</li>`);
      } else {
        html.push(`<li>${inline(item)}</li>`);
      }
      i++;
      continue;
    }

    // GFM-style pipe table: header row + separator row, then body rows
    if (isTableStart(i)) {
      closeLists();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cells(line);
      const aligns = cells(lines[i + 1]).map((s) => /^:-+:$/.test(s) ? 'center' : /^-+:$/.test(s) ? 'right' : /^:-+$/.test(s) ? 'left' : '');
      const alignAttr = (a) => a ? ` style="text-align:${a}"` : '';
      html.push('<table><thead><tr>' + header.map((c, k) => `<th${alignAttr(aligns[k] || '')}>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        const row = cells(lines[i]);
        html.push('<tr>' + header.map((_, k) => `<td${alignAttr(aligns[k] || '')}>${inline(row[k] || '')}</td>`).join('') + '</tr>');
        i++;
      }
      html.push('</tbody></table>');
      continue;
    }

    // paragraph (gather soft-wrapped lines)
    closeLists();
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^(#{1,6}\s|```|>\s?|(\s*([-*+]|\d+[.)])\s+|<details(\s+open)?>\s*|<\/details>\s*|<summary>.*<\/summary>\s*)|(\*\*\*|---|___)\s*$)/.test(lines[i]) &&
           !isTableStart(i)) {
      para.push(lines[i]);
      i++;
    }
    if (!para.length) {
      // A line that stops a paragraph but belongs to no block (a stray
      // </details> or <summary> outside a foldable section): render it as
      // escaped text and move on — never spin on the same line.
      html.push(`<p>${inline(lines[i])}</p>`);
      i++;
      continue;
    }
    html.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  closeLists();
  if (inDetails) html.push('</details>'); // unclosed foldable section: close it, don't swallow the doc
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
    .replace(/<details[^>]*>/g, '')
    .replace(/<\/details>/g, '')
    .replace(/<summary>(.*?)<\/summary>/g, '$1')
    .replace(/^\|[\s:|-]+\|\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
