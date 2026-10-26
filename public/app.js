// Folio client — macOS-inspired notes organizer (ES module).
import { renderMarkdown } from '/src/markdown.js';
import { wrapSelection, prefixLines, numberLines, insertTable, insertDetails } from '/src/editbar.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  tree: [],
  folder: '',        // '' = All Notes, else folder path
  folderName: 'All Notes',
  notes: [],
  note: null,        // {path, ext, content, dirty, mtime}
  mdMode: 'edit',    // 'edit' | 'preview'
  saveTimer: null,
  today: false,      // list pane is showing the Today task view
  todayData: null,   // last /api/today payload, re-rendered after openNote
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2400);
}

function fmtDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  if (now - d < 7 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- sidebar / folder tree ---------------- */

function folderIcon() {
  return `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M1.5 4a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .8.4l1.2 1.6h4.4a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="currentColor" opacity="0.85"/></svg>`;
}

const expandedFolders = new Set(['']);

function renderTree() {
  const host = $('#folder-tree');
  host.innerHTML = '';
  const allRow = document.createElement('div');
  allRow.className = 'ft-row' + (state.folder === '' && !state.today ? ' selected' : '');
  allRow.innerHTML = `<span class="ft-disc leaf">›</span><span class="ft-icon">${folderIcon()}</span><span class="ft-name">All Notes</span>`;
  allRow.onclick = () => selectFolder('', 'All Notes');
  allRow.oncontextmenu = (e) => { e.preventDefault(); };
  host.appendChild(allRow);

  const todayRow = document.createElement('div');
  todayRow.className = 'ft-row' + (state.today ? ' selected' : '');
  todayRow.innerHTML = `<span class="ft-disc leaf">›</span><span class="ft-icon">${folderIcon()}</span><span class="ft-name">Today</span>`;
  todayRow.onclick = () => openToday();
  todayRow.oncontextmenu = (e) => { e.preventDefault(); };
  host.appendChild(todayRow);

  const build = (folders, parent) => {
    for (const f of folders) {
      const node = document.createElement('div');
      node.className = 'ft-node';
      node.dataset.path = f.path;
      const hasKids = f.children.length > 0;
      const open = expandedFolders.has(f.path);
      const row = document.createElement('div');
      row.className = 'ft-row' + (state.folder === f.path ? ' selected' : '');
      row.draggable = true;
      row.innerHTML = `<span class="ft-disc${open ? ' open' : ''}${hasKids ? '' : ' leaf'}">›</span><span class="ft-icon">${folderIcon()}</span><span class="ft-name">${escHtml(f.name)}</span>`;
      row.onclick = (e) => {
        if (e.target.classList.contains('ft-disc') && hasKids) {
          open ? expandedFolders.delete(f.path) : expandedFolders.add(f.path);
          renderTree();
          return;
        }
        selectFolder(f.path, f.name);
      };
      row.ondblclick = () => { if (hasKids) { expandedFolders.has(f.path) ? expandedFolders.delete(f.path) : expandedFolders.add(f.path); renderTree(); } };
      row.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e.clientX, e.clientY, folderMenu(f)); };
      addLongPress(row, (x, y) => showCtxMenu(x, y, folderMenu(f)));
      attachDrop(row, f.path, 'folder');
      attachDrag(row, { kind: 'folder', path: f.path });
      node.appendChild(row);
      if (hasKids && open) {
        const kids = document.createElement('div');
        kids.className = 'ft-children';
        build(f.children, kids);
        node.appendChild(kids);
      }
      parent.appendChild(node);
    }
  };
  build(state.tree, host);
}

async function loadTree() {
  const { folders } = await api('/api/tree');
  state.tree = folders;
  renderTree();
}

async function selectFolder(path, name) {
  state.folder = path;
  state.folderName = name;
  state.today = false;
  state.todayData = null;
  renderBreadcrumb();
  document.body.classList.remove('sidebar-open');
  closeNote();
  await loadNotes();
  renderTree();
}

/* ---------------- notes list ---------------- */

async function loadNotes() {
  // One choke point: in Today mode every list refresh re-renders Today
  // instead of swapping the pane back to folder notes.
  if (state.today) return loadToday();
  const q = `/api/notes?folder=${encodeURIComponent(state.folder)}&recursive=1&snippet=1`;
  const { notes } = await api(q);
  state.notes = notes;
  renderNotes();
}

