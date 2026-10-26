# Architecture overview

This page explains how the code is organized, how a request travels from the UI to the storage
engine, how the Phase 1 features (workspaces, nodes, notes, tags, attachments) work, and how the
security baseline from [ADR-0003](adr/0003-electron-version-and-security-baseline.md) is
implemented. It describes the code on branch `phase-1-knowledge-base`; later phases are listed
separately at the end. It is a reviewer-level overview: follow the file references for details.

## Packages and dependency rules

The repository is an npm-workspaces monorepo
([ADR-0001](adr/0001-monorepo-and-module-boundaries.md)).

| Package                   | Responsibility                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/domain`         | IDs, clock, error model, ports, and the rules: node fields, note documents and link policy, labels, attachment file-type policy, timeline sessions, application services |
| `packages/contracts`      | IPC channel names, zod schemas per channel, result envelope, renderer API type                                                                                           |
| `packages/storage-sqlite` | `node:sqlite` connection settings, migration runner, schema, write coordinator, verified backup, repositories                                                            |
| `apps/desktop`            | Electron main process (workspaces, attachment store, IPC services), preload bridge, React renderer, packaging, smoke test                                                |

Application services live in `packages/domain/src/application/` (`workspace-service.ts`,
`knowledge-node-service.ts`, `tag-service.ts`, `attachment-service.ts`). They depend only on ports
(`packages/domain/src/ports/`), so the same services run against SQLite today and could run
against another adapter later. The SQLite implementations of those ports are in
`packages/storage-sqlite/src/repositories/`.

Allowed dependency directions (arrows point at what a package may import):

```
              apps/desktop
     (main, preload, renderer)
          |                |
          v                v
  storage-sqlite       contracts
          \                /
           v              v
               domain
```

Inside `apps/desktop` the three process targets have their own limits:

```
renderer --(window.mmap only)--> preload --(ipcRenderer.invoke)--> main
   |                               |                                 |
   | may import types from         | may import @mmap/contracts/     | may import everything:
   | @mmap/contracts, and pure     | channels and types only         | contracts, storage-sqlite,
   | domain functions              | no Node, SQLite or UI code      | domain, electron, Node
   | no electron, Node, SQLite     |                                 |
```

The renderer imports a few pure functions from `@mmap/domain` (`parseNoteDocument`,
`isSafeLinkHref`) so that the editor applies exactly the same rules as the main process. These
are checks for a fast, accurate UI; the main process repeats them and remains the authority.

The rules are written once in `tooling/architecture-rules.mjs` and enforced twice:

1. `eslint.config.mjs` turns each rule into a `no-restricted-imports` block, so the editor and
   `npm run lint` flag violations immediately.
2. `tests/architecture.test.ts` scans the source files of each restricted directory for static,
   dynamic and `require` imports and fails on any forbidden specifier. An inline
   `eslint-disable` comment cannot silence this test.

Summary of what each restricted directory may not import:

| Directory                     | Forbidden                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/domain/src`         | Electron, UI libraries, database engines, HTTP frameworks, Node built-ins, other `@mmap/*` packages |
| `packages/contracts/src`      | Electron, UI libraries, database engines, HTTP frameworks, Node built-ins, `@mmap/storage-sqlite`   |
| `packages/storage-sqlite/src` | Electron, UI libraries, HTTP frameworks, `@mmap/contracts`                                          |
| `apps/desktop/src/renderer`   | Electron, Node built-ins, database engines, `@mmap/storage-sqlite`                                  |
| `apps/desktop/src/preload`    | Node built-ins, database engines, UI libraries, `@mmap/storage-sqlite`                              |

When you add a package, add its rule to `tooling/architecture-rules.mjs` and its tsconfig to
`TYPE_CHECKED_PROJECTS` in `eslint.config.mjs`.

## Process model

mmap follows Electron's standard three-part model, with the renderer treated as untrusted.

