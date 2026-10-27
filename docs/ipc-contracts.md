# IPC contracts

The renderer talks to the main process only through typed IPC channels defined in
`packages/contracts`. This page explains the pattern, the result envelope and error codes, how to
add a channel, and lists every channel that exists. For the end-to-end path of a single call, see
[architecture.md](architecture.md#request-flow-one-ipc-call-end-to-end).

## The contract catalogue

| File                                     | Contents                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/contracts/src/channels.ts`     | `IPC_CHANNELS`: the allow-list of channel names. No dependencies, so the preload can import it. |
| `packages/contracts/src/app-info.ts`     | `app:*` schemas (diagnostics, external links).                                                  |
| `packages/contracts/src/workspace.ts`    | `workspace:*` schemas and `WORKSPACE_ERROR_CODES`.                                              |
| `packages/contracts/src/nodes.ts`        | `nodes:*` and `tags:*` schemas.                                                                 |
| `packages/contracts/src/attachments.ts`  | `attachments:*` and `preferences:*` schemas, the preview URL scheme.                            |
| `packages/contracts/src/catalogue.ts`    | `IPC_CATALOGUE`: pairs each channel with `{ request, response }` schemas.                       |
| `packages/contracts/src/envelope.ts`     | `IpcResult<Data>`, `ipcErrorSchema`, the combined list of error codes.                          |
| `packages/contracts/src/renderer-api.ts` | `MmapRendererApi`: the type of `window.mmap`.                                                   |

Rules the code relies on:

- **Channel names** follow `<area>:<verb-noun>`, for example `nodes:preview-delete`.
- **Catalogue completeness.** `IPC_CATALOGUE` is declared with
  `satisfies Record<IpcChannel, IpcContract>`, so TypeScript fails if a channel has no contract.
  `catalogue.test.ts` also checks that the catalogue has exactly the channels in `IPC_CHANNELS`.
- **Strict schemas.** Object schemas use `z.strictObject`, so unexpected properties are rejected
  instead of silently dropped. A channel with no argument uses `z.undefined()`.
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

Paths do travel the other way, for display only: `WorkspaceSummary.folderPath` and
`RecentWorkspace.folderPath` let Settings show where a workspace lives (PRD §5.1).

### Note JSON is untrusted input

`nodes:update` accepts `changes.note` as `z.unknown()`. The contract deliberately does not repeat
the note schema: the single authority is `parseNoteDocument` in
`packages/domain/src/notes/note-document.ts`, which the node service runs before anything is read
or written. It rejects unknown node types and marks, unsafe link schemes, prototype tricks and
oversized documents with `VALIDATION_FAILED`. Duplicating that recursive schema in zod would create
two rule sets that could drift apart (PRD §10.1). The response side uses a loose `z.custom` check
for `note` for the same reason; stored notes are parsed again by the domain when they are read.

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
`WorkspaceError` (`apps/desktop/src/main/workspaces/workspace-errors.ts`). Transport codes come
from `packages/contracts/src/envelope.ts` and are produced by the IPC handler itself
(`apps/desktop/src/main/ipc/ipc-handler.ts`).

| Code                             | Source    | Meaning                                                                                                        |
| -------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`              | Domain    | Input failed a domain rule: empty or too long title, invalid tag name, invalid note document.                  |
| `NOT_FOUND`                      | Domain    | The record does not exist in the open workspace. IDs from another workspace also produce this.                 |
| `REVISION_CONFLICT`              | Domain    | `expectedRevision` is not the stored revision; a newer version was saved first. Nothing was changed.           |
| `DUPLICATE`                      | Domain    | A uniqueness rule was violated, for example creating or renaming a tag to an existing name.                    |
| `INVARIANT_VIOLATION`            | Domain    | A business invariant was violated, for example a self-link. No Phase 1 channel produces it yet.                |
| `WORKSPACE_MISMATCH`             | Domain    | A record from another workspace was referenced. No Phase 1 channel produces it (services answer `NOT_FOUND`).  |
| `WORKSPACE_MISSING`              | Workspace | The folder or drive is gone, or no workspace is open when a node, tag or attachment call arrives.              |
| `WORKSPACE_INVALID`              | Workspace | The folder is not an mmap workspace, its manifest is damaged, or the open workspace was asked to be forgotten. |
| `WORKSPACE_TOO_NEW`              | Workspace | The manifest or database was written by a newer mmap version.                                                  |
| `WORKSPACE_LOCKED`               | Workspace | Another live process on this computer, or another computer, holds the workspace lock.                          |
| `WORKSPACE_FOLDER_NOT_EMPTY`     | Workspace | A new workspace was requested in a folder that already has files, or no free folder name was found.            |
| `WORKSPACE_UNSUPPORTED_LOCATION` | Workspace | A network (UNC) path, or a location where SQLite cannot enable WAL mode.                                       |
| `WORKSPACE_DAMAGED`              | Workspace | The database file is missing, cannot be opened or upgraded, or does not match the manifest.                    |
| `WORKSPACE_MOVE_FAILED`          | Workspace | Moving failed; the copy was discarded and the original is open and unchanged.                                  |
| `WORKSPACE_DELETE_FAILED`        | Workspace | The folder could not be moved to the Recycle Bin (or no longer belongs to the workspace); nothing was deleted. |
| `INVALID_REQUEST`                | Transport | The payload did not match the channel's request schema. The service was not called.                            |
| `FORBIDDEN_SENDER`               | Transport | The call did not come from the main frame of a trusted origin. The service was not called.                     |
| `INTERNAL_ERROR`                 | Transport | Anything unexpected, including a response that failed its schema. Logged locally, redacted.                    |

How the handler chooses a result:

1. Untrusted sender → `FORBIDDEN_SENDER`.
2. Request fails its schema → `INVALID_REQUEST`.
3. Service throws a `DomainError` or a `WorkspaceError` → its `code` and `message` (both classes
   must therefore be written to be safe for display).
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

Long-running operations (import, export, backup) will also need progress events, cancellation and
idempotency keys (PRD §7.2). That pattern does not exist yet; design it with the first channel
that needs it and document it here.

## Channel reference

There are 29 channels. The renderer method is `window.mmap.<group>.<method>`; for example
`nodes:preview-delete` is `window.mmap.nodes.previewDelete`. Every channel can also fail with
`FORBIDDEN_SENDER`, `INVALID_REQUEST` and `INTERNAL_ERROR`; the notes under each table list only
the other codes. Node, tag and attachment channels return `WORKSPACE_MISSING` when no workspace is
open.

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

`WorkspaceState` is one of `{ status: 'open', workspace }`,
`{ status: 'unavailable', reason, message, lastWorkspace }` (the last workspace could not be
opened; `reason` is a workspace error code) or `{ status: 'none' }`. `WorkspaceSummary` has `id`,
`name`, `folderPath`, `timezone`, `schemaVersion` and `cloudSyncProvider` (non-null when the folder
looks like a cloud-sync folder). `RecentWorkspace` has `workspaceId`, `name`, `folderPath`,
`lastOpenedAt`, `isAvailable` (the folder exists) and `isCurrent`.

`cancelled: true` means the user closed the native dialog; `state` is then the unchanged current
state. Errors: `create`, `open-folder` and `open-recent` can return any workspace code;
`forget-recent` returns `WORKSPACE_INVALID` for the open workspace; `create` and `rename` return
`VALIDATION_FAILED` for an empty name or one longer than 80 characters.

### Nodes

Service: `apps/desktop/src/main/services/node-ipc-services.ts`, which calls the domain
`KnowledgeNodeService` and `TagService`.

| Channel                | Purpose                                                    | Request                                                              | Response                                                          |
| ---------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `nodes:list`           | One page of the Library.                                   | `{ sort, limit (1–200), cursor?, tagIds? (≤ 20) }`                   | `{ items: NodeSummary[], nextCursor, totalCount }`                |
| `nodes:get`            | Load a node for the detail panel.                          | `{ nodeId }`                                                         | `NodeView`                                                        |
| `nodes:create`         | Create a node (revision 1, empty note).                    | `{ title, summary? }`                                                | `NodeView`                                                        |
| `nodes:update`         | Autosave: change title, summary and/or note.               | `{ nodeId, expectedRevision, changes: { title?, summary?, note? } }` | `NodeView` with the new revision                                  |
| `nodes:duplicate`      | Copy title (as `<title> (copy)`), summary, note and tags.  | `{ nodeId }`                                                         | `NodeView` of the copy                                            |
| `nodes:preview-delete` | Count what deleting a node would affect.                   | `{ nodeId }`                                                         | `{ relationships, referencingNotes, mapPlacements, attachments }` |
| `nodes:delete`         | Delete a node and its managed attachment files.            | `{ nodeId, expectedRevision }`                                       | `{ deleted: true }`                                               |
| `nodes:add-tag`        | Assign a tag by label, creating it if needed (idempotent). | `{ nodeId, label }`                                                  | `{ tags: TagSummary[] }`                                          |
| `nodes:remove-tag`     | Remove a tag from a node (idempotent).                     | `{ nodeId, tagId }`                                                  | `{ tags: TagSummary[] }`                                          |

`sort` is `updated-desc`, `created-desc` or `title-asc`. `cursor` is the opaque `nextCursor` of the
previous page (keyset pagination). `tagIds` keeps only nodes that carry all the given tags, and
`totalCount` reflects the filter. `NodeSummary` has `id`, `title`, `createdAt`, `updatedAt` and
`tags`. `NodeView` adds `summary`, `note` (a validated note document) and `revision`.

Errors: `NOT_FOUND` for unknown nodes; `VALIDATION_FAILED` for invalid titles, summaries, notes or
tag labels; `REVISION_CONFLICT` for `update` and `delete` with an outdated `expectedRevision`.
Tag changes do not bump the node revision.

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