/* ---------------- Today task view ---------------- */
// Open tasks grouped by folder, then file — both levels collapsible
// (native <details>). Read-only rows: clicking one opens the note.
// The view refreshes on entry, not live on save.

async function openToday() {
  state.today = true;
  state.folder = ''; // no folder context in Today mode; New note lands at root
  document.body.classList.remove('sidebar-open');
  closeNote();
  await loadToday();
  renderTree();
}

async function loadToday() {
  try {
    const data = await api('/api/today');
    state.todayData = data;
    renderToday(data);
  } catch (e) { toast(e.message); }
}

function renderToday(data) {
  const host = $('#note-list');
  $('#list-title').textContent = 'Today';
  host.innerHTML = '';
  if (!data.open.length && !data.wrapped.length) {
    host.innerHTML = '<div class="list-empty">No tasks on your plate.<br>Enjoy the clear desk.</div>';
    return;
  }
  if (data.open.length) {
    const head = document.createElement('div');
    head.className = 'today-head';
    head.textContent = 'Still open';
    host.appendChild(head);
    for (const group of data.open) {
      const folderEl = document.createElement('details');
      folderEl.className = 'today-folder';
      folderEl.open = true;
      const fSum = document.createElement('summary');
      fSum.textContent = group.folder === '' ? 'Top level' : group.folder;
      folderEl.appendChild(fSum);
      for (const f of group.files) {
        const fileEl = document.createElement('details');
        fileEl.className = 'today-file';
        fileEl.open = true;
        const nSum = document.createElement('summary');
        nSum.textContent = `${f.name} · ${f.done} of ${f.total} done`;
        fileEl.appendChild(nSum);
        for (const t of f.open) {
          const row = document.createElement('div');
          row.className = 'today-task';
          row.textContent = t;
          row.onclick = () => openNote(f.path);
          fileEl.appendChild(row);
        }
        folderEl.appendChild(fileEl);
      }
      host.appendChild(folderEl);
    }
  }
  if (data.wrapped.length) {
    const head = document.createElement('div');
    head.className = 'today-head';
    head.textContent = 'Wrapped up';
    host.appendChild(head);
    for (const f of data.wrapped) {
      const row = document.createElement('div');
      row.className = 'today-wrapped';
      row.textContent = `${f.name} · all ${f.total} done`;
      row.onclick = () => openNote(f.path);
      host.appendChild(row);
    }
  }
}

/** Breadcrumb for the selected folder: All Notes / A / B, segments clickable. */
function renderBreadcrumb() {
  const host = $('#list-title');
  host.innerHTML = '';
  const segs = state.folder ? state.folder.split('/') : [];
  const mk = (label, path, last) => {
    const b = document.createElement('button');
    b.className = 'crumb' + (last ? ' current' : '');
    b.textContent = label;
    if (!last) b.onclick = () => selectFolder(path, label);
    else b.setAttribute('aria-current', 'true');
    return b;
  };
  host.appendChild(mk('All Notes', '', segs.length === 0));
  segs.forEach((s, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    host.appendChild(sep);
    const path = segs.slice(0, i + 1).join('/');
    host.appendChild(mk(s, path, i === segs.length - 1));
  });
}

/** Subfolder of a note relative to the selected folder ('' when directly inside). */
function noteSub(n) {
  const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
  if (!state.folder) return dir;
  return dir === state.folder ? '' : dir.slice(state.folder.length + 1);
}

function renderNotes() {
  const host = $('#note-list');
  host.innerHTML = '';
  if (!state.notes.length) {
    host.innerHTML = '<div class="list-empty">No notes here yet.<br>Press <b>Note</b> to create one.</div>';
    return;
  }
  for (const n of state.notes) {
    const el = document.createElement('div');
    el.className = 'note-item' + (state.note && state.note.path === n.path ? ' selected' : '');
    el.dataset.path = n.path;
    const sub = noteSub(n);
    el.innerHTML = `
      <div class="ni-title">${escHtml(n.name)}<span class="ni-ext">${n.ext.replace('.', '')}</span></div>
      ${sub ? `<div class="ni-sub">${escHtml(sub)}</div>` : ''}
      <div class="ni-meta">${fmtDate(n.mtime)}</div>
      ${n.ext !== '.pdf' && n.snippet ? `<div class="ni-snippet">${escHtml(n.snippet)}</div>` : n.ext === '.pdf' ? `<div class="ni-snippet">PDF document</div>` : ''}`;
    el.onclick = () => openNote(n.path);
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e.clientX, e.clientY, noteMenu(n)); };
    addLongPress(el, (x, y) => showCtxMenu(x, y, noteMenu(n)));
    el.draggable = true;
    attachDrag(el, { kind: 'note', path: n.path });
    host.appendChild(el);
  }
}

