# IPC contracts

The renderer talks to the main process only through typed IPC channels defined in
`packages/contracts`. This page explains the pattern, the result envelope and error codes, how to
add a channel, and lists every channel that exists. For the end-to-end path of a single call, see
[architecture.md](architecture.md#request-flow-one-ipc-call-end-to-end).

## The contract catalogue

| File                                     | Contents                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/contracts/src/channels.ts`     | `IPC_CHANNELS`: the allow-list of channel names. No dependencies, so the preload can import it. |
| `packages/contracts/src/<area>.ts`       | zod request and response schemas for one area, e.g. `app-info.ts`.                              |
| `packages/contracts/src/catalogue.ts`    | `IPC_CATALOGUE`: pairs each channel with `{ request, response }` schemas.                       |
| `packages/contracts/src/envelope.ts`     | `IpcResult<Data>`, `ipcErrorSchema`, error codes.                                               |
| `packages/contracts/src/renderer-api.ts` | `MmapRendererApi`: the type of `window.mmap`.                                                   |

Rules the code relies on:

- **Channel names** follow `<area>:<verb-noun>`, for example `app:get-info`.
- **Catalogue completeness.** `IPC_CATALOGUE` is declared with
  `satisfies Record<IpcChannel, IpcContract>`, so TypeScript fails if a channel has no contract.
  `catalogue.test.ts` also checks that the catalogue has exactly the channels in `IPC_CHANNELS`.
- **Strict schemas.** Object schemas use `z.strictObject`, so unexpected properties are rejected
  instead of silently dropped. A channel with no argument uses `z.undefined()`.
- **Both directions are validated.** The main process parses the request before the service runs
  and the response before it leaves. Response validation is what stops a service bug from leaking
  an extra field, such as a file path, to the renderer.
- **No generic invoke.** The renderer never names a channel; it calls a method such as
  `window.mmap.app.getInfo()`.
- **DTOs only.** Payloads are plain data. Never pass SQL, filesystem paths chosen by the
  renderer, shell commands or functions across the bridge (PRD §7.2).

## Result envelope

Electron flattens errors thrown inside `ipcMain.handle` into a string, losing the code and
possibly leaking internals. So handlers never throw to the renderer. Every call resolves with:

```ts
type IpcResult<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly error: { code: IpcErrorCode; message: string } };
```

`message` is English text safe to show to the user. It never contains stack traces, note content
or paths.

## Error codes

Domain codes come from `packages/domain/src/errors.ts` and are produced when a service throws a
`DomainError`. Transport codes come from `packages/contracts/src/envelope.ts` and are produced by
the IPC handler itself (`apps/desktop/src/main/ipc/ipc-handler.ts`).

| Code                  | Source    | Meaning                                                                                     |
| --------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`   | Domain    | Input failed a domain validation rule (shape, length, format).                              |
| `NOT_FOUND`           | Domain    | The record does not exist in the active workspace.                                          |
| `REVISION_CONFLICT`   | Domain    | Optimistic revision check failed; a newer version was saved first.                          |
| `DUPLICATE`           | Domain    | A uniqueness rule was violated, e.g. a duplicate relationship or tag.                       |
| `INVARIANT_VIOLATION` | Domain    | A business invariant was violated, e.g. a self-link or a hierarchy cycle.                   |
| `WORKSPACE_MISMATCH`  | Domain    | A record from another workspace was referenced.                                             |
| `INVALID_REQUEST`     | Transport | The payload did not match the channel's request schema. The service was not called.         |
| `FORBIDDEN_SENDER`    | Transport | The call did not come from the main frame of a trusted origin. The service was not called.  |
| `INTERNAL_ERROR`      | Transport | Anything unexpected, including a response that failed its schema. Logged locally, redacted. |

Phase 0 services only ever produce the transport codes; the domain codes are defined now so that
later phases and a future HTTP transport share one vocabulary.

How the handler chooses a result:

1. Untrusted sender → `FORBIDDEN_SENDER`.
2. Request fails its schema → `INVALID_REQUEST`.
3. Service throws a `DomainError` → its `code` and `message` (domain messages must therefore be
   written to be safe for display).
4. Service throws anything else, or its result fails the response schema → `INTERNAL_ERROR` with a
   generic message, and `logFailure` records the channel and error class name only.
5. Otherwise → `{ ok: true, data }` with the parsed response.

