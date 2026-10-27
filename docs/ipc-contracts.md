# IPC contracts

The renderer talks to the main process only through typed IPC channels defined in
`packages/contracts`. This page explains the pattern, the result envelope and error codes, how to
add a channel, and lists every channel that exists. For the end-to-end path of a single call, see
[architecture.md](architecture.md#request-flow-one-ipc-call-end-to-end).

## The contract catalogue

| File                                       | Contents                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `packages/contracts/src/channels.ts`       | `IPC_CHANNELS`: the allow-list of channel names. No dependencies, so the preload can import it. |
| `packages/contracts/src/app-info.ts`       | `app:*` schemas (diagnostics, external links).                                                  |
| `packages/contracts/src/workspace.ts`      | `workspace:*` schemas and `WORKSPACE_ERROR_CODES`.                                              |
| `packages/contracts/src/nodes.ts`          | `nodes:*`, `search:*` and `tags:*` schemas.                                                     |
| `packages/contracts/src/relationships.ts`  | `relationship-types:*` and `relationships:*` schemas.                                           |
| `packages/contracts/src/attachments.ts`    | `attachments:*` and `preferences:*` schemas, the preview URL scheme.                            |
| `packages/contracts/src/maps.ts`           | `maps:*` schemas and the map view DTOs.                                                         |
| `packages/contracts/src/graph-timeline.ts` | `graph:*` and `timeline:*` schemas, the graph slice and timeline entry DTOs.                    |
| `packages/contracts/src/transfer.ts`       | `transfer:*` schemas (export and import) and `TRANSFER_ERROR_CODES`.                            |
| `packages/contracts/src/backups.ts`        | `backups:*` schemas and the backup status DTO.                                                  |
| `packages/contracts/src/catalogue.ts`      | `IPC_CATALOGUE`: pairs each channel with `{ request, response }` schemas.                       |
| `packages/contracts/src/envelope.ts`       | `IpcResult<Data>`, `ipcErrorSchema`, the combined list of error codes.                          |
| `packages/contracts/src/renderer-api.ts`   | `MmapRendererApi`: the type of `window.mmap`.                                                   |

Rules the code relies on:

- **Channel names** follow `<area>:<verb-noun>`, for example `nodes:preview-delete`.
- **Catalogue completeness.** `IPC_CATALOGUE` is declared with
  `satisfies Record<IpcChannel, IpcContract>`, so TypeScript fails if a channel has no contract.
  `catalogue.test.ts` also checks that the catalogue has exactly the channels in `IPC_CHANNELS`.
- **Strict schemas.** Object schemas use `z.strictObject`, so unexpected properties are rejected
  instead of silently dropped. A channel with no argument uses `z.undefined()`; the `transfer:*`
  and `backups:*` channels instead take an empty object `{}` (`z.strictObject({})`).
- **Both directions are validated.** The main process parses the request before the service runs
  and the response before it leaves. Response validation is what stops a service bug from leaking
  an extra field to the renderer.
- **No generic invoke.** The renderer never names a channel; it calls a method such as
  `window.mmap.nodes.update(...)`.
- **DTOs only.** Payloads are plain data. Never pass SQL, filesystem paths chosen by the
  renderer, shell commands or functions across the bridge (PRD §7.2).

### The renderer never sends filesystem paths

No request schema has a path field. Where the user has to pick a location or a file, the main
process opens the native dialog itself and uses the result directly:

- `workspace:create` with `location: 'choose-folder'` and `workspace:open-folder` open a folder
  picker in the main process (`apps/desktop/src/main/services/workspace-ipc-services.ts`).
- `workspace:open-recent` and `workspace:forget-recent` take a workspace ID. The folder path is
  looked up in the settings file that the main process wrote itself.
- `attachments:add` takes only a node ID and opens a multi-file picker in the main process.
  `attachments:open`, `attachments:remove` and the `mmap-attachment://current/<id>` preview URL
  take an attachment ID; the stored relative path is read from the database and re-validated.
- `transfer:export-zip` and `transfer:export-markdown` open a save dialog, and
  `transfer:preview-import` an open dialog, in the main process. `transfer:apply-import` refers to
  the previewed archive by an opaque token, never by its path.
- `backups:choose-destination` and `backups:restore-from-folder` open folder pickers in the main
  process. `backups:restore` refers to a snapshot by the ID from the status list; the main process
  looks it up in the backup folder it knows.

Paths do travel the other way, for display only: `WorkspaceSummary.folderPath` and
`RecentWorkspace.folderPath` let Settings show where a workspace lives (PRD §5.1), the backup
status carries the backup folder, and export and import results carry the chosen file's name (not
its folder).

### Note JSON is untrusted input

`nodes:update` accepts `changes.note` as `z.unknown()`. The contract deliberately does not repeat
the note schema: the single authority is `parseNoteDocument` in
`packages/domain/src/notes/note-document.ts`, which the node service runs before anything is read
or written. It rejects unknown node types and marks, unsafe link schemes, prototype tricks and
oversized documents with `VALIDATION_FAILED`. Duplicating that recursive schema in zod would create
two rule sets that could drift apart (PRD §10.1). The response side uses a loose `z.custom` check
for `note` for the same reason; stored notes are parsed again by the domain when they are read.
Wikilinks are part of the note JSON (note schema version 2), so they are validated by the same
parser: a canonical UUID `targetNodeId` and a 1–300 character `label`, unknown attributes dropped.

### Search text is never query syntax