/* ---------------- editor ---------------- */

function setDirty(d) {
  if (!state.note) return;
  state.note.dirty = d;
  $('#save-state').textContent = d ? 'Edited' : '';
}

function scheduleSave() {
  setDirty(true);
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNote, 1200);
}

async function saveNote() {
  if (!state.note || !state.note.dirty || state.note.ext === '.pdf') return;
  clearTimeout(state.saveTimer);
  try {
    const { mtime } = await api('/api/file', {
      method: 'PUT',
      body: JSON.stringify({ path: state.note.path, content: $('#editor-text').value }),
    });
    state.note.content = $('#editor-text').value;
    state.note.mtime = mtime;
    setDirty(false);
    // refresh the list row's mtime/snippet without full reload
    // (in Today mode the pane shows tasks, not notes — leave it alone)
    const row = state.notes.find((n) => n.path === state.note.path);
    if (row && !state.today) { row.mtime = mtime; row.snippet = state.note.content.replace(/\s+/g, ' ').trim().slice(0, 140); renderNotes(); }
  } catch (e) {
    toast('Save failed: ' + e.message);
  }
}

async function openNote(path) {
  await saveNote(); // flush previous
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  $('#editor-empty').classList.add('hidden');
  $('#editor-main').classList.remove('hidden');
  $('#editor-text').classList.add('hidden');
  $('#editor-preview').classList.add('hidden');
  $('#editor-pdf').classList.add('hidden');
  $('#md-seg').style.display = ext === '.md' ? '' : 'none';

  const name = path.slice(path.lastIndexOf('/') + 1);
  renderCrumb();

  if (ext === '.pdf') {
    state.note = { path, ext, content: null, dirty: false };
    $('#editbar').classList.add('hidden');
    $('#editor-pdf').classList.remove('hidden');
    $('#editor-pdf').innerHTML = `
      <div class="pdf-bar"><span>${escHtml(name)}</span>
        <a href="/raw/${encodeURIComponent(path)}" download style="margin-left:auto;color:var(--accent);font-size:13px;">Download</a>
      </div>
      <embed src="/raw/${encodeURIComponent(path)}" type="application/pdf">`;
  } else {
    const { content, mtime } = await api(`/api/file?path=${encodeURIComponent(path)}`);
    state.note = { path, ext, content, dirty: false, mtime };
    if (ext === '.md' && state.mdMode === 'preview') showPreview();
    else showEdit();
  }
  if (state.today && state.todayData) renderToday(state.todayData);
  else renderNotes();
  fetchRelated(path);
  if (window.innerWidth <= 700) document.body.classList.add('note-open');
}