| Part     | Source                      | Runs as                                       | Role                                                                                                                      |
| -------- | --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Main     | `apps/desktop/src/main`     | Node (ESM bundle `out/main/index.js`)         | Composition root, window, security policy, `app://` and `mmap-attachment://` protocols, workspaces, storage, IPC handlers |
| Preload  | `apps/desktop/src/preload`  | Sandboxed, context-isolated (CJS `index.cjs`) | Exposes `window.mmap` with named, typed methods only                                                                      |
| Renderer | `apps/desktop/src/renderer` | Chromium, sandboxed, origin `app://mmap`      | React UI (Tailwind, shadcn/ui, Tiptap, KaTeX); no Node or Electron APIs                                                   |

Build configuration is in `apps/desktop/electron.vite.config.ts`. Every library and every
`@mmap/*` package is bundled, so the packaged app contains no `node_modules`. The preload script is
CommonJS because sandboxed preload scripts cannot be ES modules. All SQLite and file work runs in
the main process; there is no worker thread yet.

Startup order (`apps/desktop/src/main/index.ts`) matters for security:

1. Decide the renderer location and trusted origins (`resolveRendererLocation`).
2. Register `app://` and `mmap-attachment://` as privileged schemes (only allowed before `ready`).
3. Install guards on every future `webContents` (`guardAllWebContents`).
4. Create the `WorkspaceManager` and take Electron's single-instance lock; a second launch
   focuses the existing window.
5. After `ready`: remove the default menu in packaged builds, harden the session, serve the
   renderer from `app://` and image previews from `mmap-attachment://`, open the last workspace
   (`workspaces.startup()`), register IPC handlers, then create the window.

On quit, `before-quit` is delayed until `WorkspaceManager.close()` has flushed queued writes,
checkpointed the WAL and released the workspace lock.

### Current scope (Phase 1)

The renderer (`apps/desktop/src/renderer/src/App.tsx`) shows a workspace gate: while no workspace
is open, `WorkspaceSetupView` explains why and offers create, open and recent workspaces. Once a
workspace is open, the `Workbench` shows the five navigation areas from PRD §6
(`src/renderer/src/navigation.ts`). The `Workbench` is rendered with `key={workspace.id}`, so
switching workspaces discards all view state of the previous one.

- **Library** (`nodes/library-view.tsx`): every node with three sort orders, tag filters,
  "Load more" paging and totals.
- **Node detail panel** (`nodes/node-detail-panel.tsx`): title, summary, tags, rich note,
  attachments, save status, recovery and conflict banners, duplicate and delete.
- **Settings** (`views/settings-view.tsx`): workspace name, location and switching, attachment
  size limit, diagnostics.
- Mind Maps, Knowledge Graph and Timeline show an empty state naming their phase. The search box
  is visible but disabled until Phase 2.

The renderer's top level is wrapped in an error boundary (`components/error-boundary.tsx`).

## Request flow: one IPC call end to end

This is the full path of `app:get-info`, the pattern every channel follows. The other 28 channels
are listed in [ipc-contracts.md](ipc-contracts.md#channel-reference).

1. **Renderer.** `SettingsView` (`src/renderer/src/views/settings-view.tsx`) calls
   `window.mmap.app.getInfo()`. The type of `window.mmap` is `MmapRendererApi` from
   `packages/contracts/src/renderer-api.ts`, declared in `src/renderer/src/env.d.ts`.
2. **Preload.** `src/preload/index.ts` maps that method to
   `ipcRenderer.invoke('app:get-info')`. The channel name comes from
   `packages/contracts/src/channels.ts`; the renderer cannot choose it.
3. **Main, routing.** `src/main/ipc/register-ipc-handlers.ts` registered every channel in
   `IPC_CHANNELS` with `ipcMain.handle`, wrapping its service in `createIpcHandler`.
4. **Sender check.** `createIpcHandler` (`src/main/ipc/ipc-handler.ts`) calls `isTrustedSender`:
   the sender frame must exist, must be the window's main frame (sub-frames are rejected even if
   same-origin), and its URL origin must be in the trusted set. Failure returns
   `FORBIDDEN_SENDER`; the service is never called.
5. **Request validation.** The payload is parsed with the channel's request schema from
   `IPC_CATALOGUE` (`packages/contracts/src/catalogue.ts`). `app:get-info` takes no argument, so
   anything other than `undefined` returns `INVALID_REQUEST`.