`search:query` and `nodes:lookup` take the user's text as a plain string. The storage adapter turns
it into quoted FTS5 terms or an escaped `LIKE` pattern; operators such as `OR`, `NEAR(...)`,
`title:` or `*` typed by the user are matched as literal words. See
[architecture.md](architecture.md#search).

The transport limits on titles (1,000 characters) and summaries (10,000) are deliberately
generous. The domain applies the real limits (300 and 2,000,
`packages/domain/src/knowledge/node-fields.ts`) with clear messages.

## Result envelope

Electron flattens errors thrown inside `ipcMain.handle` into a string, losing the code and
possibly leaking internals. So handlers never throw to the renderer. Every call resolves with:

```ts
type IpcResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly error: { code: IpcErrorCode; message: string } };
```

`message` is English text safe to show to the user. It never contains stack traces or note
content. Workspace error messages may include the folder path, because the user chose that folder
and needs to see which one failed.

The renderer unwraps envelopes with `unwrap()` from `apps/desktop/src/renderer/src/lib/ipc.ts`,
which throws an `IpcFailure` carrying the code.

## Error codes

Domain codes come from `packages/domain/src/errors.ts` and are produced when a service throws a
`DomainError`. Workspace codes come from `WORKSPACE_ERROR_CODES` in
`packages/contracts/src/workspace.ts` and are produced when the main process throws a
`WorkspaceError` (`apps/desktop/src/main/workspaces/workspace-errors.ts`). Transfer codes come
from `TRANSFER_ERROR_CODES` in `packages/contracts/src/transfer.ts` and are produced when the
export, import, backup or restore code throws a `TransferError`
(`apps/desktop/src/main/portability/transfer-errors.ts`). Transport codes come
from `packages/contracts/src/envelope.ts` and are produced by the IPC handler itself
(`apps/desktop/src/main/ipc/ipc-handler.ts`).

| Code                             | Source    | Meaning                                                                                                                                       |
| -------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`              | Domain    | Input failed a domain rule: empty or too long title, invalid label, invalid note, archived type, bad cursor.                                  |
| `NOT_FOUND`                      | Domain    | The record does not exist in the open workspace. IDs from another workspace also produce this.                                                |
| `REVISION_CONFLICT`              | Domain    | `expectedRevision` is not the stored revision of the node or map; a newer version was saved first. Nothing was changed.                       |
| `DUPLICATE`                      | Domain    | A uniqueness rule was violated: a tag or relationship type name, a relationship that already exists, or a node already on the map.            |
| `INVARIANT_VIOLATION`            | Domain    | A business invariant was violated: a self-link or self-connector, changing the direction of a relationship type in use, or a hierarchy cycle. |
| `WORKSPACE_MISMATCH`             | Domain    | A record from another workspace was referenced. No channel produces it yet (services answer `NOT_FOUND`).                                     |
| `WORKSPACE_MISSING`              | Workspace | The folder or drive is gone, or no workspace is open when a workspace-data call arrives.                                                      |
| `WORKSPACE_INVALID`              | Workspace | The folder is not an mmap workspace, its manifest is damaged, or the open workspace was asked to be forgotten.                                |
| `WORKSPACE_TOO_NEW`              | Workspace | The manifest or database was written by a newer mmap version.                                                                                 |
| `WORKSPACE_LOCKED`               | Workspace | Another live process on this computer, or another computer, holds the workspace lock.                                                         |
| `WORKSPACE_FOLDER_NOT_EMPTY`     | Workspace | A new workspace was requested in a folder that already has files, or no free folder name was found.                                           |
| `WORKSPACE_UNSUPPORTED_LOCATION` | Workspace | A network (UNC) path, or a location where SQLite cannot enable WAL mode.                                                                      |
| `WORKSPACE_DAMAGED`              | Workspace | The database file is missing, cannot be opened or upgraded, or does not match the manifest.                                                   |
| `WORKSPACE_MOVE_FAILED`          | Workspace | Moving failed; the copy was discarded and the original is open and unchanged.                                                                 |
| `WORKSPACE_DELETE_FAILED`        | Workspace | The folder could not be moved to the Recycle Bin (or no longer belongs to the workspace); nothing was deleted.                                |
| `ARCHIVE_INVALID`                | Transfer  | The file is not an mmap archive, or it is damaged or inconsistent (bad JSON, schema, layout, counts or manifest).                             |
| `ARCHIVE_UNSAFE`                 | Transfer  | The archive contains unsafe entries: traversal, absolute or drive paths, control characters, links, encrypted or unexpected files.            |
| `ARCHIVE_TOO_LARGE`              | Transfer  | The archive exceeds a size or entry-count limit, or an entry inflates to more than allowed.                                                   |
| `ARCHIVE_TOO_NEW`                | Transfer  | The archive or backup was written by a newer mmap version. The message says to update mmap.                                                   |
| `ARCHIVE_CHECKSUM_MISMATCH`      | Transfer  | A file's bytes do not match the checksum recorded in the archive.                                                                             |
| `TRANSFER_FAILED`                | Transfer  | Writing an export or copying files failed (disk full, no permission, …).                                                                      |
| `IMPORT_EXPIRED`                 | Transfer  | The previewed import is no longer available: the token is unknown or older than 10 minutes, or another preview or workspace replaced it.      |
| `BACKUP_FAILED`                  | Transfer  | A backup could not be written (disk full, folder unavailable, no permission).                                                                 |
| `BACKUP_DAMAGED`                 | Transfer  | A backup is incomplete, unknown, or its files do not match their checksums.                                                                   |
| `RESTORE_FAILED`                 | Transfer  | Restoring failed; the workspace is unchanged.                                                                                                 |
| `INVALID_REQUEST`                | Transport | The payload did not match the channel's request schema. The service was not called.                                                           |
| `FORBIDDEN_SENDER`               | Transport | The call did not come from the main frame of a trusted origin. The service was not called.                                                    |
| `INTERNAL_ERROR`                 | Transport | Anything unexpected, including a response that failed its schema. Logged locally, redacted.                                                   |

How the handler chooses a result:

1. Untrusted sender → `FORBIDDEN_SENDER`.
2. Request fails its schema → `INVALID_REQUEST`.
3. Service throws a `DomainError`, a `WorkspaceError` or a `TransferError` → its `code` and
   `message` (all three classes must therefore be written to be safe for display).
4. Service throws anything else, or its result fails the response schema → `INTERNAL_ERROR` with a
   generic message, and `logFailure` records the channel and error class name only.
5. Otherwise → `{ ok: true, data }` with the parsed response.

If the IPC call itself rejects (for example no handler is registered), the promise from
`window.mmap` rejects. `unwrap()` turns that into an `IpcFailure` with `INTERNAL_ERROR`.

## Adding a channel

Every new channel needs a contract schema, sender validation, a handler test and a documentation
entry (implementation plan §4). Work through these steps in order.

1. **Name.** Add the channel to `IPC_CHANNELS` in `packages/contracts/src/channels.ts`, following
   `<area>:<verb-noun>`.
2. **Schemas.** Create or extend `packages/contracts/src/<area>.ts` with a request schema and a
   response schema. Use `z.strictObject`, bound string lengths and array sizes, and use
   UUID-checked IDs. Never add a path field to a request; open a native dialog in the main process
   instead. Export the schemas from `packages/contracts/src/index.ts`.
3. **Catalogue.** Add `{ request, response }` for the channel to `IPC_CATALOGUE` in
   `packages/contracts/src/catalogue.ts`. TypeScript will not compile until you do.
4. **Service.** Write the service in `apps/desktop/src/main/services/` as a function taking the
   parsed request and returning a promise of the response. Existing services are grouped per area
   (`create<Area>IpcServices` returning a `Pick<IpcServices, ...>`). Throw `DomainError` or
   `WorkspaceError` for expected failures. Keep domain rules in `packages/domain` and SQL in
   `packages/storage-sqlite`; the service only orchestrates. Services that need the open workspace
   read `WorkspaceManager.current` at call time and throw `WORKSPACE_MISSING` when it is `null`.
5. **Register.** Add the service to the object passed to `registerIpcHandlers` in
   `apps/desktop/src/main/index.ts` (the `IpcServices` type requires exactly one service per
   channel). Nothing else is needed: `registerIpcHandlers`
   (`apps/desktop/src/main/ipc/register-ipc-handlers.ts`) loops over `IPC_CHANNELS` and wraps each
   service with `createIpcHandler`.
6. **Preload API.** Add the method to `MmapRendererApi` in
   `packages/contracts/src/renderer-api.ts` as `BridgeCall<'area:verb-noun'>`. Implement it in
   `apps/desktop/src/preload/index.ts` as `ipcRenderer.invoke(IPC_CHANNELS.yourChannel, request)`.
   Do not add logic, validation libraries or Node imports to the preload; the architecture rules
   reject Node built-ins, storage and UI code there.
7. **Tests.**
   - Contract tests in `packages/contracts/src/`: valid payloads pass; extra properties, wrong
     types and hostile values (paths, SQL text, oversized strings) fail; responses with extra
     fields fail.
   - Handler or service tests in `apps/desktop/src/main/`: untrusted sender and invalid payload
     never reach the service, domain errors map to their codes, unexpected errors become
     `INTERNAL_ERROR`. See `ipc/ipc-handler.test.ts` and `services/attachment-ipc-services.test.ts`.
   - Storage behaviour behind the service is tested against real temporary SQLite databases
     ([testing.md](testing.md)).
8. **Docs.** Add the channel to the [channel reference](#channel-reference) below.

Long-running operations (import, export, backup) should also have progress events, cancellation
and idempotency keys (PRD §7.2). That pattern does not exist yet: the `transfer:*` and `backups:*`
channels are plain request and response calls, and the renderer shows a busy message until they
return. Design the pattern with the first channel that needs it and document it here.

## Channel reference

There are 87 channels. The renderer method is `window.mmap.<group>.<method>`; for example
`nodes:preview-delete` is `window.mmap.nodes.previewDelete` and `relationship-types:set-archived`
is `window.mmap.relationshipTypes.setArchived`. Every channel can also fail with
`FORBIDDEN_SENDER`, `INVALID_REQUEST` and `INTERNAL_ERROR`; the notes under each table list only
the other codes. Node, search, tag, relationship, map, graph, timeline, attachment and transfer
channels, `workspace:set-timezone`, and the backup channels that need the open workspace return
`WORKSPACE_MISSING` when no workspace is open.

### App

Services: `apps/desktop/src/main/services/app-info-service.ts` and `external-link-service.ts`.

| Channel                  | Purpose                                                      | Request                    | Response                                                     |
| ------------------------ | ------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------ |
| `app:get-info`           | Runtime and storage diagnostics for Settings, About.         | none                       | `AppInfo`: versions, `isPackaged`, SQLite version, FTS5 flag |
| `app:open-external-link` | Open a note link in the browser or mail client (Ctrl+click). | `{ href }` (≤ 2,048 chars) | `{ opened }`; `false` when the URL fails the link policy     |

`app:get-info` contains no paths, user names or workspace data, and is computed once per process.
`app:open-external-link` re-checks the URL with `normalizeLinkHref`
(`packages/domain/src/notes/link-policy.ts`): only absolute `http`, `https` and `mailto` URLs are
passed to `shell.openExternal`. `file:`, custom protocols, UNC paths, `javascript:` and relative
URLs return `{ opened: false }` without involving the OS.

### Workspace

Service: `apps/desktop/src/main/services/workspace-ipc-services.ts`, which calls
`WorkspaceManager` (`apps/desktop/src/main/workspaces/workspace-manager.ts`).

| Channel                   | Purpose                                                                                                                     | Request                                            | Response                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `workspace:get-state`     | Which workspace is open, or why none is.                                                                                    | none                                               | `WorkspaceState`                                        |
| `workspace:list-recent`   | Recent workspaces (up to 10) for the switcher.                                                                              | none                                               | `{ items: RecentWorkspace[] }`                          |
| `workspace:create`        | Create a workspace and switch to it.                                                                                        | `{ name, location: 'default' \| 'choose-folder' }` | `{ cancelled, state }`                                  |
| `workspace:open-folder`   | Pick an existing workspace folder in a native dialog, open it.                                                              | none                                               | `{ cancelled, state }`                                  |
| `workspace:open-recent`   | Switch to a workspace from the recent list.                                                                                 | `{ workspaceId }`                                  | `WorkspaceState`                                        |
| `workspace:forget-recent` | Remove an entry from the recent list. Never deletes files.                                                                  | `{ workspaceId }`                                  | `{ items: RecentWorkspace[] }`                          |
| `workspace:rename`        | Rename the open workspace (display name only, not the folder).                                                              | `{ name }`                                         | `WorkspaceState`                                        |
| `workspace:reveal-folder` | Open the workspace folder in Explorer.                                                                                      | none                                               | `{ revealed }`                                          |
| `workspace:move`          | Move the open workspace into a folder chosen in a native dialog: verified copy, open the copy, original to the Recycle Bin. | none                                               | `{ cancelled, state, originalRemoved, originalFolder }` |
| `workspace:delete`        | Move the open workspace folder to the Recycle Bin after the typed name matches.                                             | `{ confirmName }`                                  | `{ state }` (status `none`)                             |
| `workspace:set-timezone`  | Set the IANA timezone used to show dates and to read timeline date filters. Stored timestamps do not change.                | `{ timezone }` (1–100 chars)                       | `WorkspaceState`                                        |

`WorkspaceState` is one of `{ status: 'open', workspace }`,
`{ status: 'unavailable', reason, message, lastWorkspace }` (the last workspace could not be
opened; `reason` is a workspace error code) or `{ status: 'none' }`. `WorkspaceSummary` has `id`,
`name`, `folderPath`, `timezone`, `schemaVersion` and `cloudSyncProvider` (non-null when the folder
looks like a cloud-sync folder). `RecentWorkspace` has `workspaceId`, `name`, `folderPath`,
`lastOpenedAt`, `isAvailable` (the folder exists) and `isCurrent`.

`cancelled: true` means the user closed the native dialog; `state` is then the unchanged current
state. Errors: `create`, `open-folder` and `open-recent` can return any workspace code;
`forget-recent` returns `WORKSPACE_INVALID` for the open workspace; `create` and `rename` return
`VALIDATION_FAILED` for an empty name or one longer than 80 characters; `set-timezone` returns
`VALIDATION_FAILED` for a name the runtime's `Intl` does not know, and for offsets such as
`+02:00`, which are not IANA zones.

### Nodes

Service: `apps/desktop/src/main/services/node-ipc-services.ts`, which calls the domain
`KnowledgeNodeService` and `TagService`.

| Channel                | Purpose                                                     | Request                                                              | Response                                                                  |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `nodes:list`           | One page of the Library.                                    | `{ sort, limit (1–200), cursor?, tagIds? (≤ 20) }`                   | `{ items: NodeSummary[], nextCursor, totalCount }`                        |
| `nodes:get`            | Load a node for the detail panel.                           | `{ nodeId }`                                                         | `NodeView`                                                                |
| `nodes:create`         | Create a node (revision 1, empty note), optionally on maps. | `{ title, summary?, addToMaps? }`                                    | `NodeView`                                                                |
| `nodes:update`         | Autosave: change title, summary and/or note.                | `{ nodeId, expectedRevision, changes: { title?, summary?, note? } }` | `NodeView` with the new revision                                          |
| `nodes:duplicate`      | Copy title (as `<title> (copy)`), summary, note and tags.   | `{ nodeId }`                                                         | `NodeView` of the copy                                                    |
| `nodes:preview-delete` | Count what deleting a node would affect.                    | `{ nodeId }`                                                         | `{ relationships, referencingNotes, mapPlacements, attachments }`         |
| `nodes:delete`         | Delete a node and its managed attachment files.             | `{ nodeId, expectedRevision }`                                       | `{ deleted: true }`                                                       |
| `nodes:lookup`         | Title lookup for node pickers.                              | `{ text (≤ 200), limit? (1–50, default 8), excludeNodeIds? (≤ 50) }` | `{ items: { id, title }[] }`                                              |
| `nodes:backlinks`      | Notes that link to this node ("Linked from").               | `{ nodeId }`                                                         | `{ items: { sourceNodeId, sourceTitle, label, excerpt, occurrences }[] }` |
| `nodes:resolve-links`  | Current titles of wikilink targets that still exist.        | `{ nodeIds (≤ 1,000) }`                                              | `{ items: { id, title }[] }`                                              |
| `nodes:add-tag`        | Assign a tag by label, creating it if needed (idempotent).  | `{ nodeId, label }`                                                  | `{ tags: TagSummary[] }`                                                  |
| `nodes:remove-tag`     | Remove a tag from a node (idempotent).                      | `{ nodeId, tagId }`                                                  | `{ tags: TagSummary[] }`                                                  |

`sort` is `updated-desc`, `created-desc` or `title-asc`. `cursor` is the opaque `nextCursor` of the
previous page (keyset pagination). `tagIds` keeps only nodes that carry all the given tags, and
`totalCount` reflects the filter. `NodeSummary` has `id`, `title`, `createdAt`, `updatedAt` and
`tags`. `NodeView` adds `summary`, `note` (a validated note document) and `revision`.

`nodes:lookup` returns titles that start with the text first, then titles that contain it
elsewhere; ties are ordered by title length, title and ID. Matching is case-insensitive for ASCII
letters only, and `%`, `_` and `\` match literally. Empty or whitespace-only text returns no items.
`excludeNodeIds` removes nodes already chosen (for example the current node in the relationship
form).

`nodes:backlinks` returns one item per source note, ordered by source title, with the label and
excerpt of the first link in that note and the number of links (`occurrences`). A note that links
to itself is not listed. `nodes:resolve-links` returns only the IDs that exist in the open
workspace; an ID missing from the answer is a deleted (or foreign) target that the editor shows as
an unresolved link. It never fails with `NOT_FOUND`.

Errors: `NOT_FOUND` for unknown nodes (including `backlinks`); `VALIDATION_FAILED` for invalid
titles, summaries, notes or tag labels; `REVISION_CONFLICT` for `update` and `delete` with an
outdated `expectedRevision`. Tag changes do not bump the node revision.

### Search

Service: `apps/desktop/src/main/services/node-ipc-services.ts`, which calls `SqliteSearchIndex`
(`packages/storage-sqlite/src/search/sqlite-search-index.ts`) through the domain `SearchIndex`
port.

| Channel        | Purpose                                                   | Request                                                      | Response                                                          |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `search:query` | Ranked full-text search over titles, summaries and notes. | `{ text (≤ 1,000), tagIds? (≤ 20), limit (1–100), cursor? }` | `{ items: { nodeId, title, snippet }[], nextCursor, totalCount }` |

`snippet` is an array of `{ text, isMatch }` segments, never HTML; the renderer wraps matched
segments in `<mark>` elements as text. `tagIds` keeps only nodes that carry all the given tags, and
`totalCount` reflects the filter. Text without any letter or digit returns an empty page, not an
error. `cursor` is the opaque `nextCursor` of the previous page; unlike `nodes:list` it encodes a
result offset, because a BM25 score cannot serve as a stable keyset (see
[architecture.md](architecture.md#search)). A cursor that was not produced by the service returns
`VALIDATION_FAILED`.

### Relationship types

Service: `apps/desktop/src/main/services/relationship-ipc-services.ts`, which calls the domain
`RelationshipService` (`packages/domain/src/application/relationship-service.ts`).

| Channel                                 | Purpose                                        | Request                      | Response                            |
| --------------------------------------- | ---------------------------------------------- | ---------------------------- | ----------------------------------- |
| `relationship-types:list`               | All types of the workspace, with usage counts. | none                         | `{ items: RelationshipTypeView[] }` |
| `relationship-types:create`             | Create a custom type.                          | `{ label, directionality }`  | `RelationshipTypeView`              |
| `relationship-types:rename`             | Rename a type; relationships keep it.          | `{ typeId, label }`          | `RelationshipTypeView`              |
| `relationship-types:set-archived`       | Archive or restore a type.                     | `{ typeId, archived }`       | `RelationshipTypeView`              |
| `relationship-types:set-directionality` | Change direction; allowed only while unused.   | `{ typeId, directionality }` | `RelationshipTypeView`              |

`RelationshipTypeView` has `id`, `label`, `directionality` (`directed` or `undirected`),
`isArchived`, `isBuiltin` and `usageCount`. Labels follow the tag label rules (trimmed, collapsed
whitespace, at most 60 characters, unique by their NFKC lower-cased form). Types are listed by
normalized label. There is no delete channel: a type is archived instead.

Errors: `DUPLICATE` when `create` or `rename` clashes with another type's name;
`VALIDATION_FAILED` for an empty, too long or control-character label; `NOT_FOUND` for unknown
types; `INVARIANT_VIOLATION` from `set-directionality` when the type is used by at least one
relationship (the message tells the user to create a new type instead). Setting the same
direction again succeeds.

### Relationships

Service: `apps/desktop/src/main/services/relationship-ipc-services.ts`.

| Channel                       | Purpose                                                   | Request                                                                     | Response                        |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `relationships:list-for-node` | Every relationship in which the node is source or target. | `{ nodeId }`                                                                | `{ items: RelationshipView[] }` |
| `relationships:create`        | Create a relationship (explicit user action only).        | `{ sourceNodeId, targetNodeId, typeId, description? }`                      | `RelationshipView`              |
| `relationships:update`        | Change type or description, or reverse a directed one.    | `{ relationshipId, changes: { typeId?, description?, reverseDirection? } }` | `RelationshipView`              |
| `relationships:delete`        | Delete a relationship. Both nodes stay.                   | `{ relationshipId }`                                                        | `{ deleted: true }`             |

`RelationshipView` has `id`, `typeId`, `typeLabel`, `directionality`, `description`,
`source: { id, title }`, `target: { id, title }` and `createdAt`. For an undirected type, `source`
and `target` are the stored canonical order (lower ID first), not the order the request used.
`list-for-node` is ordered by type label, then by the other node's title. `reverseDirection` is
ignored for undirected types. An empty description is stored as `null`; the domain limit is 1,000
characters (the transport allows 10,000).

Errors:

- `DUPLICATE`: a relationship with the same stored endpoints and type already exists. This covers
  an exact repeat, the reversed copy of an undirected relationship, and an `update` (type change
  or reversal) that would collide with another relationship.
- `INVARIANT_VIOLATION`: source and target are the same node.
- `VALIDATION_FAILED`: the chosen type is archived (on `create`, or when `update` switches to an
  archived type; keeping the current archived type is allowed), or the description is too long.
- `NOT_FOUND`: unknown relationship, type or node, including IDs from another workspace.

### Tags

Service: `apps/desktop/src/main/services/node-ipc-services.ts`, which calls the domain
`TagService`.

| Channel       | Purpose                                                    | Request            | Response                                |
| ------------- | ---------------------------------------------------------- | ------------------ | --------------------------------------- |
| `tags:list`   | All tags of the workspace with usage counts.               | none               | `{ items: { id, label, nodeCount }[] }` |
| `tags:create` | Create a tag.                                              | `{ label }`        | `{ id, label }`                         |
| `tags:rename` | Rename a tag; every assignment is kept.                    | `{ tagId, label }` | `{ id, label }`                         |
| `tags:delete` | Delete a tag and its assignments. Nodes are never deleted. | `{ tagId }`        | `{ deleted: true }`                     |

Labels are trimmed, internal whitespace is collapsed, and they are limited to 60 characters
(`packages/domain/src/text/labels.ts`). Uniqueness uses the NFKC, lower-cased form, so `Physics`
and `PHYSICS` are the same tag while the first spelling is kept for display. `create` and `rename`
return `DUPLICATE` on a clash; `rename` and `delete` return `NOT_FOUND` for unknown tags.

### Attachments

Service: `apps/desktop/src/main/services/attachment-ipc-services.ts`.

| Channel              | Purpose                                                         | Request            | Response                                                                   |
| -------------------- | --------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| `attachments:add`    | Pick files in a native dialog and copy them into the workspace. | `{ nodeId }`       | `{ cancelled, added: AttachmentView[], rejected: { fileName, reason }[] }` |
| `attachments:list`   | Attachments of one node.                                        | `{ nodeId }`       | `{ items: AttachmentView[] }`                                              |
| `attachments:open`   | Open the managed copy with its default application.             | `{ attachmentId }` | `{ opened }`                                                               |
| `attachments:remove` | Delete the attachment record and its managed copy.              | `{ attachmentId }` | `{ removed: true }`                                                        |

`AttachmentView` has `id`, `nodeId`, `displayName` (the sanitized original name), `mimeType`,
`byteSize`, `previewable` and `createdAt`. Each selected file is handled on its own: files refused
by the policy (programs and scripts, empty files, unusable names, files above the size limit) or
by the store (unreadable, changed during the copy, disk full, no permission) appear in `rejected`
with a reason for the user, and never block the other files. `add` returns `NOT_FOUND` before
showing the dialog when the node no longer exists. `open` returns `{ opened: false }` when the
stored copy is missing or no longer passes the file-type policy. `open` and `remove` return
`NOT_FOUND` for unknown IDs. See [architecture.md](architecture.md#attachments) for the full flow.

Image previews do not use a channel. The renderer loads
`mmap-attachment://current/<attachmentId>` (`attachmentPreviewUrl()` in
`packages/contracts/src/attachments.ts`), served by the main process under the rules described in
the architecture page.