function showEdit() {
  $('#editor-text').classList.remove('hidden');
  $('#editor-preview').classList.add('hidden');
  $('#editbar').classList.remove('hidden');
  $('#editor-text').value = state.note.content;
  $$('#md-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'edit'));
}

function showPreview() {
  $('#editor-text').classList.add('hidden');
  $('#editbar').classList.add('hidden');
  const pv = $('#editor-preview');
  pv.classList.remove('hidden');
  pv.innerHTML = renderMarkdown($('#editor-text').value || state.note.content);
  renderMermaid();
  // preview is the reading mode — refresh related notes with saved content
  if (state.note) fetchRelated(state.note.path);
  $$('#md-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'preview'));
}

/* ---------------- related notes (abba's mind.ts, repurposed) ---------------- */

async function fetchRelated(path) {
  const box = $('#related');
  if (!box) return;
  try {
    const { related } = await api(`/api/related?path=${encodeURIComponent(path)}`);
    if (!state.note || state.note.path !== path) return; // user moved on
    if (!related.length) { box.classList.add('hidden'); return; }
    const list = $('#related-list');
    list.innerHTML = '';
    for (const r of related) {
      const row = document.createElement('div');
      row.className = 'related-row';
      const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
      row.innerHTML = `<span class="related-name">${escHtml(r.name)}</span>${dir ? `<span class="related-sub">${escHtml(dir)}</span>` : ''}`;
      row.onclick = () => openNote(r.path);
      list.appendChild(row);
    }
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

/* ---------------- mermaid (same pattern as abba) ---------------- */
/* ```mermaid blocks arrive as <pre class="mermaid"> from renderMarkdown.
   The vendored bundle (public/vendor/mermaid.min.js, 11.4.1, served locally
   — no CDN, works offline) loads lazily, only when a diagram is present,
   and only once. strict mode keeps diagram code from injecting HTML;
   a bad diagram shows Mermaid's own error card and the source stays
   readable. Folio is light-only, so a single light theme set is enough. */
let mermaidLoading = null;
function renderMermaid() {
  if (!document.querySelector('pre.mermaid:not([data-mermaid])')) return;
  const run = () => {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          background: 'transparent',
          primaryColor: '#ffffff', primaryTextColor: '#1d1d1f', primaryBorderColor: '#007aff',
          lineColor: '#007aff', secondaryColor: '#f5f5f7', tertiaryColor: '#ffffff',
          edgeLabelBackground: '#ffffff',
        },
        flowchart: { curve: 'basis' },
      });
      const ran = window.mermaid.run({ querySelector: 'pre.mermaid:not([data-mermaid])' });
      if (ran && ran.catch) ran.catch(() => {});
      document.querySelectorAll('pre.mermaid:not([data-mermaid])').forEach((el) => el.setAttribute('data-mermaid', '1'));
    } catch (e) { /* leave the source readable */ }
  };
  if (window.mermaid) { run(); return; }
  if (!mermaidLoading) {
    mermaidLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid.min.js?v=11.4.1';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    mermaidLoading.then(run, () => {});
  } else {
    mermaidLoading.then(run, () => {});
  }
}

function closeNote() {
  state.note = null;
  $('#editor-main').classList.add('hidden');
  $('#editor-empty').classList.remove('hidden');
  document.body.classList.remove('note-open');
}

/* The open note's file name, shown in the editor bar crumb: the folder
   part stays static, the file name itself is clickable and edits in place
   (Enter commits via /api/rename, Esc or blur cancels). */
function renderCrumb() {
  if (!state.note) return;
  const path = state.note.path;
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  $('#crumb').innerHTML = `${dir ? `<span class="dim">${escHtml(dir)} / </span>` : ''}<span id="crumb-name" class="crumb-name" title="Click to rename">${escHtml(name)}</span>`;
}

function startCrumbRename() {
  if (!state.note) return;
  const nameEl = $('#crumb-name');
  if (!nameEl || $('#crumb-input')) return;
  const oldName = state.note.path.slice(state.note.path.lastIndexOf('/') + 1);
  const input = document.createElement('input');
  input.id = 'crumb-input';
  input.className = 'crumb-input';
  input.value = oldName;
  input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const cancel = () => { if (done) return; done = true; renderCrumb(); };
  const commit = async () => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (!name || name === oldName) { renderCrumb(); return; }
    try {
      await saveNote(); // flush edits to the old path first
      const { path } = await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: state.note.path, name }) });
      state.note.path = path;
      await loadNotes();
      renderCrumb();
      // a renamed PDF must point its viewer at the new path, not the old one
      const pdfBar = document.querySelector('#editor-pdf .pdf-bar');
      if (pdfBar) {
        const span = pdfBar.querySelector('span');
        if (span) span.textContent = path.slice(path.lastIndexOf('/') + 1);
        const dl = pdfBar.querySelector('a');
        if (dl) dl.href = `/raw/${encodeURIComponent(path)}`;
        const embed = document.querySelector('#editor-pdf embed');
        if (embed) embed.src = `/raw/${encodeURIComponent(path)}`;
      }
    } catch (e) { toast(e.message); renderCrumb(); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', cancel);
}

$('#crumb').addEventListener('click', (e) => {
  if (e.target.closest('#crumb-name')) startCrumbRename();
});

$$('#md-seg button').forEach((b) => {
  b.onclick = async () => {
    if (!state.note || state.note.ext !== '.md') return;
    await saveNote();
    state.mdMode = b.dataset.mode;
    state.mdMode === 'preview' ? showPreview() : showEdit();
  };
});

$('#editor-text').addEventListener('input', scheduleSave);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    if (state.note) { e.preventDefault(); saveNote(); }
  }
});