6. **Service.** `createAppInfoService` (`src/main/services/app-info-service.ts`) returns
   versions plus `probeStorageCapabilities()` from `packages/storage-sqlite/src/capabilities.ts`.
   For workspace data, a service instead takes the open workspace from `WorkspaceManager.current`
   and calls a domain application service, which runs its writes through the write coordinator.
7. **Response validation.** The result is parsed with the channel's response schema, which uses
   `z.strictObject`, so a service bug cannot leak an extra field. A mismatch is logged and
   returned as `INTERNAL_ERROR`.
8. **Envelope.** The handler resolves with `{ ok: true, data }` or `{ ok: false, error }`. A thrown
   `DomainError` or `WorkspaceError` becomes its code and message; any other error is logged in
   redacted form and returned as `INTERNAL_ERROR` with a generic message.
9. **Renderer again.** `unwrap()` (`src/renderer/src/lib/ipc.ts`) returns the data or throws an
   `IpcFailure`; `SettingsView` renders a table on success or the error message in a
   `role="alert"` paragraph on failure.

## Workspace lifecycle

PRD §5.1 and [ADR-0005](adr/0005-workspace-location-and-supported-filesystems.md). Code:
`apps/desktop/src/main/workspaces/`.

### Folder layout and manifest

`workspace-folder.ts` defines the layout:

```
<workspace>/
  mmap-workspace.json   manifest: format, formatVersion (1), workspaceId, createdAt, createdWithAppVersion
  mmap.sqlite           database (plus -wal and -shm while open)
  attachments/          managed attachment copies (see Attachments)
  recovery/             verified pre-migration backups
  .lock                 process lock while the workspace is open
```

The manifest lets "open folder" tell a workspace from a random directory before touching any
database file, and keeps the workspace's identity when the folder is copied. Its `workspaceId` must
match the `workspaces` row in the database. A new workspace is only created in a folder that does
not exist or is empty; the manifest is written atomically (temporary file plus rename).

New workspaces go to `<userData>/workspaces/<folder name>` (`%APPDATA%\mmap\workspaces` on
Windows) or to a parent folder the user picks in a native dialog. The folder name is derived from
the display name with Windows-safe rules (`toWorkspaceFolderName` in
`packages/domain/src/workspace/workspace-name.ts`); an existing folder is never reused, so
`Name (2)`, `Name (3)` and so on are tried. Renaming a workspace changes only its display name.

### Machine settings

`app-settings.ts` keeps `settings.json` in the Electron profile folder (`userData`), never in a
workspace: the last opened workspace path, up to 10 recent workspaces, and the
`maxAttachmentMegabytes` preference (default 20). Writes are atomic. A damaged settings file is
renamed to `settings.json.damaged-<timestamp>` and defaults are used, so it never stops startup.

### Opening, startup and missing workspaces

`WorkspaceManager` (`workspace-manager.ts`) owns the single open workspace. All its operations are
serialized through a promise queue, so two quick clicks cannot open two workspaces.

Opening a folder (`openWorkspaceAt`) runs these checks in order:

1. Location: UNC network paths are refused (`WORKSPACE_UNSUPPORTED_LOCATION`). Folders under a
   known cloud-sync root (OneDrive, Dropbox, Google Drive, iCloud Drive, Box, detected by folder
   name in `workspace-location.ts`) are allowed but flagged with `cloudSyncProvider`; Settings
   shows a warning.
2. Manifest: missing folder → `WORKSPACE_MISSING`; no or damaged manifest → `WORKSPACE_INVALID`;
   newer format → `WORKSPACE_TOO_NEW`.
3. Database file present, otherwise `WORKSPACE_DAMAGED`. A new empty database is never created in
   place of a missing one.
4. Lock (below), then open and migrate the database (`openWorkspaceStorage` in
   `open-workspace.ts`). A newer schema → `WORKSPACE_TOO_NEW`; WAL cannot be enabled (for example a
   mapped network drive) → `WORKSPACE_UNSUPPORTED_LOCATION`; a failed migration →
   `WORKSPACE_DAMAGED`, with the original file unchanged and a backup in `recovery/`.