If the IPC call itself rejects (for example no handler is registered), the promise from
`window.mmap` rejects. The renderer must catch that; `SettingsView` turns it into a local
`INTERNAL_ERROR` state.

## Adding a channel

Every new channel needs a contract schema, sender validation, a handler test and a documentation
entry (implementation plan §4). Work through these steps in order.

1. **Name.** Add the channel to `IPC_CHANNELS` in `packages/contracts/src/channels.ts`, following
   `<area>:<verb-noun>`.
2. **Schemas.** Create or extend `packages/contracts/src/<area>.ts` with a request schema and a
   response schema. Use `z.strictObject`, bound string lengths and array sizes, and use branded or
   UUID-checked IDs. Export both from `packages/contracts/src/index.ts`.
3. **Catalogue.** Add `{ request, response }` for the channel to `IPC_CATALOGUE` in
   `packages/contracts/src/catalogue.ts`. TypeScript will not compile until you do.
4. **Service.** Write the application service in `apps/desktop/src/main/services/` as a function
   taking the parsed request and returning a promise of the response. Throw `DomainError` for
   expected failures. Keep domain rules in `packages/domain` and SQL in `packages/storage-sqlite`;
   the service only orchestrates.
5. **Register.** Add the service to the object passed to `registerIpcHandlers` in
   `apps/desktop/src/main/index.ts` (the `IpcServices` type forces this). Nothing else is needed:
   `registerIpcHandlers` loops over `IPC_CHANNELS` and wraps each service with `createIpcHandler`.
6. **Preload API.** Add the method to `MmapRendererApi` in
   `packages/contracts/src/renderer-api.ts`, returning `Promise<IpcResult<Response>>`. Implement it
   in `apps/desktop/src/preload/index.ts` as `ipcRenderer.invoke(IPC_CHANNELS.yourChannel, request)`.
   Do not add logic, validation libraries or Node imports to the preload; the architecture rules
   reject Node built-ins, storage and UI code there.
7. **Tests.**
   - Contract tests in `packages/contracts/src/`: valid payloads pass; extra properties, wrong
     types and hostile values (paths, SQL text, oversized strings) fail; responses with extra
     fields fail.
   - Handler or service tests in `apps/desktop/src/main/`: untrusted sender and invalid payload
     never reach the service, domain errors map to their codes, unexpected errors become
     `INTERNAL_ERROR`. See `ipc/ipc-handler.test.ts` for the pattern.
   - Storage behaviour behind the service is tested against real temporary SQLite databases
     ([testing.md](testing.md)).
8. **Docs.** Add the channel to the [channel reference](#channel-reference) below.

Long-running operations (import, export, backup) will also need progress events, cancellation and
idempotency keys (PRD §7.2). That pattern does not exist yet; design it with the first channel
that needs it and document it here.

## Channel reference

### `app:get-info`

Runtime and storage diagnostics shown in Settings ("About this installation").

|                 |                                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| Renderer method | `window.mmap.app.getInfo()`                                                  |
| Request         | none (`z.undefined()`; any payload returns `INVALID_REQUEST`)                |
| Response        | `AppInfo`, `packages/contracts/src/app-info.ts`                              |
| Service         | `createAppInfoService`, `apps/desktop/src/main/services/app-info-service.ts` |
| Errors          | `FORBIDDEN_SENDER`, `INVALID_REQUEST`, `INTERNAL_ERROR`                      |

Response fields:

| Field                         | Type    | Notes                                                       |
| ----------------------------- | ------- | ----------------------------------------------------------- |
| `appVersion`                  | string  | From `app.getVersion()`                                     |
| `isPackaged`                  | boolean | `false` in development; Settings then shows "(development)" |
| `platform`, `arch`            | string  | `process.platform`, `process.arch`                          |
| `electronVersion`             | string  |                                                             |
| `chromeVersion`               | string  |                                                             |
| `nodeVersion`                 | string  | Electron's bundled Node                                     |
| `storage.sqliteVersion`       | string  | From `sqlite_version()` in an in-memory database            |
| `storage.fts5Available`       | boolean | Whether an FTS5 virtual table can be created                |
| `storage.latestSchemaVersion` | integer | Highest schema version this build can migrate to            |

The response deliberately contains no paths, user names or workspace data, so it is safe to show
and to include in a future diagnostics export (PRD §8). The value is computed once per process and
cached. The packaged smoke test calls this channel to prove the preload bridge and IPC work in the
installed runtime.