/* ---------------- markdown edit bar ---------------- */
// One delegated handler: pure ops live in src/editbar.js, this just applies
// the result to the textarea and schedules a save.
$('#editbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || !state.note || state.note.ext === '.pdf') return;
  const ta = $('#editor-text');
  const { value, selectionStart: s, selectionEnd: en } = ta;
  let r;
  switch (btn.dataset.act) {
    case 'bold': r = wrapSelection(value, s, en, '**', '**', 'bold text'); break;
    case 'italic': r = wrapSelection(value, s, en, '*', '*', 'italic text'); break;
    case 'heading': r = prefixLines(value, s, en, '## ', /^#{1,6}\s+/); break;
    case 'quote': r = prefixLines(value, s, en, '> ', /^>\s?/); break;
    case 'bullet': r = prefixLines(value, s, en, '- ', /^[-*+]\s+/); break;
    case 'numbered': r = numberLines(value, s, en); break;
    case 'task': r = prefixLines(value, s, en, '- [ ] ', /^-\s\[[ xX]\]\s+/); break;
    case 'code': r = wrapSelection(value, s, en, '`', '`', 'code'); break;
    case 'table': r = insertTable(value, s, en); break;
    case 'details': r = insertDetails(value, s, en); break;
    case 'link': {
      if (s === en) r = wrapSelection(value, s, en, '[', '](https://)', 'text');
      else {
        const wrapped = '[' + value.slice(s, en) + '](https://)';
        const urlAt = s + 1 + (en - s) + 2;
        r = { value: value.slice(0, s) + wrapped + value.slice(en), start: urlAt, end: urlAt + 8 };
      }
      break;
    }
    default: return;
  }
  ta.value = r.value;
  ta.setSelectionRange(r.start, r.end);
  ta.focus();
  scheduleSave();
});

/* ---------------- create / rename / delete / move ---------------- */

function promptModal(title, initial, okLabel) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-input').value = initial || '';
    $('#modal-ok').textContent = okLabel || 'OK';
    $('#modal-overlay').classList.remove('hidden');
    const input = $('#modal-input');
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const done = (v) => {
      $('#modal-overlay').classList.add('hidden');
      $('#modal-ok').onclick = $('#modal-cancel').onclick = null;
      resolve(v);
    };
    $('#modal-ok').onclick = () => done(input.value.trim());
    $('#modal-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    };
  });
}

$('#btn-new-note').onclick = async () => {
  const folder = state.folder;
  let base = 'Untitled', i = 0, name;
  const existing = new Set(state.notes.map((n) => n.name.toLowerCase()));
  do { i++; name = i === 1 ? `${base}.md` : `${base} ${i}.md`; } while (existing.has(name.toLowerCase()));
  const path = folder ? `${folder}/${name}` : name;
  try {
    await api('/api/file', { method: 'POST', body: JSON.stringify({ path, content: `# ${base}\n\n` }) });
    await loadTree(); await loadNotes();
    openNote(path);
    // focus editor for immediate typing
    setTimeout(() => $('#editor-text').focus(), 60);
  } catch (e) { toast(e.message); }
};

async function createFolder() {
  const name = await promptModal('New folder', '', 'Create');
  if (!name) return;
  const parent = state.folder;
  const path = parent ? `${parent}/${name}` : name;
  try {
    await api('/api/folder', { method: 'POST', body: JSON.stringify({ path }) });
    expandedFolders.add(path);
    await loadTree();
    selectFolder(path, name);
  } catch (e) { toast(e.message); }
}

/* vault switching: native OS dialog when available, manual path fallback */
async function loadVaultInfo() {
  try {
    const { path } = await api('/api/vault/info');
    const el = $('#vault-path');
    if (el) { el.textContent = path; el.title = path; }
  } catch { /* tree still loads; path display is cosmetic */ }
}

async function switchVault(path) {
  state.folder = ''; state.folderName = 'All Notes'; state.note = null;
  await loadTree();
  await selectFolder('', 'All Notes');
  await loadVaultInfo();
  toast('Vault: ' + path);
}

async function openVaultDialog() {
  let current = '';
  try { current = (await api('/api/vault/info')).path || ''; } catch (e) { toast(e.message); return; }
  let r;
  try {
    r = await api('/api/vault/browse', { method: 'POST' });
  } catch (e) { toast(e.message); return; }
  if (r.cancelled) return;                       // user dismissed the OS dialog
  if (r.path) { await switchVault(r.path); return; }
  // no native dialog on this machine → manual path entry
  const manual = await promptModal('Vault folder', current, 'Use folder');
  if (!manual) return;
  try {
    const s = await api('/api/vault/set', { method: 'POST', body: JSON.stringify({ path: manual }) });
    await switchVault(s.path);
  } catch (e) { toast(e.message); }
}