5. The `workspaces` row must exist for the manifest's ID, otherwise `WORKSPACE_DAMAGED`.

At launch, `startup()` opens the last workspace. If that fails with a workspace error, the state
becomes `unavailable` with the reason and the last folder, and the renderer shows the setup screen
("Nothing was deleted or replaced"). On the very first run (no last workspace and no recent
entries) it creates `My Knowledge` in the default location, or adopts that folder if it already
exists because settings were lost.

### Lock and stale-lock rules

`workspace-lock.ts` creates `.lock` with the exclusive `wx` flag, so two processes cannot both
succeed. The file records `pid`, `hostname`, a random `instanceId` for this app run and the time.

- If the lock already belongs to this app run (same `instanceId`), it is reused.
- A lock is **stale** only if it was written on this computer (same hostname) by a process that
  no longer exists, or if the file is unreadable or damaged. A stale lock is removed and
  acquisition is retried once.
- A lock from another computer is never considered stale; the user is told to close the
  workspace there.
- Known limitation: if Windows reuses the dead process's PID, the lock looks alive and the user
  sees "already open" instead of silent concurrent access, which is the safe failure.
- Release deletes the file only if it still holds this run's `instanceId`.

Electron's single-instance lock (one app per user profile) is a separate, earlier guard.

### Switching

`switchTo` opens the new workspace completely (lock, database, workspace row) and only then makes
it current and closes the previous one. If opening fails, the previous workspace stays open and
the error is returned. Creating a workspace initializes its database under its own lock, releases
it, then switches with the same rule. If database initialization fails, a folder that this call
created is removed again.

### Closing

`OpenWorkspace.close()` waits for queued write transactions, runs `PRAGMA wal_checkpoint(TRUNCATE)`
so the folder is self-contained, closes both connections and releases the lock. It runs on app
quit and when switching away.

### Background attachment reconciliation

After every successful open, `reconcileAttachments` runs without being awaited, so cleanup never
delays opening. It passes the set of relative paths known to the database to
`FileAttachmentStore.reconcile`, which deletes staging leftovers and files no row refers to (for
example after a crash between copying and recording, or a node deletion whose file removal
failed), and reports rows whose file is missing without deleting those rows. Failures are logged
in redacted form and retried on the next open. The report is not shown in the UI yet.

## Write coordinator

`packages/storage-sqlite/src/sqlite-connections.ts`, PRD §7.3. Each open workspace has a
`SqliteConnections` object with two connections:

- **One writer.** `runInTransaction(work)` queues the work behind the previous transaction and
  runs it inside `BEGIN IMMEDIATE` ... `COMMIT`, rolling back on any error. The queue continues
  after a failed transaction. Only one write transaction is ever open, even though services
  `await` inside it; without the queue, two async transactions would interleave statements on
  the same connection.
- **One read-only reader.** Queries outside a transaction use it. Under WAL it sees the last
  committed state, so it never observes a half-finished write.

The active transaction is tracked with `AsyncLocalStorage`, which follows `await` chains.
Repositories call `forRead()` (the transaction's connection inside a transaction, so a service
sees its own changes; otherwise the reader) or `forWrite()` (throws `NotInTransactionError`
outside a transaction). A nested `runInTransaction` joins the outer transaction instead of queuing,
which would deadlock. `close()` waits for the queue before closing.

`openWorkspaceDatabase` (`workspace-database.ts`) migrates the file with the writer and then opens
the reader. When an existing database needs a migration, the `beforeApply` hook first writes a
verified backup with SQLite's online backup API (`backup.ts`: `backup()` then
`PRAGMA integrity_check` on the copy) to
`recovery/pre-migration-v<from>-to-v<to>-<timestamp>.sqlite`. A brand-new database is not backed
up. If the backup fails, no migration runs ([ADR-0006](adr/0006-backup-policy.md)).

Repository methods are `async` even though `node:sqlite` is synchronous, so driver errors always
surface as rejected promises.

## Autosave and conflict handling

PRD §5.2, §9 and acceptance criterion 13.

