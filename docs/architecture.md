# Architecture overview

This page explains how the code is organized, how a request travels from the UI to the storage
engine, how the Phase 1 features (workspaces, nodes, notes, tags, attachments), the Phase 2
features (relationships, wikilinks and backlinks, search), the Phase 3 features (mind maps) and
the Phase 4 features (knowledge graph, learning timeline) work, and how the security baseline from
[ADR-0003](adr/0003-electron-version-and-security-baseline.md) is implemented. It describes the
code on branch `phase-4-graph-timeline`; later phases are listed separately at the end. It is a
reviewer-level overview: follow the file references for details.

## Packages and dependency rules

The repository is an npm-workspaces monorepo
([ADR-0001](adr/0001-monorepo-and-module-boundaries.md)).

| Package                   | Responsibility                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`         | IDs, clock, error model, ports, and the rules: node fields, note documents, wikilink references and link policy, relationship rules, map hierarchy and tree layout, labels, attachment file-type policy, timeline sessions and timezone conversion, graph limits, application services |
| `packages/contracts`      | IPC channel names, zod schemas per channel, result envelope, renderer API type                                                                                                                                                                                                         |
| `packages/storage-sqlite` | `node:sqlite` connection settings, migration runner, schema, write coordinator, verified backup, repositories, FTS5 search index, graph query and graph positions                                                                                                                      |
| `apps/desktop`            | Electron main process (workspaces, attachment store, IPC services), preload bridge, React renderer, packaging, smoke test                                                                                                                                                              |

Application services live in `packages/domain/src/application/` (`workspace-service.ts`,
`knowledge-node-service.ts`, `tag-service.ts`, `attachment-service.ts`,
`relationship-service.ts`, `map-service.ts`, `graph-service.ts`, `timeline-service.ts`). They
depend only on ports (`packages/domain/src/ports/`), so the same
services run against SQLite today and could run against another adapter later. The SQLite
implementations of those ports are in `packages/storage-sqlite/src/repositories/`, the search
port (`ports/search.ts`) is implemented in `packages/storage-sqlite/src/search/`, and the graph
port (`ports/graph.ts`) in `packages/storage-sqlite/src/graph/`. All of them are
wired per open workspace in `createWorkspaceServices`
(`apps/desktop/src/main/workspaces/open-workspace.ts`).

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
are checks for a fast, accurate UI; the main process repeats them and remains the authority. The
map editor also imports the pure hierarchy helpers and `layoutTree` (see [Mind maps](#mind-maps)),
so the tree layout is computed by domain code in the renderer instead of being stored. The
timeline groups entries by day and places the axis ticks with the domain's `localDateOf` and
`startOfLocalDayUtc`, the same timezone code the main process uses for date filters (see
[Learning timeline](#learning-timeline)).

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
| Renderer | `apps/desktop/src/renderer` | Chromium, sandboxed, origin `app://mmap`      | React UI (Tailwind, shadcn/ui, Tiptap, KaTeX, React Flow, Cytoscape); no Node or Electron APIs                            |

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

### Current scope (Phases 1 to 4)

The renderer (`apps/desktop/src/renderer/src/App.tsx`) shows a workspace gate: while no workspace
is open, `WorkspaceSetupView` explains why and offers create, open and recent workspaces. Once a
workspace is open, the `Workbench` shows the five navigation areas from PRD §6
(`src/renderer/src/navigation.ts`). The `Workbench` is rendered with `key={workspace.id}`, so
switching workspaces discards all view state of the previous one.

- **Library** (`nodes/library-view.tsx`): every node with three sort orders, tag filters
  (`nodes/tag-filter-bar.tsx`, shared with search), "Load more" paging and totals.
- **Search** (`nodes/search-view.tsx`): reached from the search box in the header, not from the
  sidebar (`ViewId` `search`). Typing switches to it; the query runs 250 ms after the last
  keystroke or at once on Enter. Ctrl+K (Cmd+K) focuses the box from anywhere.
- **Node detail panel** (`nodes/node-detail-panel.tsx`): title, summary, tags, relationships
  (`relationships/node-relationships.tsx`), rich note with wikilinks, attachments, backlinks
  (`nodes/node-backlinks.tsx`), save status, recovery and conflict banners, duplicate and delete.