$('#btn-new-folder').onclick = (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  showCtxMenu(rect.left, rect.bottom + 6, [
    { label: 'Open vault…', fn: openVaultDialog },
    { label: 'New folder', fn: createFolder },
  ]);
};

function folderMenu(f) {
  return [
    { label: 'New note here', fn: async () => { await selectFolder(f.path, f.name); $('#btn-new-note').click(); } },
    { label: 'New subfolder', fn: async () => {
      const name = await promptModal('New subfolder', '', 'Create');
      if (!name) return;
      try { await api('/api/folder', { method: 'POST', body: JSON.stringify({ path: `${f.path}/${name}` }) }); expandedFolders.add(f.path); await loadTree(); }
      catch (e) { toast(e.message); }
    } },
    { label: 'Rename', fn: async () => {
      const name = await promptModal('Rename folder', f.name, 'Rename');
      if (!name || name === f.name) return;
      try { await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: f.path, name }) }); await loadTree(); if (state.folder === f.path) selectFolder(f.path.slice(0, f.path.lastIndexOf('/')) === '' ? '' : f.path.slice(0, f.path.lastIndexOf('/')), name); }
      catch (e) { toast(e.message); }
    } },
    { sep: true },
    { label: 'Delete folder', danger: true, fn: async () => {
      if (!confirm(`Delete "${f.name}" and everything inside it?`)) return;
      try {
        await api('/api/delete', { method: 'POST', body: JSON.stringify({ path: f.path }) });
        await loadTree();
        if (state.folder === f.path || state.folder.startsWith(f.path + '/')) selectFolder('', 'All Notes');
        else await loadNotes();
      } catch (e) { toast(e.message); }
    } },
  ];
}

function noteMenu(n) {
  return [
    { label: 'Open', fn: () => openNote(n.path) },
    { label: 'Rename', fn: async () => {
      const name = await promptModal('Rename note', n.name, 'Rename');
      if (!name || name === n.name) return;
      try {
        const { path } = await api('/api/rename', { method: 'POST', body: JSON.stringify({ path: n.path, name }) });
        await loadNotes();
        if (state.note && state.note.path === n.path) openNote(path);
      } catch (e) { toast(e.message); }
    } },
    { label: 'Move to…', fn: async () => {
      const dest = await promptModal('Move to folder (blank = vault root)', state.folder, 'Move');
      if (dest === null) return;
      try {
        const { path } = await api('/api/move', { method: 'POST', body: JSON.stringify({ path: n.path, dest }) });
        await loadNotes();
        if (state.note && state.note.path === n.path) openNote(path);
      } catch (e) { toast(e.message); }
    } },
    { sep: true },
    { label: 'Delete note', danger: true, fn: async () => {
      if (!confirm(`Delete "${n.name}"?`)) return;
      try {
        await api('/api/delete', { method: 'POST', body: JSON.stringify({ path: n.path }) });
        if (state.note && state.note.path === n.path) closeNote();
        await loadNotes();
      } catch (e) { toast(e.message); }
    } },
  ];
}

/* context menu */
let ctxCleanup = null;
function showCtxMenu(x, y, items) {
  hideCtxMenu();
  const m = $('#ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.onclick = () => { hideCtxMenu(); it.fn(); };
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  // .ctxmenu is positioned inside .window → convert viewport coords
  const wr = $('#window').getBoundingClientRect();
  const place = (x, y) => {
    const rr = m.getBoundingClientRect();
    m.style.left = Math.min(x - wr.left, wr.width - rr.width - 8) + 'px';
    m.style.top = Math.min(y - wr.top, wr.height - rr.height - 8) + 'px';
  };
  place(x, y);
  requestAnimationFrame(() => place(x, y));
  const close = (e) => { if (!m.contains(e.target)) hideCtxMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', close), 10);
  ctxCleanup = () => document.removeEventListener('pointerdown', close);
}
function hideCtxMenu() {
  $('#ctxmenu').classList.add('hidden');
  if (ctxCleanup) { ctxCleanup(); ctxCleanup = null; }
}

/* long-press → context menu (touch) */
function addLongPress(el, fn) {
  let t = null, fired = false;
  el.addEventListener('touchstart', (e) => {
    fired = false;
    t = setTimeout(() => {
      fired = true;
      const touch = e.touches[0];
      fn(touch.clientX, touch.clientY);
    }, 550);
  }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(t));
  el.addEventListener('touchmove', () => clearTimeout(t));
  // swallow the tap that follows a long-press so it doesn't also open the note
  el.addEventListener('click', (e) => {
    if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; }
  }, true);
}

/* drag & drop move */
function attachDrag(el, payload) {
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-folio', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
}
function attachDrop(el, destFolder, kind) {
  el.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('application/x-folio')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('dragover');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('application/x-folio')); } catch { return; }
    if (payload.path === destFolder) return;
    try {
      const { path } = await api('/api/move', { method: 'POST', body: JSON.stringify({ path: payload.path, dest: destFolder }) });
      toast(`Moved to ${destFolder || 'vault root'}`);
      await loadTree(); await loadNotes();
      if (state.note && state.note.path === payload.path) openNote(path);
    } catch (err) { toast(err.message); }
  });
}