**Server side.** Every node has a `revision` that starts at 1. `nodes:update` and `nodes:delete`
carry `expectedRevision`; `KnowledgeNodeService` compares it with the stored revision inside the
write transaction and throws `REVISION_CONFLICT` without changing anything if they differ. A
successful update increments the revision. Tag changes do not bump it.

**Renderer state machine.** `NodeDraftSaver` (`apps/desktop/src/renderer/src/nodes/node-draft-saver.ts`)
has no React or DOM dependencies, so its timing is unit-tested with fake timers. Statuses:
`saved`, `unsaved`, `saving`, `failed`, `conflict`, `invalid`.

- An edit marks the draft `unsaved` and restarts a 1-second idle timer. When it fires, only the
  changed fields are sent with the last known revision.
- "Saved" is shown only after the main process confirms the commit.
- Only one save is in flight. Edits made during a save are kept, and a follow-up save is
  scheduled when the first one completes, using the new revision.
- Undoing back to the saved content counts as no change.
- A failed save never discards the draft. `REVISION_CONFLICT` becomes `conflict`,
  `VALIDATION_FAILED` becomes `invalid` (no automatic retry), anything else `failed` with a
  "Retry saving" button.
- `flush()` saves immediately. It runs when the title field loses focus, when the panel closes or
  switches to another node, and before duplicate and delete.

`useNodeEditor` (`nodes/use-node-editor.ts`) binds the saver to React. On a conflict the panel
offers three choices: **Keep my version** (re-save the draft on top of the latest revision),
**Use the saved version** (replace the draft), or **Save mine as a new node** (create
`<title> (my version)` with the local summary and note, then load the saved version).

**Recovery copies.** While a draft is unsaved, `draft-recovery.ts` stores it in the renderer's
`localStorage` under `mmap.draft.<workspaceId>.<nodeId>`, with the base revision and a timestamp.
The copy is removed when a save is confirmed. `localStorage` lives in the Electron profile on this
computer and is never exported; storage errors are ignored so they never block editing. When a
node is opened and a recovery copy differs from the stored node, the panel shows a banner with
**Restore my changes** or **Discard them**, and warns if the node was saved since the copy was
taken. This is what covers closing the app during the idle second: the renderer does not flush on
window close.

Only one window exists today. The revision check is what will protect against stale writes once
several windows share the same workspace service.

## Notes pipeline

PRD §5.3 and §8.

1. **Editor.** `NoteEditor` (`apps/desktop/src/renderer/src/notes/note-editor.tsx`) uses Tiptap
   with the extensions in `notes/editor-extensions.ts`: StarterKit (headings, bold, italic,
   underline, strike, code, lists, quotes, code blocks, undo), task lists, tables, inline and
   block math, and the attachment node (`notes/attachment-node.ts`). Each paragraph gets
   `dir="auto"` for bidirectional text.
2. **Normalization in the renderer.** On every change, the editor JSON is passed through
   `parseNoteDocument` before it reaches the autosave state machine. The draft is therefore
   identical to what will be stored, so autosave settles, and invalid content (for example a note
   over the size limit) is reported at once instead of on save.
3. **Validation in the main process.** `KnowledgeNodeService.update` runs `parseNoteDocument`
   again on the untrusted JSON (`packages/domain/src/notes/note-document.ts`). It accepts only the
   listed node types, marks and attributes (unknown attribute keys are dropped, unknown types are
   rejected), rejects `__proto__`-style keys, rebuilds the document from fresh objects, and
   enforces `NOTE_LIMITS` (2 MB serialized, depth 40, 200,000 nodes, 1,000,000 characters per text
   node, 10,000 characters per formula). Link marks keep only an `href` that passes the link
   policy. Error messages never echo note content.
4. **Plain text.** In the same transaction, `extractPlainText` (`notes/plain-text.ts`) derives
   `note_plain_text`: block nodes on their own lines, table cells separated by tabs, math as its
   LaTeX source, attachments as their display name.
5. **Storage and index.** `note_json`, `note_schema_version` (1) and `note_plain_text` are written
   together. The FTS5 triggers update `knowledge_nodes_fts`. Nothing queries the index until the
   Phase 2 search UI.
