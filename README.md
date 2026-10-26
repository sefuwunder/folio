# Folio

A macOS-inspired notes editor and organizer. Three panes — folders, notes, editor — for a local vault of **markdown**, **plain text**, and **PDFs**, with full-text search and manual sync to [OpenDrive.com](https://www.opendrive.com).

Bun + zero npm dependencies. Binds `127.0.0.1:3038`.

## Features

- **macOS design language**: traffic-light titlebar, frosted folder sidebar with disclosure triangles, toolbar (New Note / New Folder / Sync / Search ⌘K), list with title + snippet + modified date, editor pane.
- **Folders**: create, rename, delete (recursive, with confirm), move via drag-and-drop or "Move to…". Nested without limit.
- **Notes**: `.md` with Edit/Preview toggle (built-in zero-dep markdown renderer: headings, bold/italic, lists, task checkboxes, code blocks, links, blockquotes), `.txt` plain editing, `.pdf` viewed in-place via the browser's native PDF viewer. Autosave (debounced) + ⌘S.
- **Search**: ⌘K / Ctrl+K or `/` — full-text across titles and content, ranked (title hits first), with highlighted snippets.
- **Tag explorer**: the Tags button opens a node graph on a zoomable canvas — tags and notes as nodes, edges for "note carries tag". Hashtags stay implicit everywhere else: nothing is shown inline in notes and nothing is written back into files. Tags are read from `#words` in note bodies (headings, URL fragments, and code are not tags). Drag to pan, scroll to zoom, click a tag to isolate its notes, click a note to open it, Esc to close.
- **Vault switching**: the toolbar Folder button offers "Open vault…" (pops a real native OS folder dialog — zenity, then kdialog — on your machine, with a manual-path fallback) and "New folder". The chosen folder is validated (must exist, be a readable/writable directory) and remembered across restarts; the current path shows under "Library" in the sidebar.
- **Sync with OpenDrive.com**: manual "Sync now" only. Compares local vault vs the remote folder by path, size, and mtime (manifest-tracked); uploads new/changed local files, downloads new/changed remote files. **Conflicts keep both** — the remote version is saved locally with a ` (conflict)` suffix, never silently overwritten. **Deletes are not propagated** (v1 safety rule). The panel always reports the real last result: uploaded N, downloaded M, named conflicts, errors with messages, timestamp.
- **Responsive**: desktop three-pane; tablet/narrow gets a slide-over sidebar; phone gets single-pane navigation with back buttons. Touch targets ≥44px on coarse pointers.

## Pickup

```sh
cd ~/workspace/your_files/folio
bun src/server.ts
# → http://127.0.0.1:3038
```

Env vars: `PORT` (default 3038), `HOST` (default 127.0.0.1), `FOLIO_VAULT` (default `~/workspace/your_files/folio/vault`), `FOLIO_DATA` (default `~/workspace/your_files/folio/data` — sync settings, manifest, last-run record).

## Sync setup

1. Open **Sync** in the toolbar.
2. Enter your OpenDrive.com **username** and **password** (stored server-side in the data dir; the browser only ever sees "Connected as u…" — never the password), and the remote folder (default `/Folio`, created if missing).
3. **Test connection**, then **Sync now**.

The API surface used (base `https://dev.opendrive.com/api/v1`, endpoints verified against rclone's production `opendrive` backend and the official REST API Guide v1.2.0): session login (`POST /session/login.json` with `{username, passwd}`), folder create/list (`POST /folder.json`, `GET /folder/list.json/{session}/{folder}`), chunked upload (`/upload/create_file.json` with `open_if_exists=1` → `/upload/upload_file_chunk2.json/{session}/{file}?temp_location=&chunk_offset=&chunk_size=` → `/upload/close_file_upload.json` with `file_time`, then `PUT /file/filesettings.json` to pin the mtime), download (`GET /download/file.json/{id}?session_id=`). `RequireHashOnly=1` on create means the bytes are already server-side, so chunks are skipped. Sessions are cached in memory and re-logged-in transparently on 401 ("Session does not exist, please re-login."); 429/423/5xx back off and retry without re-login.

## Honest limitations

- **Sync is manual** — no background/auto sync in v1.
- **Deletes are not propagated.** Delete a file locally and it stays on OpenDrive (and won't be resurrected or re-uploaded); delete it remotely and the local copy stays. This is deliberate: silent cross-device deletion is the dangerous operation, so v1 refuses to do it. (If delete support is ever added, OpenDrive's semantics are trash-first: `POST /file/trash.json`, permanent via `DELETE /file.json/{session}/{file}`, restore via `POST /file/restore.json`.)
- **Conflicts are kept, not merged.** You get both copies; you decide.
- **Folders list at most ~100 entries per page** on the API side and Folio v1 does not paginate folder listings — vaults with more than ~100 files in a single folder will not fully sync. (Nested folders are each listed separately, so deep trees are fine.)
- **2FA / captcha:** if your OpenDrive account has 2FA pending verification, or repeated failed logins trigger a captcha, sync reports that honestly instead of failing cryptically — complete the verification or sign in once at opendrive.com, then retry.
- **No GOA integration.** GNOME Online Accounts has no OpenDrive provider, so it can't supply OpenDrive credentials — username/password in Folio's Settings is the only auth path. (An earlier design explored GOA/Microsoft Graph; it was dropped when the target was clarified as opendrive.com, not Microsoft OneDrive.)
- Filenames: OpenDrive is case-insensitive and forbids `\ / : * ? " < > |` and 4-byte UTF-8 (emoji) in names; avoid `Notes.md` vs `notes.md` collisions.
- PDF text is not indexed by search (binary files are skipped).
- A real OpenDrive account has not been exercised from the build sandbox (no network tunnel there) — first real sync should be watched in the sync panel.