/* ---------------- search palette ---------------- */

let searchTimer = null;
let searchActive = -1;

function openSearch() {
  $('#search-overlay').classList.remove('hidden');
  $('#search-input').value = '';
  $('#search-results').innerHTML = '';
  searchActive = -1;
  setTimeout(() => $('#search-input').focus(), 30);
}
function closeSearch() {
  $('#search-overlay').classList.add('hidden');
}

function highlight(text, q) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  let out = escHtml(text);
  for (const t of terms) {
    const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

async function runSearch(q) {
  const host = $('#search-results');
  if (q.trim().length < 2) { host.innerHTML = ''; return; }
  const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  host.innerHTML = '';
  searchActive = -1;
  if (!results.length) { host.innerHTML = '<div class="list-empty">No matches.</div>'; return; }
  results.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'pr-item';
    el.innerHTML = `<div class="pr-title">${highlight(r.name, q)}</div>
      <div class="pr-path">${escHtml(r.path)}</div>
      <div class="pr-snippet">${highlight(r.snippet, q)}</div>`;
    el.onclick = () => { closeSearch(); openNote(r.path); };
    el.onmousemove = () => {
      $$('.pr-item').forEach((x) => x.classList.remove('active'));
      el.classList.add('active'); searchActive = i;
    };
    host.appendChild(el);
  });
}

$('#btn-search').onclick = openSearch;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 160);
});
$('#search-input').addEventListener('keydown', (e) => {
  const items = $$('.pr-item');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchActive = e.key === 'ArrowDown'
      ? Math.min(searchActive + 1, items.length - 1)
      : Math.max(searchActive - 1, 0);
    items.forEach((x, i) => x.classList.toggle('active', i === searchActive));
    items[searchActive]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && items[searchActive]) {
    items[searchActive].click();
  } else if (e.key === 'Escape') closeSearch();
});
$('#search-overlay').addEventListener('pointerdown', (e) => {
  if (e.target.id === 'search-overlay') closeSearch();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  else if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
  else if (e.key === 'Escape') { closeSearch(); closeSync(); hideCtxMenu(); }
});

/* ---------------- sync panel ---------------- */