6. **Reading.** Stored notes are parsed again when read, as a guard against a tampered database
   file.

Rendering is always from the ProseMirror schema, never from HTML strings. KaTeX runs with
`trust: false` (no `\href`, `\url`, `\htmlClass` and similar), `maxSize: 50` and `maxExpand: 500`,
so a hostile formula cannot produce links or raw HTML or hang the renderer. All editor and KaTeX
assets, including fonts, are bundled.

## Attachments

PRD §5.10. Code: `apps/desktop/src/main/services/attachment-ipc-services.ts`,
`apps/desktop/src/main/attachments/`, `packages/domain/src/files/attachment-policy.ts`,
`packages/domain/src/application/attachment-service.ts`.

### Adding files

1. The renderer calls `attachments:add` with a node ID. The service checks the node exists, then
   opens a native multi-file dialog in the main process.
2. For each selected file: check it is a regular file, read its size and first 64 bytes.
3. **Classify** with `classifyAttachment` (domain, pure). Checks in order: unusable name, empty
   file, larger than the configured limit, executable. Executables are detected by extension
   (Windows binaries and installers, scripts, shortcuts, disk images, macro-enabled Office files,
   Unix and macOS executables) and by leading bytes (`MZ`, ELF, Mach-O, `#!`), so a renamed
   program is still refused. The display name is sanitized: hidden and bidirectional override
   characters are removed (they can disguise `invoice‮fdp.exe`), trailing dots and spaces are
   stripped, reserved device names are refused, and long names are truncated without losing the
   extension. Images are recognized only from their bytes (PNG, JPEG, GIF, WebP). SVG is stored as
   a plain file and never previewed.
4. **Copy** with `FileAttachmentStore.importFile` (`file-attachment-store.ts`): stream the source
   into `attachments/.staging/<id>.tmp` while hashing with SHA-256, stop as soon as the size limit
   is exceeded, fsync, compare the copied size with the size measured before the copy (a file
   that changed during the copy is refused), re-read the staged file to verify the checksum, then
   rename it to `attachments/<first two characters of id>/<uuid>.<ext>`. The stored name is
   generated, never derived from the user's file name. The source is only ever opened for reading.
5. **Record** the metadata with `AttachmentService.register` in a write transaction. If that
   fails, the stored copy is deleted again.
6. One file's failure never blocks the others. Policy and store failures (unreadable, changed,
   checksum mismatch, disk full, permission denied) are returned in `rejected` with a readable
   reason; unexpected errors are logged in redacted form and reported as "could not be added".

The editor inserts the added files at the cursor as attachment nodes: an inline image for
previewable files, a file chip otherwise. The node panel also lists all attachments of the node.

### Store safety rules

Relative paths read back from the database are treated as untrusted. `resolveExisting` and
`remove` reject empty paths, NUL, backslashes, colons (drive letters and alternate data streams),
leading `/`, empty, `.` and `..` segments, segments ending in a dot or space, and anything inside
`.staging`. The path must stay inside the attachments folder both lexically and after `realpath`
(symlink and junction escapes), and must be a regular file. `remove` deletes only the final entry,
never a link target, and only when its real parent lies inside the store.

### Opening and removing

- `attachments:open` resolves the stored file, then **re-classifies** it from its current bytes
  and the original name, and also requires the stored extension to match the original one. Only
  then does it call `shell.openPath`. A file replaced by a program inside the attachments folder,
  or a tampered row, therefore cannot make mmap launch an executable.
- `attachments:remove` deletes the row first, then the file. If the file deletion fails, the
  orphan is removed by the next reconciliation.
- `nodes:delete` lists the node's files, deletes the node (attachment rows cascade), then deletes
  the files.

### Preview protocol

Inline images load from `mmap-attachment://current/<attachmentId>`. The handler is
`serveAttachmentPreviews` in `apps/desktop/src/main/security/app-protocol.ts`, and every rule is
in `resolveAttachmentPreview` (`apps/desktop/src/main/attachments/attachment-preview.ts`):