- **Mind Maps** (`maps/maps-view.tsx`, `maps/map-editor.tsx`): the list of maps and the editor
  for one map, with the canvas, the outline and the dialogs (see [Mind maps](#mind-maps)).
  Opening an item opens its node in the same detail panel as everywhere else.
- **Knowledge Graph** (`graph/graph-view.tsx`, `graph/graph-canvas.tsx`): toolbar and filters
  (including mind maps), the Cytoscape canvas with saved positions, a completeness statement, the
  side panel for the selected node, Focus mode and the List tab (see
  [Knowledge graph](#knowledge-graph)). "Open mind map" switches to Mind Maps with that map open.
- **Timeline** (`timeline/timeline-view.tsx`): a **Timeline** tab with the visual time axis
  (`timeline/timeline-axis-view.tsx`, math in `timeline/timeline-axis.ts`) and a **List** tab
  grouped by day in the workspace timezone; the event panel (`timeline/timeline-event-panel.tsx`)
  and "Add milestone" (`timeline/milestone-dialog.tsx`) (see
  [Learning timeline](#learning-timeline)). The node panel's "Mark as reviewed…" button opens
  `timeline/review-dialog.tsx`.
- **Settings** (`views/settings-view.tsx`): workspace name, location and switching, timezone
  (`views/timezone-setting.tsx`), attachment size limit, diagnostics.

Views that show data owned by other nodes (relationships, backlinks, search results, open maps,
the graph, the timeline) reload when
`notifyNodesChanged` fires (`nodes/node-events.ts`), for example after a node is renamed, created
from the wikilink picker, or deleted.

The renderer's top level is wrapped in an error boundary (`components/error-boundary.tsx`).

## Request flow: one IPC call end to end

This is the full path of `app:get-info`, the pattern every channel follows. The other 71 channels
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
   block math, the attachment node (`notes/attachment-node.ts`) and the wikilink node
   (`notes/wikilink-node.ts`, see [Wikilinks and backlinks](#wikilinks-and-backlinks)). Each
   paragraph gets `dir="auto"` for bidirectional text.
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
   LaTeX source, attachments as their display name, wikilinks as their label.
5. **References.** Still in the same transaction, the wikilinks of the note are extracted and the
   node's `note_references` rows are replaced (see
   [Wikilinks and backlinks](#wikilinks-and-backlinks)).
6. **Storage and index.** `note_json`, `note_schema_version` (2) and `note_plain_text` are written
   together. The FTS5 triggers update `knowledge_nodes_fts`, which [search](#search) queries.
7. **Reading.** Stored notes are parsed again when read, as a guard against a tampered database
   file.

Rendering is always from the ProseMirror schema, never from HTML strings. KaTeX runs with
`trust: false` (no `\href`, `\url`, `\htmlClass` and similar), `maxSize: 50` and `maxExpand: 500`,
so a hostile formula cannot produce links or raw HTML or hang the renderer. All editor and KaTeX
assets, including fonts, are bundled.

## Relationships

PRD §4.2 and §5.5. Code: `packages/domain/src/application/relationship-service.ts`,
`packages/domain/src/knowledge/relationship-rules.ts`,
`packages/storage-sqlite/src/repositories/sqlite-relationship-repository.ts` and
`sqlite-relationship-type-repository.ts`, UI in `apps/desktop/src/renderer/src/relationships/`.

### Rules

`RelationshipService` checks these inside the write transaction, before anything is written. The
schema repeats the structural ones as a second line of defense ([data-model.md](data-model.md#relationships-relationship)).

- **Two distinct nodes of the open workspace.** A self-link is `INVARIANT_VIOLATION`; a node or
  type from another workspace is `NOT_FOUND`.
- **Directed types keep the user's direction.** A → B and B → A are different relationships and
  may both exist.
- **Undirected types use canonical ordering.** `toStoredEndpoints` swaps the endpoints so the
  lower node ID (canonical lowercase UUID text, compared the way SQLite's `BINARY` collation
  does) is always the source. A–B and B–A are therefore stored identically.
- **No duplicates.** Before writing, the service looks up a relationship with the same stored
  endpoints and type and answers `DUPLICATE`. With canonical ordering this also rejects a
  reversed undirected duplicate. Different types between the same two nodes are allowed.
- **Updates go through the same rules.** Changing the type recomputes the stored order (an
  undirected target type reorders canonically); `reverseDirection` swaps the endpoints of a
  directed relationship and is ignored for undirected ones. Both are checked for duplicates,
  ignoring the relationship being edited.
- **Descriptions** are NFC-normalized and trimmed, empty becomes `null`, and at most 1,000
  characters are allowed.
- **Timeline.** Creating a relationship writes a `relationship_created` timeline event in the
  same transaction, attributed to the request's source node.

Nothing else creates relationships. Wikilinks never do, and neither does map structure
(PRD §4.3, §4.4; see [Mind maps](#mind-maps)).

### Directionality copy and type changes

Each relationship row stores a copy of its type's `directionality`, and its foreign key
`(workspace_id, type_id, directionality)` points at the matching `UNIQUE` columns of
`relationship_types`. A relationship can therefore never disagree with its type, and the database
itself refuses to change the direction of a type that is in use.

PRD §4.2 allows either an explicit migration flow or requiring a new type. mmap requires a new
type: `changeTypeDirectionality` counts the relationships using the type and answers
`INVARIANT_VIOLATION` ("Create a new relationship type instead") when there are any. Unused types
can change freely. A migration flow would have to reinterpret existing statements (which end of an
undirected pair becomes the source?) and was not worth that risk. In the types dialog
(`manage-relationship-types-dialog.tsx`) the direction control is disabled with an explanation
while the type is in use.

### Archive instead of delete

Types are never deleted; there is no delete channel, and the foreign key has no `ON DELETE`
action. Archiving sets `is_archived`: existing relationships keep the type and still display it,
but `create` and a type change in `update` refuse it with `VALIDATION_FAILED`. The relationship
form offers only active types; the type selector of an existing relationship also shows its own
archived type. Renaming keeps every relationship, because they reference the type by ID. Labels
use the tag label rules and are unique per workspace regardless of case.

### Display

`listForNode` loads each relationship with its type label and both node titles in one query,
ordered by type label and the other node's title. The panel shows directed relationships as
"source — type → target" and undirected ones as "A — type — B", marks the current node as
"this node", and adds screen-reader text "(directed)" or "(undirected, no direction)", so meaning
never depends on the arrow alone (PRD §4.2, acceptance criterion 4).

## Wikilinks and backlinks

PRD §4.3 and §5.4. The decision is recorded in
[ADR-0008](adr/0008-wikilinks-and-note-schema-v2.md).

### Note schema version 2

`NOTE_SCHEMA_VERSION` is 2 (`packages/domain/src/notes/note-document.ts`). Version 2 adds one
inline leaf node:

```json
{ "type": "wikilink", "attrs": { "targetNodeId": "<canonical uuid>", "label": "Entropy" } }
```

Identity is `targetNodeId`, never the label. The label is what the author sees and keeps its text
when the target is renamed. The parser requires a canonical lowercase UUID and a label of 1 to 300
characters without control characters, and drops any other attribute (such as a cached title).
Every version-1 document is a valid version-2 document, so old notes are read without conversion.

### Migration 2: a compatibility marker

`packages/storage-sqlite/src/migrations/0002-note-schema-v2-marker.ts` runs `SELECT 1;`. It
changes no table: wikilinks live in the note JSON and references use the `note_references` table
from migration 1. Its only purpose is to raise the database version to 2. A Phase 1 build knows
only migration 1, so it refuses the whole workspace with `WORKSPACE_TOO_NEW` ("created by a newer
version of mmap") instead of opening it and then failing on the first note that contains a
wikilink. Like every migration, it runs after a verified pre-migration backup of an existing
workspace.

### Inserting a link

1. Typing `[[` triggers the node's input rule: the brackets are deleted and the editor asks
   `NoteEditor` to open `WikilinkDialog`. The toolbar button "Link to a node ([[)" opens the same
   dialog.
2. The dialog shows `NodePicker` (`nodes/node-picker.tsx`), an ARIA combobox backed by
   `nodes:lookup` (debounced 150 ms, stale answers ignored). Its last option is
   "Create a new node “text”", so creating a node is always an explicit choice; the new node is
   created with `nodes:create` and then linked.
3. The chosen node is inserted as `{ targetNodeId, label: <current title> }` followed by a space.
   The node is an atom: its label cannot be edited in place.

There is no free-text `[[Title]]` parsing. A link is always created by choosing one node in the
picker, so a title shared by several nodes is never resolved by guessing.

### Reconciliation in the save transaction

References are derived data (PRD §14 "Editor/reference divergence"). Whenever a note is written
(`create`, `duplicate`, and `update` when the note changed), `KnowledgeNodeService` calls
`extractNoteReferences` (`packages/domain/src/notes/note-references.ts`) and
`NoteReferenceRepository.replaceForSource` in the same transaction as the node row:

- Every wikilink occurrence becomes one reference with its `ordinal` (position among the links of
  the note), `targetNodeId`, `label` and an excerpt of about 160 characters of the surrounding
  text block (paragraph, heading, list item, table cell), cut at word boundaries with ellipses.
- The repository deletes all rows of the source node and inserts the new ones with
  `INSERT … SELECT … WHERE EXISTS`, so only references whose target exists in this workspace are
  stored. Links to deleted or foreign nodes stay in the note JSON only.
- A removed link therefore disappears from the target's backlinks with the save that removed it.
  A title or summary change without a note change leaves the references alone.

Wikilinks never create relationships. The dialog says so, and the tests check that the
`relationships` table stays empty.

### Backlinks

`nodes:backlinks` groups the target's references by source note: one item per source, with the
label and excerpt of the first occurrence and the number of occurrences, ordered by source title
(`COLLATE NOCASE`). A note linking to itself is excluded. Source titles are joined live, so a
renamed source shows its new title. The node panel shows the list under **Linked from**
(`nodes/node-backlinks.tsx`) and reloads it on every node change event.

### Resolution and unresolved links

The editor never stores titles, so it asks which targets still exist. `NoteEditor` collects the
distinct target IDs (`collectWikilinkTargets`) when the editor is created and 300 ms after each
change, calls `nodes:resolve-links`, stores the answer in the wikilink extension's storage and
dispatches a transaction with `RESOLUTION_META`. A ProseMirror decoration plugin then marks each
link: resolved links get a tooltip with the target's current title; unresolved ones get the class
`wikilink-unresolved` (dashed outline and strike-through, not only colour) and an
"Unresolved link" label. Until the first answer arrives nothing is marked.

A click on a resolved link opens the target. A click on an unresolved link opens the same dialog
in repair mode: the chosen node replaces `targetNodeId` (`retargetWikilink`) and the label stays.
Both modes can also create a new node explicitly. Insert mode has an optional "Link text" field
(the `[[target|label]]` behaviour of PRD §5.4); left empty, the link text is the node title. The
repaired note is saved by autosave, which recreates the reference row.

Deleting a node removes, by cascade, the reference rows that point at it and those of its own
note. The links in the source notes stay in their JSON, readable and repairable (acceptance
criterion 8). The delete preview counts the notes that link to the node.

## Search

PRD §5.8. Code: `packages/storage-sqlite/src/search/` (`sqlite-search-index.ts`, `fts-query.ts`,
`snippet-segments.ts`), port `packages/domain/src/ports/search.ts`, UI
`apps/desktop/src/renderer/src/nodes/search-view.tsx`.

### Index

`knowledge_nodes_fts` is an FTS5 table with external content (`content = 'knowledge_nodes'`,
`content_rowid = 'row_key'`) over `title`, `summary` and `note_plain_text`, kept in sync by the
triggers of migration 1 in the same transaction as every node write. The tokenizer is
`unicode61 remove_diacritics 2`. The index has no `workspace_id`, so every query joins
`knowledge_nodes` on `row_key` and filters by workspace; a match in another workspace is never
counted, ranked or returned.

### Query building: user text never becomes FTS syntax

`buildFtsMatchExpression` (`fts-query.ts`) extracts words (runs of Unicode letters, combining
marks and digits; a word must contain a letter or digit), keeps at most 16 words of at most 64
code points each, and wraps each word in an FTS5 double-quoted string, inside which everything is
literal. The only syntax mmap emits is those quotes, the spaces between words (implicit AND) and a
`*` after the last word when it has at least two characters. So:

- every word must occur somewhere in the node;
- the last word also matches as a prefix (`entro` finds `Entropy`), earlier words only as whole
  words;
- `OR`, `NOT`, `NEAR(...)`, `title:x`, `^`, `*`, parentheses and unbalanced quotes are separators
  or literal words, never operators; and
- text with no searchable word returns an empty page without querying.

Tag filters (`tagIds`, "has all tags") and the workspace ID are bound parameters.

### Ranking and snippets

Results are ordered by `bm25(knowledge_nodes_fts, 10.0, 4.0, 1.0)` (title, summary, note text),
then by node ID for a stable order among equal scores. A title hit weighs ten times a note hit and
a summary hit four times, so title matches rank first while note text still counts. There is no
semantic or learned ranking.

Snippets come from FTS5 `snippet()` over the best-matching column (about 12 tokens, `…` where text
is cut), with two private-use characters (U+E000, U+E001) as match markers instead of HTML tags.
`parseSnippetSegments` splits on them into `{ text, isMatch }` segments, merges neighbours and
drops stray or unbalanced markers, so stored text such as `<script>` reaches the renderer only as
text. The renderer wraps matched segments in `<mark>`.

### Paging: an offset cursor

`search:query` returns `totalCount` (same `FROM`/`WHERE` as the page) and an opaque cursor that
encodes an offset. Node lists use keyset cursors, but a BM25 score changes whenever any matching
document changes, so it cannot be a stable key. The consequence: if nodes are edited between
"Load more" requests, an item can move across a page boundary and be shown twice or skipped.
Cursors are accepted only in the exact form the service produces (re-encoded and compared), with
an offset of at most 1,000,000; anything else is `VALIDATION_FAILED`. Page size is clamped to 1–200
by the domain and 1–100 by the contract.

### Title lookup for pickers

`lookupTitles` serves `nodes:lookup` without FTS: `title LIKE '%text%'` with `%`, `_` and `\`
escaped, ordered by "title starts with the text" first, then title length, title
(`COLLATE NOCASE`) and ID, so the same text always gives the same order. Excluded IDs travel as one
JSON array parameter expanded with `json_each`. The text is trimmed and cut to 200 code points;
the limit is clamped to 1–50.

### Text matching limits

- **Case.** Full-text search folds case through the tokenizer. Title lookup relies on SQLite's
  `LIKE`, which folds ASCII letters only: `entropy` finds `Entropy`, but `émile` does not find
  `Émile`. Full Unicode folding would need ICU, which `node:sqlite` does not include.
- **Accents.** Full-text search ignores diacritics on Latin letters (`cafe` finds `Café`). Title
  lookup does not.
- **Hebrew points.** `remove_diacritics` does not remove Hebrew niqqud, and the query builder
  keeps combining marks inside a word. Pointed and unpointed spellings of a Hebrew word therefore
  do not match each other; a search finds pointed text only with the same pointing. Unpointed
  Hebrew and Arabic text is found normally.

### Performance

`search.benchmark.test.ts` measures search and title lookup on the PRD §9 dataset; results and
caveats are in [testing.md](testing.md#search-benchmark). All search work runs synchronously on
the main process thread, like the rest of the database work.

## Mind maps

PRD §4.4 and §5.6. The main decisions are recorded in
[ADR-0009](adr/0009-mind-map-editing.md).

A map shows canonical nodes through **placements**. A placement holds only what belongs to this
map: freeform position, parent, sibling order, collapse state and color. The node's title, note,
tags and relationships stay on the node, so a node edited anywhere shows the same content on every
map (acceptance criterion 6). A node appears at most once per map (PRD version 1 rule).

### Layers

| Layer        | Code                                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure rules   | `packages/domain/src/maps/hierarchy.ts` (cycle check, sibling order, move planning), `tree-layout.ts` (hierarchical layout), `hierarchy-proposal.ts` (parent suggestions and validation for the switch to hierarchy)              |
| Service      | `packages/domain/src/application/map-service.ts` (`MapService`), port `packages/domain/src/ports/map-repository.ts`                                                                                                               |
| Storage      | `packages/storage-sqlite/src/repositories/sqlite-map-repository.ts`; tables from migration 1 ([data-model.md](data-model.md#mind_maps-mindmap))                                                                                   |
| Contracts    | `packages/contracts/src/maps.ts`: 17 `maps:*` channels ([ipc-contracts.md](ipc-contracts.md#mind-maps))                                                                                                                           |
| Main process | `apps/desktop/src/main/services/map-ipc-services.ts` maps domain records field by field to DTOs, so workspace IDs and timestamps the renderer does not need never cross the bridge                                                |
| Composition  | `createWorkspaceServices` (`open-workspace.ts`) gives `MapService` a `createNode` function backed by the node service, so nodes created from a map get the usual validation, timeline event and search entry                      |
| Renderer     | `apps/desktop/src/renderer/src/maps/`: list (`maps-view.tsx`), editor (`map-editor.tsx`), canvas (`map-canvas.tsx`), outline (`map-outline.tsx`), dialogs, change queue (`use-map-document.ts`), pure view model (`map-model.ts`) |

All persistent map state lives in the main process. React Flow holds only transient UI state
(selection, an item's position while it is being dragged); after every change the canvas is
rebuilt from the map view the main process returns.

### Revisions and the change queue

Every structural change carries the map revision the renderer last saw: rename, add or remove an
item, move items, reparent, collapse or expand, set a color, add or remove a connector, switch
mode. `MapService` runs each one through `structuralChange`: inside one write transaction it
loads the map, compares the revision (`REVISION_CONFLICT` if it differs), applies the change,
and stores the next revision with a conditional `UPDATE … WHERE revision = ?` as a second check.
If any rule fails, the whole transaction rolls back and the map is unchanged. Every structural
response is the complete map view with the new revision.

Not structural, and therefore without a revision: creating, duplicating and deleting a map,
proposing a hierarchy, and saving the viewport. The viewport is visual state; `setViewport`
writes only `viewport_json` and changes neither the revision nor `updated_at`.

In the renderer, `useMapDocument` keeps the latest map view and runs changes one at a time on a
promise queue. Each queued change reads the revision from the latest view when it starts, so
quick successive edits (dragging two items, then reordering) never conflict with each other. On
`REVISION_CONFLICT` the map is reloaded and a banner says that the last change was not applied;
other errors are shown in the same banner. A node change event (for example a rename in the node
panel) queues a reload behind pending changes, so titles stay current.

Positions changed by dragging or by arrow keys are collected and sent together in one
`maps:move-placements` call 300 ms after the last move. The viewport is saved 600 ms after panning
or zooming stops, and once more when the editor closes; a failed viewport save is ignored.

### Freeform and hierarchical modes

**Freeform** shows the stored coordinates (`freeform_x`, `freeform_y`). Items can be dragged, and
connectors are drawn by dragging from an item's right handle to another item.

**Hierarchical** shows a layout computed by `layoutTree` from parent, sibling order and collapse
state only: x is the depth times 260 px, every visible leaf takes the next 56 px row in
depth-first order, a parent is centred between its first and last visible child, root trees are
separated by one empty row, and descendants of a collapsed item are hidden. The algorithm is
iterative and tolerates corrupt input (a missing parent, a self-parent or a stored cycle) by
treating the affected item as a root, so a damaged map still renders.

The computed layout is never stored, for these reasons:

- **Deterministic.** The same hierarchy always looks the same, on any computer, after a
  duplicate, and after a future import; nothing depends on stored pixels or input order.
- **Nothing to keep in sync.** Reparenting, reordering, collapsing or removing an item would
  otherwise have to rewrite the positions of whole subtrees in the same transaction.
- **Freeform coordinates are preserved.** Switching to hierarchy never touches `freeform_x` and
  `freeform_y`, so switching back restores the previous freeform layout exactly (PRD §5.6).

Consequently items cannot be dragged in hierarchical mode, and new connectors can be drawn only in
freeform mode. The canvas fits the view when a map with items opens with the default viewport
(never saved) and after every mode switch, because all items move.

### Hierarchy rules

- A hierarchical map is a forest: several roots are allowed and each other item has exactly one
  parent on the same map.
- **No cycles.** `reparent` calls `assertNoCycle` (walks up from the new parent) and `planMove`,
  which renumbers the affected sibling groups densely. A cycle is `INVARIANT_VIOLATION`. The
  trigger `map_placements_reject_cycles` rejects the same update in the database as a second line
  of defense.
- **Never a relationship.** Parent and child are organizational only; no map operation writes
  `relationships` (PRD §4.4, tested).
- **Adding** appends the item after its future siblings. An item created from a new node title
  calls the injected `createNode` inside the map's transaction, so a rejected placement also
  discards the new node.
- **Removing an item** from a map deletes only the placement. Its children take its place among
  its siblings, in their own order, so no branch disappears and no node is deleted.
- **Deleting a node** (`nodes:delete`) first moves the children of each of its placements to that
  placement's parent (`SqliteKnowledgeNodeRepository.delete`) and raises the revision of every map
  that shows the node, so an editor still holding the old structure gets `REVISION_CONFLICT` and
  reloads. Then it deletes the node; its placements and their connectors cascade.
- **Deleting a map** removes the map, its placements and connectors in one statement. Nodes are
  never deleted (acceptance criterion 8).
- **Duplicating a map** places the same canonical nodes with new placement IDs, inserting parents
  before children, and copies connectors including their relationship references.

### Switching between modes

Switching from freeform to hierarchy needs a parent decision for every item (PRD §5.6).
`MapService.proposeHierarchy` prepares one, and says where it came from (`source`):

- **`previous-hierarchy`**: if any item still has a stored parent (the map was a hierarchy
  before), the stored parents are proposed unchanged; items added since then are top level.
  Connectors are not consulted, so a hierarchy → freeform → hierarchy round trip gives back the
  same tree. Nothing is ambiguous, because the stored tree is already acyclic.
- **`connectors`**: otherwise `proposeHierarchy` (`hierarchy-proposal.ts`) applies simple,
  explainable rules: a connector A → B suggests "A is the parent of B"; an item without incoming
  connectors becomes a root; an item with connectors from several items, or whose only connector
  would close a loop, is **ambiguous** and is proposed as a root with its candidate parents
  listed. Items are processed in ID order, so the outcome never depends on input order.

`switch-to-hierarchy-dialog.tsx` shows the proposal and does not allow switching until every
ambiguous item has a decision and the choices form no loop (`findParentLoops` in `map-model.ts`
names the items on a loop). It fetches the proposal again if the map changes while it is open.
The main process then validates the whole assignment again
(`validateHierarchyAssignment`: one entry per item, known parents, no cycles), detaches all
parents first (so the cycle trigger, which checks one row at a time, only ever sees the new,
validated parents), and assigns sibling orders in the previous order within each new parent.

Switching from hierarchy to freeform only changes the mode. The stored parents and sibling orders
stay, which is what the next switch to hierarchy proposes.

### Connectors

Map connectors (`map_connections`) are visual lines between two placements of the same map. They
may form cycles; a connector from an item to itself is refused (`INVARIANT_VIOLATION`, plus a
`CHECK`). A connector may carry a label (at most 200 characters) and may reference an existing
semantic relationship, but only one that connects exactly the same two nodes, in either direction
(`VALIDATION_FAILED` otherwise). Referencing never creates a relationship, and deleting the
relationship only clears the reference. The canvas shows the label and, for a referenced
relationship, its type in brackets. Today the canvas creates plain connectors only; the label and
the reference are available through `maps:add-connection`.

To keep visual structure and meaning apart (PRD §14), hierarchy lines are solid and cannot be
selected, connectors are dashed with an arrow, and a legend in the editor explains both. Both use
the muted text color for at least 3:1 contrast, and they differ in shape, not only in color
(`styles.css`).

### Outline: the keyboard alternative

`map-outline.tsx` lists the map's items next to the canvas as a WAI-ARIA tree with one focusable
row (roving `tabindex`), `aria-level`, `aria-posinset`, `aria-setsize` and `aria-expanded`. It
offers every action without a pointer: Up/Down/Home/End to move focus, Left/Right to collapse,
expand or go to the parent, Enter to open the node, Insert to add (as a child in hierarchical
mode), Delete to remove from the map, and Alt+Up/Down/Left/Right to reorder, outdent and indent.
The moves are planned by the pure `planKeyboardMove` and sent as `maps:reparent`. Freeform maps are
listed flat, sorted by title. Buttons offer the same actions to pointer users.

### React Flow under the content security policy

React Flow (`@xyflow/react` 12.12.0) is bundled with its stylesheet like every other renderer
dependency; nothing is loaded from a CDN. It positions and sizes elements with inline `style`
attributes, which is one of the reasons the production CSP allows `style-src 'self'
'unsafe-inline'` (see `content-security-policy.ts`; Tiptap and KaTeX need the same). Inline
scripts remain forbidden, which is what protects against injected content. React Flow's
attribution link is hidden because the canvas never navigates to the web. The packaged smoke test
renders the real editor with 200 items under the production CSP.

## Knowledge graph

PRD §5.7. The main decisions are recorded in [ADR-0010](adr/0010-graph-and-timeline.md).

The graph shows canonical nodes and semantic relationships of the open workspace, with note
references (wikilinks) as an optional, separately drawn layer, and mind map membership on the
nodes themselves. It is a read-only view of knowledge: nothing in it writes nodes, relationships
or maps. The only thing it stores is where nodes sit on the graph canvas (`graph_node_positions`),
which is visual state of this view, kept apart from every mind map's placements.

Three kinds of connection stay distinct everywhere: relationships are edges (with an arrow when
directed), note links are a dashed layer, and map membership is a property of the node (badges,
tooltip, side panel, List). Sharing a map never creates an edge (PRD §4.4).

### Layers

| Layer        | Code                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port         | `packages/domain/src/ports/graph.ts`: `GraphQuery`, `GraphFilters`, `GraphSlice` (with `GraphNode.mapIds` and `GraphMap`), `GraphLayoutRepository`, and the limits `MAX_GRAPH_NODES` (1,000), `MAX_GRAPH_EDGES` (3,000), `MAX_GRAPH_NEIGHBORS` (200)                                                                                                                                                  |
| Service      | `packages/domain/src/application/graph-service.ts`: normalizes filters (text trimmed, at most 500 characters; duplicate IDs removed), clamps every limit to the caps above, and validates positions (at most 5,000 per call, coordinates within ±1,000,000)                                                                                                                                           |
| Storage      | `packages/storage-sqlite/src/graph/sqlite-graph-query.ts` (`SqliteGraphQuery`) and `sqlite-graph-layout-repository.ts` (`SqliteGraphLayoutRepository`, table `graph_node_positions` from migration 3)                                                                                                                                                                                                 |
| Contracts    | `packages/contracts/src/graph-timeline.ts`: `graph:overview`, `graph:neighborhood`, `graph:get-positions`, `graph:save-positions` ([ipc-contracts.md](ipc-contracts.md#knowledge-graph))                                                                                                                                                                                                              |
| Main process | `apps/desktop/src/main/services/graph-timeline-ipc-services.ts` maps slices field by field to DTOs                                                                                                                                                                                                                                                                                                    |
| Renderer     | `apps/desktop/src/renderer/src/graph/`: screen (`graph-view.tsx`: toolbar, filters, status line, List, legend), Cytoscape canvas (`graph-canvas.tsx`), stable placement (`graph-layout.ts`), pure model (`graph-model.ts`: merging, completeness text, elements and map badges, emphasis, Focus set, list rows, find), side panel (`graph-node-panel.tsx`), map multi-select (`graph-map-filter.tsx`) |

### Bounded slices with explicit totals

A large workspace is never loaded whole. The graph is built from **slices**:

- `overview` returns the best-connected nodes that match the filters, at most 1,000, with the
  relationships among them (at most 3,000) and, when requested, the note references among them
  (at most 3,000). Nodes are ranked by **degree** (number of relationships within the type
  filter, across the whole workspace), then title (ASCII case folded, like SQLite `NOCASE`), then
  ID, so the same data and filters always give the same slice.
- `neighborhood` returns one node and its direct neighbors through relationships (and through
  note references, when the layer is on), at most 200, ranked the same way, with every
  relationship and reference among the returned nodes. The expanded node itself is always shown;
  its neighbors follow the filters.

Every node carries `mapIds` (the mind maps that place it, from `map_placements`), and every slice
lists all mind maps of the workspace in `maps` (`id`, `title`, `nodeCount`, ordered by title), so
the view can name memberships and offer the map filter even for maps with no node in the slice.

Every slice states `totalNodes` (matching nodes in the workspace, or neighbors for an expansion)
and whether edges or references were left out (`edgesTruncated`, `referencesTruncated`). The view
never has to guess: `describeCompleteness` turns these into sentences shown in a `role="status"`
line above the canvas, in amber while the view is partial ("Partial view: showing 1,000 of 10,000 matching nodes, the most connected
first…", "Neighbors of “X”: showing 200 of 340."). An expansion is merged into the view by
`mergeNeighborhood`, which keeps what is shown and records each expansion's own counts. PRD §5.7:
"never silently imply that a partial view contains all nodes".

Filters:

- **Text**: the same escaped FTS5 match as search (`buildFtsMatchExpression`), over title,
  summary and note text. Text with no searchable word matches nothing.
- **Tags**: nodes that carry all selected tags (the library's rule).
- **Relationship types**: only relationships of the selected types, and only nodes that take part
  in at least one of them. Degrees are counted within the filter.
- **Mind maps** (`mapIds`): only nodes placed on at least one of the selected maps (their union).
  Without a map filter, nodes on no map are shown too. The filter only selects nodes; it never adds
  edges between members.
- **Note links** (`includeReferences`): adds one line per (source note, target node) pair, with
  the number of links; a note linking to its own node is left out.

### Simple scans, ranking in TypeScript

`SqliteGraphQuery` runs one simple, indexed query per table, with every filter as a bound
parameter: the candidate nodes (`knowledge_nodes`, with the tag and text conditions), all
relationships of the workspace within the type filter, all map placements (for memberships and
the map filter), the workspace's maps with their node counts, and, if requested, the grouped note
references. Degrees, ranking, the cut to the limit and the selection of edges among the shown
nodes happen in TypeScript. On the PRD dataset (10,000 nodes, 30,000 relationships) this is
linear and its cost does not depend on SQLite's plan choices.

Earlier versions pushed the work into SQL and were slow for reasons that only showed on the full
dataset: ID lists expanded with `json_each` were re-evaluated per row (about 600 ms for the edges
among 1,000 nodes), and correlated per-node counts with a type filter made SQLite choose the type
index and took minutes. Those numbers were timed during development with temporary
instrumentation and are recorded only in the header comment of `sqlite-graph-query.ts`; the
committed benchmark (`search.benchmark.test.ts`) measures only the current design
([testing.md](testing.md#search-benchmark)).

### Rendering

`graph-canvas.tsx` creates one Cytoscape 3.34.3 instance and synchronizes its elements
incrementally: removed elements are removed, new ones are added at the position the view chose,
and existing ones only get new data and classes. A data change, a selection or a filter change
never moves a node that is already on screen.

#### Stable positions

Positions are visual state of the graph only. They are stored per workspace in
`graph_node_positions` (migration 3), never in `map_placements`, so moving a node on the graph
never moves it on a map, and the reverse. They never change knowledge.

1. After loading a slice, `graph-view.tsx` reads the saved positions of its nodes
   (`graph:get-positions`) and keeps every position it already knows in memory (including drags),
   so a reload never moves anything.
2. `placeNodes` (`graph-layout.ts`) places only nodes without a position: next to the average of
   their already placed neighbors, in the nearest free cell of a 190 × 90 grid, or, for nodes with
   no placed neighbor, in rows below the existing drawing. It works in ranking order (best
   connected first), is deterministic and avoids overlaps; 1,000 nodes take well under a second
   (`graph-layout.test.ts`). Newly placed nodes are saved (`graph:save-positions`, in batches of
   up to 5,000).
3. Dragging a node saves its position after 500 ms (debounced).
4. The whole graph is laid out only by **Rearrange**: Cytoscape's `cose` layout on the visible
   nodes, with settings measured on a sample graph in the app (ideal edge length 70, node
   repulsion 4,000, gravity 3, labels counted as part of the nodes). It animates only from the old
   to the final positions (`animate: 'end'`), for fewer than 400 nodes and never with reduced
   motion, then fits and saves every visible node's position. It replaces manual positions.
5. On opening the screen, the same layout runs automatically when nothing is saved yet or most
   shown nodes have no saved position, for graphs of up to 300 nodes. Larger graphs keep the
   stable placement, so the first view appears quickly.

#### Fitting

The graph always opens fitted to view; the viewport is not stored (migration 4 dropped the
`graph_view_state` table that migration 3 had created for it). It fits again after a filter change,
after entering, changing or leaving Focus mode, after Rearrange and on **Fit**, but not after a
reload caused by an edit elsewhere. Automatic fitting never zooms in beyond 1.2, so a single node
or a small graph keeps a normal size, and uses a margin of 8% of the canvas's shorter side (at
most 50 px). Cytoscape caches its container size; a `ResizeObserver` resizes it when the filter
panel, the side panel or the window changes the canvas size, and refits until the user pans or
zooms (dragging the background, the wheel, a pinch, the zoom buttons or centering a found node).

#### Visual rules (PRD §5.7, §6, §14)

- Directed relationships end in an arrow; undirected ones have none. Direction is shown by shape,
  never by color alone.
- Relationship type labels appear on hover, for the edges of the selected node, and on every edge
  with **All labels**.
- Note links are dashed and thinner, without an arrow, so they are never mistaken for
  relationships; their direction is written out in the List. A footer legend explains arrows,
  undirected lines and dashed note links.
- Node size grows with degree. Labels sit below the node, are cut with an ellipsis at 130 px and
  hidden when zoomed far out; hovering a node shows a tooltip with the full title and its maps.
- With **Show Maps**, nodes on maps are drawn as pies with one slice per map in the map's color
  (`MAP_COLORS`, eight colors by the map's position in the title-ordered list, so colors repeat
  after eight maps); a node on more than six maps gets six colored slices and one neutral slice.
  The legend then lists the first eight maps with their colors. Membership is always named in the
  tooltip, side panel and List, so it never depends on color.
- Colors come from the theme's CSS variables, so the graph follows light and dark mode. The theme
  uses `oklch()`, which Cytoscape cannot parse, so `themeColor` converts each variable to `rgb()`
  by painting one pixel on a canvas.

#### Selection, highlighting and Focus mode

`computeEmphasis` (`graph-model.ts`) decides what stays at full strength; everything else is
dimmed by a class, never removed:

- a selected node with its immediate neighbors and the edges between it and them;
- otherwise, a highlighted map's members and the relationships among them.

Focus mode (`focusNodeIds`) hides everything except the focused node and its immediate
neighbors; **Expand neighbors** inside Focus mode adds that node's neighbors to the focus set.
The status line names the focused node and the highlighted map, with buttons to leave either.

Click selects a node and opens the side panel (`graph-node-panel.tsx`): title, summary, tags, mind
maps (each with "highlight on the graph" and "open mind map"), relationships in words with
direction, and **Open note**, **Focus** and **Expand neighbors**. Double-click opens the node in
the node panel. **Open mind map** switches to the Mind Maps view with that map open in its own
layout (`App.tsx` passes `initialMapId` to `maps-view.tsx`). **Find in graph** suggests up to
eight loaded nodes whose title contains the text, then selects and centers the chosen one.

The view reloads on `notifyNodesChanged`, so a node renamed, deleted or connected elsewhere is not
shown stale. Expanded neighborhoods are remembered and re-applied after every reload and filter
change while the expanded node is still in the overview. Cytoscape is bundled like every other
renderer dependency, and the packaged smoke check renders a 1,000-node graph under the production
CSP.

#### Map regions and collapsing

Mind map membership overlaps, so maps are never turned into an exclusive hierarchy (Cytoscape
compound nodes would force every node into one parent). `graph-regions.ts` (pure, unit-tested)
computes two things the canvas draws:

- **Regions** (toolbar **Regions**): for each shown map, a soft padded convex hull around its
  visible members, labeled with the map title, drawn on an SVG layer behind the graph and redrawn
  on every Cytoscape render. Regions may overlap; a shared node lies inside each region of its
  maps and is still one canonical node. At most 12 regions are drawn at once (the status line says
  when more exist); selecting maps in the filter chooses which. The layer is built with DOM APIs,
  never markup, because map titles are user content.
- **Collapsing** (collapse button per map in the filter panel): a collapsed map becomes one summary
  node, "Title · N nodes", in the map's color, placed at the center of the members it hides. A
  member is hidden only when every map it is on is collapsed; a member also on an expanded map stays
  visible as itself, and nodes on no map are never hidden. Relationships and note links to hidden
  members are aggregated onto the summaries as one line per pair with a count ("3 connections"), so
  connections between collapsed maps and the rest of the graph stay visible. Clicking a summary
  expands its map; **Expand all** in the status line expands every map. Summaries are not knowledge
  nodes: their positions are derived and never saved.

Not implemented: creating relationships from the graph.

### List: the accessible alternative

The canvas is not keyboard-operable and has `role="img"` with a label that points to the List
tab. The **List** tab (`buildGraphList`) shows the same nodes, sorted by title, each with its mind
maps and its relationships and note links written out in words with direction ("depends on → Beta",
"← depends on Alpha", "related to — Gamma", "note links to Delta"), and **Open**, **Focus** and
**Expand** buttons. It shows exactly what the canvas shows (only the focus set in Focus mode), so
the completeness statement applies to both (PRD §6, acceptance criterion 14).

## Learning timeline

PRD §5.9. Code: `packages/domain/src/application/timeline-service.ts`,
`packages/domain/src/timeline/` (`editing-session.ts`, `time-zone.ts`),
`packages/storage-sqlite/src/repositories/sqlite-timeline-event-repository.ts`, channels in
`packages/contracts/src/graph-timeline.ts`, UI in `apps/desktop/src/renderer/src/timeline/`.

### What the timeline is

A record of what happened: node creation, editing sessions of notes (30 minutes of inactivity end
a session; see [data-model.md](data-model.md#what-is-recorded)), relationship creation, and the
reviews and learning milestones the user adds. It does not infer, score or rate understanding;
there is no progress measure anywhere in the code.

### Recorded time and learning date

Every event has two times. `occurredAt` is when the action was recorded; it never changes.
`learnedAt` is an optional moment, chosen by the user, when the learning actually happened (for
example, a review recorded today of something learned last week). The timeline places, orders,
filters and pages events by their **effective time**, `learnedAt ?? occurredAt`, so without a
learning date an event stays at its recorded time. The SQL uses
`coalesce(learned_at, occurred_at)`, served by the index `timeline_events_by_effective_time`
(migration 5). A learning date must be a valid instant, not in the future (5 minutes of tolerance
for clock differences) and not before 1900. An editing session with a learning date is shown as a
point at that date; its span belongs to the recorded time.

### Recorded activity is immutable; reviews and milestones belong to the user

`node_created`, `note_updated` and `relationship_created` are written by the node and
relationship services in the same transaction as the change they describe. They are facts about
the past, so no user action can change their content or delete them (the only change the app
makes is the node service extending a still-open editing session): `TimelineService` refuses a
title or reflection change, and any deletion, of these types with `INVARIANT_VIOLATION`. The one
exception is the learning date: it can be set or cleared on any event, because it annotates the
record without changing what was recorded. This keeps the timeline trustworthy and keeps a future
import honest: imported history must arrive marked as imported and never be rewritten into new
learning events (PRD §5.9).

`reviewed` and `milestone` events (`USER_OWNED_EVENT_TYPES`) are the user's own statements, so
they are theirs to manage. `markReviewed` records a review with an optional reflection and
learning date. `addMilestone` records a milestone with a title (whitespace collapsed, 1–200
characters), optional details (stored in the reflection), an optional node and an optional
learning date. `updateEntry` changes the title (milestones only; `VALIDATION_FAILED` otherwise),
the reflection and the learning date; `deleteEntry` removes a review or a milestone. A reflection
is trimmed, normalized to NFC, may hold line breaks and tabs, and is refused if longer than 2,000
characters or containing other control characters. Each of these runs in one write transaction.

### Timezones

Timestamps are stored as fixed-width UTC strings and never change. The workspace has one display
timezone (`workspaces.timezone`, an IANA name), chosen in Settings and validated by
`validateTimeZone` (names the runtime's `Intl` knows; offsets such as `+02:00` are refused).

- **Date filters are local calendar dates.** The renderer sends `fromDate` and `toDate` as
  `YYYY-MM-DD`. `localDateRangeToUtc` turns them into a half-open UTC range: the start of the
  first day up to the start of the day after the last. So "27 March" means the user's 27 March,
  including on a 23- or 25-hour day.
- **Days without a midnight.** Where clocks jump at midnight (for example `America/Santiago`),
  `startOfLocalDayUtc` starts the day at the transition instant; where midnight occurs twice, at
  the earlier one. The conversion uses `Intl` only, so the domain needs no timezone library and
  follows the runtime's timezone database.
- **Grouping by day.** The renderer groups List entries by the effective time with `localDateOf`
  (same domain code) and formats the heading at noon UTC, so no timezone can move it to another
  date. An editing session belongs to the day it started.
- **Axis ticks.** `ticksFor` (`timeline-axis.ts`) puts ticks at local hours, midnights and month
  starts found with `startOfLocalDayUtc`, never by adding 24 hours, so a 23- or 25-hour day has
  23 or 25 hour ticks. An unknown timezone falls back to UTC.
- **Learning-date inputs** (`datetime-local` fields in the dialogs and the event panel) are read
  as wall-clock time in the workspace timezone and converted to UTC in `timeline-model.ts`,
  including across daylight-saving changes.
- **Changing the timezone** changes only how dates are shown and how filters are read.

### Listing and paging

`SqliteTimelineEventRepository.list` (the List tab) orders by effective time `DESC`, then
`id DESC`, and pages with a keyset cursor (the last row's effective time and ID, base64url JSON),
so new events recorded meanwhile never repeat or skip rows. A malformed cursor is
`VALIDATION_FAILED`. Filters (event types, node, tags that the node carries now, the UTC range of
effective times) are bound parameters. Each entry carries the node's current title through a
`LEFT JOIN`, or the recorded title snapshot when the node was deleted; the main process sends one
`nodeTitle` to the renderer.

### Time windows

The Timeline tab loads one window at a time with `timeline:window` (`TimelineService.window`,
`SqliteTimelineEventRepository.window`): a half-open UTC range of effective times plus the same
filters, intersected in the renderer with the date-range filter. The response holds the total
and at most 2,000 events (`MAX_TIMELINE_WINDOW_EVENTS`), oldest first. If the range holds more,
taking the newest 2,000 would let one busy afternoon hide the rest of the year, so the range is
split into 200 equal time buckets and events are taken round-robin with `row_number()` per bucket:
the latest event of every bucket, then the second latest, and so on, up to the limit. Every
period with activity therefore keeps at least one event, and the status line says "Showing N of M
events in this period, spread across it; zoom in to see them all". The test "never lets a burst
of activity hide a quieter moment in a full window" covers this.

### The visual axis

`timeline-axis.ts` is pure (no React, no DOM) and unit-tested; `timeline-axis-view.tsx` draws it
as SVG.

- **Window and zoom.** Four zoom levels: Day, Week, Month and Year (spans of 1, 7, 31 and 366
  days). The first window puts now at 85% of the width; if the latest event is older than that
  window's start, the window is centred on it instead, so the axis never opens empty while events
  exist. Panning (‹ › buttons, dragging, mouse wheel or touchpad) keeps the span. Zooming (the
  level buttons, or Ctrl+wheel around the pointer) keeps an anchor at the same relative position:
  the selected event, or now when it is visible. **Today** returns to the now-at-85% window. A
  date-range filter moves the axis to that range.
- **Markers.** Each type has its own shape and icon as well as its color, so the type never
  depends on color alone (PRD §6): Created is a circle with a plus, Note edits a bar from session
  start to last activity, Relationships a diamond with a link, Reviews a square with a check-book
  icon, Milestones a pennant with a flag. A small dot marks an event placed at a user-set learning
  date. A legend names the shapes in words.
- **Layout.** `layoutMarkers` assigns markers to at most 8 rows so that items in a row keep a
  minimum gap. Markers whose positions are within a radius (8, 12 or 18 px, wider at wider zoom)
  form a cluster drawn as a numbered badge; activating a cluster zooms in on its time range. An
  item that fits no row joins the nearest cluster, so nothing is dropped, and the result does not
  depend on input order.
- **Accessibility.** Every marker and cluster is an SVG element with `role="button"`,
  `tabIndex=0` and a spoken label (the event description and time, or "N events between … and ….
  Activate to zoom in."), activated with Enter or Space. The axis group's label points to the List
  tab, which presents the same events as an ordinary list.
- **Event panel.** Selecting an event in either tab opens `timeline-event-panel.tsx`: type, title,
  learning date and recorded date (with the session range), a button to open the node (or the
  node's title with "(deleted)"), the learning-date editor, and for reviews and milestones the
  title, details or reflection editor and Delete with confirmation.

Lanes per tag or topic are a planned later enhancement and are not built.

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

| Control                       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window isolation              | `src/main/main-window.ts`: `nodeIntegration` (and in workers/sub-frames) off, `contextIsolation`, `sandbox`, `webSecurity` on, `webviewTag` off, `navigateOnDragDrop` off, devtools only when unpackaged.                                                                                                                                                                                                                                                                                                       |
| Custom origin instead of file | `src/main/security/app-protocol.ts` registers `app` as a standard, secure scheme and serves the bundle at `app://mmap`. It does not bypass CSP.                                                                                                                                                                                                                                                                                                                                                                 |
| Protocol path safety          | `src/main/security/resolve-renderer-asset.ts`: wrong scheme/host → 403; NUL bytes, backslashes, drive letters or malformed escapes → 400; lexical path must stay inside the renderer root; the real path (symlinks and junctions resolved) must also stay inside; only regular files are served. Responses also get `X-Content-Type-Options: nosniff`.                                                                                                                                                          |
| Content Security Policy       | `src/main/security/content-security-policy.ts` builds the policy: `default-src 'none'`, scripts and connections only from `'self'`, images from `'self'`, `data:`, `blob:` and `mmap-attachment:`, no remote origins, no `unsafe-eval`, no inline scripts in production (inline styles are allowed for Tiptap, KaTeX and React Flow). It is applied in two places: the `app://` handler sets the header on its own responses, and `hardenSession` adds it to every response via `webRequest.onHeadersReceived`. |
| Navigation and windows        | `src/main/security/harden-electron.ts` `guardAllWebContents`: `will-navigate` and `will-redirect` to an untrusted origin are cancelled, `window.open` and `target=_blank` are denied, `<webview>` attachment is prevented. Applied to every `webContents` the app ever creates.                                                                                                                                                                                                                                 |
| Permissions                   | `hardenSession` denies every permission request, permission check and device permission.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Trusted origins               | `src/main/security/trusted-origins.ts`: production trusts only `app://mmap`. The dev server is trusted only when unpackaged and on a loopback `http` URL.                                                                                                                                                                                                                                                                                                                                                       |
| IPC sender and payload        | `src/main/ipc/ipc-handler.ts`: main-frame and origin check, zod validation of the request and of the response, result envelope.                                                                                                                                                                                                                                                                                                                                                                                 |
| Narrow bridge, no paths       | `src/preload/index.ts` exposes one named method per operation. `ipcRenderer`, filesystem, shell and SQL are never exposed. No request carries a filesystem path; folders and files are chosen in native dialogs in the main process.                                                                                                                                                                                                                                                                            |
| Untrusted notes               | `parseNoteDocument` validates and rebuilds every note in the main process; links restricted to safe schemes; wikilinks limited to a canonical target ID and a bounded label; KaTeX `trust: false`; rendering from the schema, never from HTML. See [Notes pipeline](#notes-pipeline).                                                                                                                                                                                                                           |
| Search input and output       | User text is reduced to quoted FTS5 words or an escaped `LIKE` pattern, so it can never act as query syntax; word count and length are bounded; cursors are accepted only in the exact form the service issued. Snippets cross the bridge as plain-text segments and are rendered as text. See [Search](#search).                                                                                                                                                                                               |
| Attachments                   | Executables refused by extension and content; generated storage names; traversal and junction checks on every stored path; re-check before opening; previews limited to raster images of the open workspace. See [Attachments](#attachments).                                                                                                                                                                                                                                                                   |
| External links                | Re-validated in the main process before `shell.openExternal`; only after a user gesture. See [External links](#external-links).                                                                                                                                                                                                                                                                                                                                                                                 |
| Workspace isolation           | One open workspace at a time; every repository query is scoped by `workspace_id`, including search, which joins the workspace-less FTS index back to `knowledge_nodes`; composite foreign keys reject cross-workspace relationships, references, tags and map placements; the renderer workbench and recovery copies are keyed by workspace ID.                                                                                                                                                                 |
| Redacted logging              | `src/main/logging.ts` logs only the operation, the error class name and its code. Error messages are dropped because lower layers can embed titles or paths; stack traces appear only in unpackaged builds. IPC payloads are never logged.                                                                                                                                                                                                                                                                      |
| Database file hardening       | `packages/storage-sqlite/src/connection.ts`: extension loading off, `trusted_schema = OFF`, double-quoted string literals off, foreign keys on and verified.                                                                                                                                                                                                                                                                                                                                                    |
| Packaged binary               | Electron fuses in `apps/desktop/electron-builder.yml`. See the [packaging runbook](runbooks/packaging.md#electron-fuses).                                                                                                                                                                                                                                                                                                                                                                                       |
| No network                    | The main process makes no network calls, and CSP blocks remote requests from the renderer. The smoke test runs with a dead proxy to prove the app works offline.                                                                                                                                                                                                                                                                                                                                                |

Not implemented yet: the release security test suite (Phase 5) and safe handling of imported
archives (Phase 5).

## Where future phases plug in

- **Graph actions.** Creating a relationship from the graph (PRD §5.5) can reuse the node panel's
  relationship form; the graph view only needs to reload afterwards, which `notifyNodesChanged`
  already does.
- **Maps in export and import (Phase 5).** Placements, hierarchy, connectors and viewports must be
  exported and re-mapped to new IDs on import. Hierarchical layouts need no export because they
  are computed.
- **Import (Phase 5).** Imported raw or Markdown text with `[[Title]]` links will need its own
  resolution step that asks the user when a title is ambiguous (PRD §5.4); the editor never
  resolves links by title.
- **Timeline in export and import (Phase 5).** Timeline records must be exported; imported events
  must be written with `is_imported = 1` and an `import_origin`, never as new activity (PRD §5.9).
  The timeline view already shows an "Imported" badge for them.
- **Heavy work off the main thread.** Database work, including search, maps and graph queries,
  currently runs on the main process thread, and the hierarchical map layout and the Cytoscape
  graph layout run in the renderer. Archives and large queries in later phases should move to a
  worker; the `TransactionRunner` port
  is asynchronous so the coordinator can move with them.
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