function fmtTime(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function loadSyncStatus() {
  const s = await api('/api/sync/status');
  const host = $('#sync-status');
  const dot = s.available ? 'ok' : 'idle';
  const line = s.available
    ? `Configured as <b>${escHtml(s.connectedAs || '')}</b> · remote folder <b>${escHtml(s.remoteFolder)}</b>`
    : escHtml(s.reason);
  host.innerHTML = `
    <div class="sync-card">
      <div class="sc-top"><span class="dot ${dot}"></span>OpenDrive.com</div>
      <div class="sc-sub">${line}</div>
      <div class="sc-sub">Last sync: <b>${s.lastRun ? fmtTime(s.lastRun.at) : 'never'}</b></div>
    </div>`;
  renderLastRun(s.lastRun);
  // prefill (never the password — the server never sends it back)
  const cur = await api('/api/settings').catch(() => null);
  if (cur) {
    $('#set-folder').value = cur.opendrive.remoteFolder || '/Folio';
    $('#set-username').placeholder = cur.opendrive.configured
      ? `Connected as ${cur.opendrive.username} — enter a new name to change`
      : 'you@example.com';
  }
}

function renderLastRun(r) {
  const host = $('#sync-result');
  if (!r) { host.innerHTML = ''; return; }
  const dot = r.ok ? 'ok' : 'bad';
  let html = `<div><span class="dot ${dot}"></span> <b>${fmtTime(r.at)}</b> — ${escHtml(r.note || '')}</div>`;
  if (r.uploaded && r.uploaded.length) html += `<div>↑ uploaded: ${r.uploaded.map(escHtml).join(', ')}</div>`;
  if (r.downloaded && r.downloaded.length) html += `<div>↓ downloaded: ${r.downloaded.map(escHtml).join(', ')}</div>`;
  if (r.conflicts && r.conflicts.length) {
    html += `<div>⚠ conflicts (kept both): ${r.conflicts.map((c) => `${escHtml(c.path)} → ${escHtml(c.copy)}`).join('; ')}</div>`;
  }
  if (r.errors && r.errors.length) {
    html += `<div class="err">errors: ${r.errors.map(escHtml).join('; ')}</div>`;
  }
  host.innerHTML = html;
}

function openSync() {
  $('#sync-overlay').classList.remove('hidden');
  loadSyncStatus().catch((e) => toast('Sync status failed: ' + e.message));
}
function closeSync() { $('#sync-overlay').classList.add('hidden'); }

$('#btn-sync').onclick = openSync;
$('#btn-sync-close').onclick = closeSync;
$('#sync-overlay').addEventListener('pointerdown', (e) => {
  if (e.target.id === 'sync-overlay') closeSync();
});

$('#btn-sync-save').onclick = async () => {
  const body = {};
  const u = $('#set-username').value.trim();
  const p = $('#set-password').value;
  const f = $('#set-folder').value.trim();
  if (u) body.username = u;
  if (p) body.password = p; // empty = keep existing
  if (f) body.remoteFolder = f;
  try {
    const { opendrive } = await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    $('#set-password').value = '';
    toast(opendrive.configured ? `Saved — connected as ${opendrive.username}` : 'Saved');
    loadSyncStatus();
  } catch (e) { toast('Save failed: ' + e.message); }
};

$('#btn-sync-disconnect').onclick = async () => {
  if (!confirm('Remove the stored OpenDrive credentials from this machine?')) return;
  await api('/api/settings/disconnect', { method: 'POST' });
  $('#set-username').value = ''; $('#set-password').value = '';
  toast('Disconnected');
  loadSyncStatus();
};

$('#btn-sync-test').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Testing…';
  try {
    const r = await api('/api/sync/test', { method: 'POST' });
    toast(r.ok ? `Connection OK — hello, ${r.user}` : `Failed: ${r.error}`);
  } catch (err) { toast('Test failed: ' + err.message); }
  btn.disabled = false;
  btn.textContent = 'Test connection';
};

$('#btn-sync-now').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  $('#sync-result').innerHTML = '<div>Working…</div>';
  try {
    const { result } = await api('/api/sync/run', { method: 'POST' });
    renderLastRun(result);
    if (result.down > 0 || result.conflicts.length) { await loadTree(); await loadNotes(); }
    toast(result.ok ? 'Sync finished' : 'Sync finished with errors');
  } catch (err) {
    $('#sync-result').innerHTML = `<div class="err">sync failed: ${escHtml(err.message)}</div>`;
  }
  btn.disabled = false;
  btn.textContent = 'Sync now';
};

/* ---------------- responsive chrome ---------------- */

$('#btn-sidebar').onclick = () => {
  // narrow: slide-over drawer (sidebar-open). wide: collapse the pane.
  const narrow = window.matchMedia('(max-width: 1020px)').matches;
  if (narrow) {
    document.body.classList.remove('sidebar-collapsed');
    document.body.classList.toggle('sidebar-open');
  } else {
    document.body.classList.remove('sidebar-open');
    document.body.classList.toggle('sidebar-collapsed');
  }
};
$('#scrim').onclick = () => document.body.classList.remove('sidebar-open', 'sidebar-collapsed');
$('#btn-back-folders').onclick = () => document.body.classList.remove('sidebar-open', 'sidebar-collapsed');
$('#btn-back-list').onclick = () => document.body.classList.remove('sidebar-open', 'sidebar-collapsed');
$('#btn-back-editor').onclick = () => { saveNote(); document.body.classList.remove('note-open'); };

/* ---------------- boot ---------------- */

(async function boot() {
  try {
    await loadTree();
    await selectFolder('', 'All Notes');
    await loadVaultInfo();
  } catch (e) {
    toast('Failed to load vault: ' + e.message);
  }
})();