1. The host must be `current`: only the workspace open right now can be previewed.
2. No query or fragment; the path must be exactly one canonical attachment ID (no file names).
3. The attachment must exist in the open workspace (404 otherwise) and its stored type must be
   PNG, JPEG, GIF or WebP (403 otherwise, including SVG). Those types are only recorded when the
   bytes matched.
4. The relative path must resolve through `FileAttachmentStore.resolveExisting`.

Responses carry the stored content type, `X-Content-Type-Options: nosniff`,
`Cache-Control: no-store` and `Content-Security-Policy: default-src 'none'`. The scheme is
registered as standard and secure but not fetchable from scripts. The renderer CSP allows it only
in `img-src` (`'self' data: blob: mmap-attachment:`).

## External links

Links in notes are limited to absolute `http`, `https` and `mailto` URLs in three places: the
editor's link extension and link dialog, the domain note parser on save, and the main process on
open (`normalizeLinkHref` in `packages/domain/src/notes/link-policy.ts`). The policy also rejects
control and invisible characters, backslashes, and `http(s)` URLs without a host.

A plain click in the editor only places the cursor. Ctrl+click calls `app:open-external-link`,
whose service (`apps/desktop/src/main/services/external-link-service.ts`) re-validates the URL and
only then calls `shell.openExternal`. Navigation and `window.open` from the renderer are still
denied (`guardAllWebContents`), so this channel is the only way out. Rendered links get
`rel="noopener noreferrer nofollow"`.

## Security implementation

This maps each part of the baseline in ADR-0003 and PRD §8 to the code that implements it.