### Preferences

Machine-local settings, stored in `settings.json` in the Electron profile folder and never in a
workspace. The services are inline in `apps/desktop/src/main/index.ts`, backed by
`WorkspaceManager.getPreferences` and `updatePreferences`.

| Channel              | Purpose                         | Request                       | Response                     |
| -------------------- | ------------------------------- | ----------------------------- | ---------------------------- |
| `preferences:get`    | Read the preferences.           | none                          | `{ maxAttachmentMegabytes }` |
| `preferences:update` | Change one or more preferences. | `{ maxAttachmentMegabytes? }` | `{ maxAttachmentMegabytes }` |

`maxAttachmentMegabytes` is an integer from 1 to 1,024; the default is 20 (PRD §5.10).

### Mind maps

Service: `apps/desktop/src/main/services/map-ipc-services.ts`, which calls the domain `MapService`
(`packages/domain/src/application/map-service.ts`) and maps its records field by field to the
DTOs below. Schemas: `packages/contracts/src/maps.ts`. See
[architecture.md](architecture.md#mind-maps) for the rules behind these channels.

| Channel                     | Purpose                                                                                                                          | Request                                                                                      | Response                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| `maps:list`                 | All maps of the workspace, most recently changed first.                                                                          | none                                                                                         | `{ items: MapSummary[] }`          |
| `maps:create`               | Create an empty map (revision 1).                                                                                                | `{ title, mode? }` (`freeform` by default)                                                   | `MapView`                          |
| `maps:get`                  | Load a map for the editor.                                                                                                       | `{ mapId }`                                                                                  | `MapView`                          |
| `maps:rename`               | Rename a map.                                                                                                                    | `{ mapId, expectedRevision, title }`                                                         | `MapView`                          |
| `maps:duplicate`            | Copy as `<title> (copy)`: same nodes, new placements, structure copied.                                                          | `{ mapId }`                                                                                  | `MapView` of the copy              |
| `maps:list-for-node`        | Maps that show a node, by title.                                                                                                 | `{ nodeId }`                                                                                 | `{ items: { id, title, mode }[] }` |
| `maps:add-node`             | Add an existing node to 1–50 maps, each optionally under a parent; all or nothing. Maps already showing it are left as they are. | `{ nodeId, targets: { mapId, parentPlacementId }[] }`                                        | `{ items: { id, title, mode }[] }` |
| `maps:delete`               | Delete a map with its placements and connectors. Nodes stay.                                                                     | `{ mapId }`                                                                                  | `{ deleted: true }`                |
| `maps:set-viewport`         | Remember pan and zoom. No revision.                                                                                              | `{ mapId, viewport: { x, y, zoom } }`                                                        | `{ saved: true }`                  |
| `maps:add-placement`        | Place an existing node, or explicitly create a new node and place it.                                                            | `{ mapId, expectedRevision, nodeId \| newNodeTitle, x, y, parentPlacementId? }`              | `MapView`                          |
| `maps:remove-placement`     | Remove an item from the map; its children take its place. The node stays.                                                        | `{ mapId, expectedRevision, placementId }`                                                   | `MapView`                          |
| `maps:move-placements`      | Store freeform positions of one or more items.                                                                                   | `{ mapId, expectedRevision, changes: { placementId, x, y }[] (1–5,000) }`                    | `MapView`                          |
| `maps:reparent`             | Move an item under a parent (`null` = top level) at a sibling index.                                                             | `{ mapId, expectedRevision, placementId, parentPlacementId, index (0–5,000) }`               | `MapView`                          |
| `maps:set-collapsed`        | Collapse or expand an item's subtree.                                                                                            | `{ mapId, expectedRevision, placementId, collapsed }`                                        | `MapView`                          |
| `maps:set-placement-color`  | Set an item's color, or `null` for the default.                                                                                  | `{ mapId, expectedRevision, placementId, color }`                                            | `MapView`                          |
| `maps:add-connection`       | Draw a connector between two items.                                                                                              | `{ mapId, expectedRevision, sourcePlacementId, targetPlacementId, label?, relationshipId? }` | `MapView`                          |
| `maps:remove-connection`    | Delete a connector.                                                                                                              | `{ mapId, expectedRevision, connectionId }`                                                  | `MapView`                          |
| `maps:set-connection-label` | Write, change or remove (null or blank) the note on a connector; at most 200 characters.                                         | `{ mapId, expectedRevision, connectionId, label }`                                           | `MapView`                          |
| `maps:propose-hierarchy`    | Parents to review before switching: the kept hierarchy, or from connectors.                                                      | `{ mapId }`                                                                                  | `{ source, parents, ambiguous }`   |
| `maps:switch-mode`          | Switch between freeform and hierarchical mode.                                                                                   | `{ mapId, expectedRevision, mode, parents? (≤ 5,000) }`                                      | `MapView`                          |

`MapSummary` has `id`, `title`, `mode`, `revision`, `placementCount` and `updatedAt`. `MapView` has `map`
(`id`, `title`, `mode`, `viewport`, `revision`, `updatedAt`), `placements` and `connections`. A
placement has `id`, `nodeId`, `nodeTitle` (the node's current title, joined on every read; no
other node content), `x`, `y` (the freeform position), `parentPlacementId`, `siblingOrder`,
`isCollapsed` and `color` (`gray`, `blue`, `green`, `amber`, `red`, `violet` or `null`). A
connection has `id`, `sourcePlacementId`, `targetPlacementId`, `label`, `relationshipId` and
`relationshipTypeLabel` (the type of the referenced relationship, or `null`). `updatedAt` changes
with every structural change, but not with the viewport.

**Revisions.** Every channel that takes `expectedRevision` is a structural change. It runs in one
transaction, increments the map revision and returns the whole new `MapView`. An outdated
`expectedRevision` returns `REVISION_CONFLICT` and changes nothing. `create`, `duplicate`,
`delete`, `set-viewport` and `propose-hierarchy` take no revision.

**Adding.** `maps:add-placement` accepts exactly one of `nodeId` and `newNodeTitle` (two strict
object shapes in a union). With `newNodeTitle`, the node is created through the node service in
the same transaction, so a refused placement creates no node. The new item is appended after its
siblings.

**Proposals and switching.** `maps:propose-hierarchy` returns `source`, `parents` (one
`{ placementId, parentPlacementId }` per item, `null` = top level) and `ambiguous`
(`{ placementId, candidates }`). With `source: 'previous-hierarchy'` the map still has stored
parents from an earlier hierarchical period; they are returned unchanged and nothing is
ambiguous. With `source: 'connectors'` the parents are suggested from connectors, and `ambiguous`
lists items with connectors from several items or whose connector would close a loop; they are
proposed as top level. `maps:switch-mode` to `hierarchical` requires
`parents` with exactly one entry per item; switching to `freeform` ignores it and keeps the stored
hierarchy. Switching to the current mode succeeds and changes nothing but the revision.

**Connectors.** `relationshipId` must reference an existing relationship between exactly the two
nodes of the connector's items, in either direction. A connector never creates a relationship.

Limits: the contract accepts titles and labels up to 1,000 characters, coordinates between
−1,000,000 and 1,000,000 and a zoom up to 100. The domain applies the real limits with clear
messages: map titles 1–200 characters, connector labels up to 200 characters (empty means none),
new node titles as for `nodes:create`, a zoom from 0.05 to 8, and no control characters.

`MapView` also carries `relationships`: the semantic relationships whose two nodes are both on the
map (`{ id, sourceNodeId, targetNodeId, typeLabel, directionality }`). They are derived when the
map is read, never stored on the map, and never change its hierarchy or positions; the editor
draws them as their own kind of line and skips any already shown by a linked connector.

`nodes:create` accepts `addToMaps: [{ mapId, parentPlacementId | null }]` (at most 50 maps,
duplicates ignored). The node and its placements are created in one transaction: each map gets
one placement of the same node at a free spot near its other items (under the given parent in a
hierarchical map); a node already on a map is left in place. If any placement is rejected (for
example `NOT_FOUND` for a parent that no longer exists), nothing is created.

Errors:

- `NOT_FOUND`: unknown map, item, connector or node, including IDs from another workspace.
- `REVISION_CONFLICT`: outdated `expectedRevision` on a structural change.
- `DUPLICATE`: `add-placement` with a node that is already on the map.
- `INVARIANT_VIOLATION`: `reparent` or `switch-mode` would create a hierarchy cycle;
  `add-connection` from an item to itself.
- `VALIDATION_FAILED`: invalid title, label, coordinates, zoom or color; a `relationshipId` that is
  unknown or does not connect the two nodes; `switch-mode` to hierarchy without `parents`, with a
  missing entry, or with an unknown item.

### Knowledge graph

Service: `apps/desktop/src/main/services/graph-timeline-ipc-services.ts`, which calls the domain
`GraphService` (`packages/domain/src/application/graph-service.ts`) and maps its slices field by
field to the DTOs below. Schemas: `packages/contracts/src/graph-timeline.ts`. See
[architecture.md](architecture.md#knowledge-graph) for how slices are chosen.

| Channel                | Purpose                                                                                     | Request                                       | Response                            |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| `graph:overview`       | The best-connected nodes matching the filters, with the relationships and links among them. | `{ ...filters, maxNodes? (1–1,000) }`         | `GraphSlice`                        |
| `graph:neighborhood`   | One node and its direct neighbors, for expanding the view.                                  | `{ nodeId, ...filters }`                      | `GraphSlice`                        |
| `graph:get-positions`  | Saved graph positions of the given nodes; nodes without one are absent.                     | `{ nodeIds }` (≤ 5,000 UUIDs)                 | `{ positions: [{ nodeId, x, y }] }` |
| `graph:save-positions` | Stores graph positions (after placement, a drag or Rearrange).                              | `{ positions: [{ nodeId, x, y }] }` (1–5,000) | `{ saved: true }`                   |

Filters (all optional): `tagIds` (≤ 20 UUIDs, a node must carry all of them),
`relationshipTypeIds` (≤ 100 UUIDs; only these types, and only nodes taking part in one of them),
`mapIds` (≤ 200 UUIDs; only nodes placed on at least one of these mind maps, the union; empty or
absent means no map filter, so nodes on no map stay visible), `text` (`null` or a string; same
matching rules as search over title, summary and note text) and `includeReferences` (the
note-link layer, `false` by default). Neighborhoods apply the same filters to the neighbors.

`GraphSlice` has `nodes` (`id`, `title`, `degree`: relationships of the node within the type
filter, across the whole workspace; `mapIds`: the mind maps that place the node), `maps` (every
mind map of the workspace, ordered by title: `id`, `title`, `nodeCount`), `edges` (`id`,
`sourceNodeId`, `targetNodeId`, `typeId`, `typeLabel`, `directionality`), `references`
(`sourceNodeId`, `targetNodeId`, `occurrences`: one entry per linking note and target),
`totalNodes`, `edgesTruncated` and `referencesTruncated`. Map membership is never expressed as an
edge: two nodes on the same map are not connected unless a relationship or note link connects
them.

**Positions.** Graph positions are visual state of the knowledge graph only, stored in
`graph_node_positions` and never in mind map placements. Coordinates must be finite numbers within
±1,000,000 and a call carries at most 5,000 positions or IDs; the contract refuses anything else
with `INVALID_REQUEST`, and `GraphService` checks the same bounds again (`VALIDATION_FAILED`).
Positions of nodes that no longer exist, or belong to another workspace, are silently skipped
when saving and never returned when reading. There is no channel for the viewport: the graph
always opens fitted to view.

**Limits and completeness.** The overview returns at most 1,000 nodes (`maxNodes` can only lower
this), ranked by degree, then title, then ID. A neighborhood returns the node first and at most
200 neighbors. Each returns at most 3,000 relationships and 3,000 references among the returned
nodes. `totalNodes` is the number of matching nodes in the workspace (overview) or of matching
neighbors (neighborhood, not counting the node itself), and the two flags say whether
relationships or references between returned nodes were left out. A client must compare
`nodes.length` with `totalNodes` and read the flags before presenting a view as complete.

Limits: the contract accepts `text` up to 1,000 characters; the domain refuses more than 500
after trimming with `VALIDATION_FAILED`. Text without a searchable word returns an empty slice.

Errors: `NOT_FOUND` for an unknown `nodeId` in `graph:neighborhood`, including a node of another
workspace; `VALIDATION_FAILED` for filter text that is too long.

### Timeline

Same service file; it calls the domain `TimelineService`
(`packages/domain/src/application/timeline-service.ts`). See
[architecture.md](architecture.md#learning-timeline).

| Channel                  | Purpose                                                                                    | Request                                                                                       | Response                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `timeline:list`          | Recorded activity, reviews and milestones, newest first by effective time, one page.       | `{ limit (1–200), cursor?, fromDate?, toDate?, eventTypes? (≤ 10), tagIds? (≤ 20), nodeId? }` | `{ items: TimelineEntry[], nextCursor }` |
| `timeline:window`        | The events of one time range of the visual timeline, oldest first, with their total.       | `{ fromUtc, toUtcExclusive, eventTypes?, tagIds?, nodeId? }`                                  | `{ items: TimelineEntry[], total }`      |
| `timeline:mark-reviewed` | Record that the user reviewed a node, with an optional reflection and learning date.       | `{ nodeId, reflection?, learnedAt? }`                                                         | `TimelineEntry`                          |
| `timeline:add-milestone` | Add a learning milestone, optionally about one node.                                       | `{ title, details?, nodeId?, learnedAt? }`                                                    | `TimelineEntry`                          |
| `timeline:update-entry`  | Change the title or reflection of the user's own entry, or the learning date of any entry. | `{ eventId, title?, reflection?, learnedAt? }`                                                | `TimelineEntry`                          |
| `timeline:delete-entry`  | Delete one of the user's own entries (a review or a milestone). Nodes are not changed.     | `{ eventId }`                                                                                 | `{ deleted: true }`                      |

`timeline:update-entry` and `timeline:delete-entry` replace the earlier
`timeline:update-reflection` and `timeline:delete-reviewed`.

**Two times per event.** `occurredAt` is when the action was recorded; it never changes.
`learnedAt` is an optional moment, chosen by the user, when the learning actually happened (for
example, a review recorded today of something learned last week). The effective time is
`learnedAt ?? occurredAt`: the list and the window place, order, filter and page events by it. A
learning date can be set or cleared on any event, recorded activity included, because it annotates
the record rather than changing it.

**Ownership.** Reviews (`reviewed`) and milestones (`milestone`) belong to the user: their
reflection, and a milestone's title, can be edited, and they can be deleted. Recorded activity
(`node_created`, `note_updated`, `relationship_created`) cannot be edited or deleted; only its
learning date can be set or cleared.

**List.** `fromDate` and `toDate` are calendar dates `YYYY-MM-DD` in the workspace timezone
(either may be `null` or left out); the main process converts them to a UTC range that covers the
whole local days, including 23- and 25-hour days, and compares it with the effective time.
`eventTypes` takes `node_created`, `note_updated`, `relationship_created`, `reviewed` and
`milestone`; empty means all. `tagIds` keeps events of nodes that carry all those tags now. The
cursor is opaque (keyset: effective time and ID of the last row); pass `nextCursor` back
unchanged.

**Window.** `fromUtc` and `toUtcExclusive` are UTC instants (ISO 8601) bounding a half-open range
of effective times; the filters work as in the list. The response holds at most 2,000 events,
oldest first, and `total`, the number of matching events in the range. When the range holds more
than 2,000, the events are taken evenly across it: the range is split into 200 time buckets and
events are taken round-robin (the latest event of every bucket, then the second latest, and so
on), so a burst of activity never hides a quieter period. A client must compare `items.length`
with `total` before presenting a window as complete.

**Milestones.** `title` is required: whitespace is collapsed and trimmed, and the result must be
1–200 characters without control characters. `details` follows the reflection rules and is stored
as the milestone's reflection. `nodeId` is optional. Without `learnedAt`, the milestone is placed
at the time it was added.

`TimelineEntry` has `id`, `eventType`, `occurredAt` (UTC; when the action was recorded, the start
of an editing session), `lastActivityAt` (UTC; the latest save of a session, otherwise equal to
`occurredAt`), `learnedAt` (UTC, or `null` when not set), `title` (a milestone's title, `null` for
other events), `nodeId` (`null` when the node was deleted or the event has no node), `nodeTitle`
(the node's current title, or the title recorded with the event when the node is gone),
`reflection` and `isImported`. The workspace ID and `import_origin` are never sent.

Limits: the contract accepts reflections and details up to 10,000 characters and titles up to
1,000; the domain trims reflections, treats an empty one as none, keeps line breaks and tabs, and
refuses more than 2,000 characters or other control characters with `VALIDATION_FAILED`. A
`learnedAt` must be a valid instant, not in the future (5 minutes of clock difference are
tolerated) and not before 1900; in `update-entry`, `null` clears it and the event returns to its
recorded time.

Errors:

- `NOT_FOUND`: unknown node (`mark-reviewed`, `add-milestone`) or event (`update-entry`,
  `delete-entry`), including IDs from another workspace.
- `INVARIANT_VIOLATION`: `update-entry` changing the title or reflection of recorded activity, or
  `delete-entry` on recorded activity. Only reviews and milestones can be changed or removed.
- `VALIDATION_FAILED`: a date that is not a real calendar date, a start date after the end date, a
  window that does not end after it starts, a malformed cursor, an invalid reflection, title or
  learning date, or a title on an event that is not a milestone.

### Export and import

Service: `apps/desktop/src/main/services/transfer-ipc-services.ts`, which calls
`apps/desktop/src/main/portability/` (`export-workspace.ts`, `export-markdown.ts`,
`import-workspace.ts`). Schemas: `packages/contracts/src/transfer.ts`. See
[architecture.md](architecture.md#export-and-import) and
[ADR-0011](adr/0011-export-import.md) for the archive format and the import rules.

| Channel                    | Purpose                                                                                  | Request                                   | Response                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `transfer:export-zip`      | Ask where to save (native dialog), then write the lossless ZIP archive of the workspace. | `{}`                                      | `{ status: 'cancelled' }` or `{ status: 'exported', fileName, counts, warnings }`                                                    |
| `transfer:export-markdown` | Ask where to save, then write the readable Markdown export (a ZIP of `.md` files).       | `{}`                                      | `{ status: 'cancelled' }` or `{ status: 'exported', fileName, nodes, attachments, warnings }`                                        |
| `transfer:preview-import`  | Ask for an archive, validate all of it and describe the import. Changes nothing.         | `{}`                                      | `{ status: 'cancelled' }` or `{ status: 'ready', importToken, fileName, source, summary, warnings, previousImports, sameWorkspace }` |
| `transfer:apply-import`    | Perform a previewed import.                                                              | `{ importToken (UUID), acceptDuplicate }` | `{ summary }`                                                                                                                        |
| `transfer:discard-import`  | Forget a previewed import (the user cancelled after the preview).                        | `{ importToken (UUID) }`                  | `{ discarded: true }`                                                                                                                |

**Exports.** The save dialog proposes `<workspace name> <YYYY-MM-DD>.mmap.zip` or
`<workspace name> <YYYY-MM-DD> Markdown.zip` in Documents. `counts` has the number of nodes, tags,
relationship types, relationships, maps, placements, connections, timeline events and attachments
written. `warnings` are English sentences for the user, for example attachments left out because
their file is missing from the workspace folder or no longer matches its checksum. `fileName` is
the chosen file's name only.

**Two-step import.** `transfer:preview-import` validates the whole archive (see
[architecture.md](architecture.md#import)) and keeps it open in the main process under a random
`importToken`. Only one import is pending at a time: a new preview discards the previous one, and
a token stops working after 10 minutes, when another workspace is open, or once it was applied or
discarded. `source` has `workspaceName`, `exportedAt` and `appVersion` from the archive's
manifest. `summary` counts what would be added: `nodes`, `newTags`, `reusedTags`,
`newRelationshipTypes`, `reusedRelationshipTypes`, `relationships`, `maps`, `placements`,
`connections`, `timelineEvents` and `attachments`. `warnings` lists, for example, relationship
types renamed because their direction differs, links to nodes outside the archive, and
attachments that are not imported. `previousImports` holds the UTC times of earlier imports of the
same archive into this workspace (empty if never); `sameWorkspace` is true when the archive was
exported from the open workspace.

**Duplicates.** When `previousImports` is not empty, `transfer:apply-import` requires
`acceptDuplicate: true`, meaning the user saw the warning and chose to import again; otherwise it
returns `DUPLICATE` and the import stays pending. Archives are recognised by the export ID in
their manifest, so a new export of the same data is not a duplicate.

Errors:

- `WORKSPACE_MISSING`: no workspace is open (all channels except `transfer:discard-import`, which
  always succeeds).
- `TRANSFER_FAILED`: the export file or an imported attachment could not be written (disk full,
  no permission).
- `ARCHIVE_INVALID`, `ARCHIVE_UNSAFE`, `ARCHIVE_TOO_LARGE`, `ARCHIVE_TOO_NEW`,
  `ARCHIVE_CHECKSUM_MISMATCH`: the archive was refused by `preview-import`, or an attachment's
  bytes did not match during `apply-import`. Nothing was changed.
- `VALIDATION_FAILED`: the archive is well-formed but inconsistent (for example a relationship to
  a node that is not in it, a hierarchy cycle, an invalid title or note), or holds notes from a
  newer note schema.
- `IMPORT_EXPIRED`: `apply-import` with an unknown, expired or replaced token.
- `DUPLICATE`: `apply-import` of an archive imported before, without `acceptDuplicate`.

### Backups

Service: `apps/desktop/src/main/services/backup-ipc-services.ts`, which calls `BackupService`
(`apps/desktop/src/main/backups/backup-service.ts`). Schemas: `packages/contracts/src/backups.ts`.
See [architecture.md](architecture.md#backups-and-restore) and the
[backup and restore runbook](runbooks/backup-and-restore.md).

| Channel                           | Purpose                                                                                    | Request                            | Response                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------ |
| `backups:get-status`              | Destination, retention, last success and failure, and the snapshots of the workspace.      | `{}`                               | `BackupStatus`                                               |
| `backups:create-now`              | Take a backup now (Settings › Back up now).                                                | `{}`                               | `BackupStatus`                                               |
| `backups:choose-destination`      | Pick the backup folder in a native dialog; cancelling changes nothing.                     | `{}`                               | `BackupStatus`                                               |
| `backups:use-default-destination` | Go back to the default folder, `<userData>/backups`.                                       | `{}`                               | `BackupStatus`                                               |
| `backups:set-retention`           | Set how many daily and weekly snapshots to keep, then prune.                               | `{ daily (0–60), weekly (0–104) }` | `BackupStatus`                                               |
| `backups:restore`                 | Replace the open workspace's content with one of its snapshots, after a safety backup.     | `{ snapshotId }` (1–64 chars)      | `{ state: WorkspaceState }`                                  |
| `backups:restore-from-folder`     | Pick a snapshot folder in a native dialog and restore it as a new workspace, then open it. | `{}`                               | `{ status: 'cancelled' }` or `{ status: 'restored', state }` |

`BackupStatus` has `destination` (the backup folder, for display), `isDefaultDestination`,
`sameDriveAsWorkspace` (the destination is on the workspace's drive, so a drive failure would lose
both), `retention` (`daily`, `weekly`), `running`, `lastSuccessAt` (the newest snapshot on disk,
or `null`), `lastFailure` (`{ at, message }` of the last failed backup since the app started, or
`null`) and `snapshots`, newest first: `id`, `createdAt`, `attachmentCount`, `missingAttachments`
(files missing or changed in the workspace when the snapshot was taken) and `databaseBytes`.

`backups:create-now` does not fail when the backup fails: the failure is recorded and returned in
`lastFailure`, as for the automatic daily backup. Backup operations run one at a time.

Errors:

- `WORKSPACE_MISSING`: no workspace is open (every channel except `restore-from-folder`).
- `BACKUP_FAILED`: the safety backup before a restore could not be written.
- `BACKUP_DAMAGED`: `restore` with a snapshot ID that is not (or no longer) in the list, or a
  snapshot whose database or files do not match their checksums; `restore-from-folder` with a
  folder that is not a complete backup.
- `ARCHIVE_TOO_NEW`: the backup was made by a newer mmap version.
- `RESTORE_FAILED`: the restored workspace could not be put in place or opened, a file in the
  workspace folder is in use, or `restore-from-folder` was given a backup of the open workspace
  (restore it from the list instead). The workspace is unchanged.