| Control                       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window isolation              | `src/main/main-window.ts`: `nodeIntegration` (and in workers/sub-frames) off, `contextIsolation`, `sandbox`, `webSecurity` on, `webviewTag` off, `navigateOnDragDrop` off, devtools only when unpackaged.                                                                                                                                                                                                                                                                                           |
| Custom origin instead of file | `src/main/security/app-protocol.ts` registers `app` as a standard, secure scheme and serves the bundle at `app://mmap`. It does not bypass CSP.                                                                                                                                                                                                                                                                                                                                                     |
| Protocol path safety          | `src/main/security/resolve-renderer-asset.ts`: wrong scheme/host → 403; NUL bytes, backslashes, drive letters or malformed escapes → 400; lexical path must stay inside the renderer root; the real path (symlinks and junctions resolved) must also stay inside; only regular files are served. Responses also get `X-Content-Type-Options: nosniff`.                                                                                                                                              |
| Content Security Policy       | `src/main/security/content-security-policy.ts` builds the policy: `default-src 'none'`, scripts and connections only from `'self'`, images from `'self'`, `data:`, `blob:` and `mmap-attachment:`, no remote origins, no `unsafe-eval`, no inline scripts in production (inline styles are allowed for Tiptap and KaTeX). It is applied in two places: the `app://` handler sets the header on its own responses, and `hardenSession` adds it to every response via `webRequest.onHeadersReceived`. |
| Navigation and windows        | `src/main/security/harden-electron.ts` `guardAllWebContents`: `will-navigate` and `will-redirect` to an untrusted origin are cancelled, `window.open` and `target=_blank` are denied, `<webview>` attachment is prevented. Applied to every `webContents` the app ever creates.                                                                                                                                                                                                                     |
| Permissions                   | `hardenSession` denies every permission request, permission check and device permission.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Trusted origins               | `src/main/security/trusted-origins.ts`: production trusts only `app://mmap`. The dev server is trusted only when unpackaged and on a loopback `http` URL.                                                                                                                                                                                                                                                                                                                                           |
| IPC sender and payload        | `src/main/ipc/ipc-handler.ts`: main-frame and origin check, zod validation of the request and of the response, result envelope.                                                                                                                                                                                                                                                                                                                                                                     |
| Narrow bridge, no paths       | `src/preload/index.ts` exposes one named method per operation. `ipcRenderer`, filesystem, shell and SQL are never exposed. No request carries a filesystem path; folders and files are chosen in native dialogs in the main process.                                                                                                                                                                                                                                                                |
| Untrusted notes               | `parseNoteDocument` validates and rebuilds every note in the main process; links restricted to safe schemes; KaTeX `trust: false`; rendering from the schema, never from HTML. See [Notes pipeline](#notes-pipeline).                                                                                                                                                                                                                                                                               |
| Attachments                   | Executables refused by extension and content; generated storage names; traversal and junction checks on every stored path; re-check before opening; previews limited to raster images of the open workspace. See [Attachments](#attachments).                                                                                                                                                                                                                                                       |
| External links                | Re-validated in the main process before `shell.openExternal`; only after a user gesture. See [External links](#external-links).                                                                                                                                                                                                                                                                                                                                                                     |
| Workspace isolation           | One open workspace at a time; every repository query is scoped by `workspace_id`; composite foreign keys reject cross-workspace links; the renderer workbench and recovery copies are keyed by workspace ID.                                                                                                                                                                                                                                                                                        |
| Redacted logging              | `src/main/logging.ts` logs only the operation, the error class name and its code. Error messages are dropped because lower layers can embed titles or paths; stack traces appear only in unpackaged builds. IPC payloads are never logged.                                                                                                                                                                                                                                                          |
| Database file hardening       | `packages/storage-sqlite/src/connection.ts`: extension loading off, `trusted_schema = OFF`, double-quoted string literals off, foreign keys on and verified.                                                                                                                                                                                                                                                                                                                                        |
| Packaged binary               | Electron fuses in `apps/desktop/electron-builder.yml`. See the [packaging runbook](runbooks/packaging.md#electron-fuses).                                                                                                                                                                                                                                                                                                                                                                           |
| No network                    | The main process makes no network calls, and CSP blocks remote requests from the renderer. The smoke test runs with a dead proxy to prove the app works offline.                                                                                                                                                                                                                                                                                                                                    |

Not implemented yet: the release security test suite (Phase 5) and safe handling of imported
archives (Phase 5).

## Where future phases plug in

- **Search.** `packages/domain/src/ports/search.ts` defines the port; the FTS5 index is already
  maintained by triggers. Phase 2 adds the SQLite implementation and the search UI.
- **Relationships and note references.** The tables exist and the built-in relationship types are
  seeded, but no service writes `relationships` or `note_references` yet. Phase 2 rebuilds
  references in the note-save transaction (PRD §14). The delete preview already counts both.
- **Maps.** `nodes:delete` already promotes child placements before deleting a node; map services
  arrive in Phase 3.
- **Timeline display.** Events are recorded (see [data-model.md](data-model.md)); the Timeline
  view arrives in Phase 4.
- **Heavy work off the main thread.** Database work currently runs on the main process thread.
  Archives, layouts and large queries in later phases should move to a worker; the
  `TransactionRunner` port is asynchronous so the coordinator can move with them.
- **New IPC channels.** Each feature adds channels through the contract catalogue
  ([ipc-contracts.md](ipc-contracts.md)). Long-running operations will additionally need progress,
  cancellation and idempotency keys (PRD §7.2); `transfer_jobs` in the schema already has
  `progress` and `idempotency_key` columns for this.

## Future server adapter seam

PRD §7.2 keeps an optional server/web phase possible without committing to it. Nothing for it
exists in the repository. The boundaries above are what keep it possible:

- The domain package, including the application services, has no runtime, storage or transport
  dependencies, so a server can reuse it unchanged. Folders, manifests and locks stay in the
  desktop main process.
- A PostgreSQL/Prisma adapter would be a new package implementing the same domain ports, with its
  own integration tests (PRD §10.6). The `TransactionRunner` port is already asynchronous for this
  reason, and the node service keeps its revision check even though local writes are serialized.
- The zod schemas in `packages/contracts` describe DTOs independently of Electron, so an HTTP
  layer (Fastify in the PRD) could validate the same shapes. `DomainError` codes are
  transport-neutral; IPC maps them into its envelope today, and an HTTP layer would map them to
  status codes.
- Authorization belongs at the server boundary. Sync is explicitly out of scope and needs its own
  PRD.

Package names and the exact HTTP mapping are not decided; they belong to that future phase.
