# Architecture overview

This page explains how the Phase 0 code is organized, how a request travels from the UI to the
storage engine, and how the security baseline from
[ADR-0003](adr/0003-electron-version-and-security-baseline.md) is implemented. It describes the
code as it exists today; later phases are listed separately at the end.

## Packages and dependency rules

The repository is an npm-workspaces monorepo
([ADR-0001](adr/0001-monorepo-and-module-boundaries.md)).

| Package                   | Responsibility                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| `packages/domain`         | IDs, clock, error model, relationship rules, ports (repository, search, etc.)  |
| `packages/contracts`      | IPC channel names, zod schemas per channel, result envelope, renderer API type |
| `packages/storage-sqlite` | `node:sqlite` connection settings, migration runner, schema, capability probe  |
| `apps/desktop`            | Electron main process, preload bridge, React renderer, packaging, smoke test   |

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
   | @mmap/contracts               | channels and types only         | contracts, storage-sqlite,
   | no electron, Node, SQLite     | no Node, SQLite or UI code      | domain, electron, Node
```

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

| Part     | Source                      | Runs as                                       | Role                                                                                         |
| -------- | --------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Main     | `apps/desktop/src/main`     | Node (ESM bundle `out/main/index.js`)         | Composition root, window creation, security policy, `app://` protocol, IPC handlers, storage |
| Preload  | `apps/desktop/src/preload`  | Sandboxed, context-isolated (CJS `index.cjs`) | Exposes `window.mmap` with named, typed methods only                                         |
| Renderer | `apps/desktop/src/renderer` | Chromium, sandboxed, origin `app://mmap`      | React UI (Tailwind, shadcn/ui); no Node or Electron APIs                                     |

Build configuration is in `apps/desktop/electron.vite.config.ts`. Every library and every
`@mmap/*` package is bundled, so the packaged app contains no `node_modules`. The preload script is
CommonJS because sandboxed preload scripts cannot be ES modules.

Startup order (`apps/desktop/src/main/index.ts`) matters for security:

1. Decide the renderer location and trusted origins (`resolveRendererLocation`).
2. Register `app://` as a privileged scheme (only allowed before `ready`).
3. Install guards on every future `webContents` (`guardAllWebContents`).
4. Take Electron's single-instance lock; a second launch focuses the existing window.
5. After `ready`: remove the default menu in packaged builds, harden the session, serve the
   renderer from `app://`, register IPC handlers, then create the window.

### Current scope (Phase 0)

The renderer shows the five navigation areas from PRD §6 (`src/renderer/src/navigation.ts`).
Library, Mind Maps, Knowledge Graph and Timeline render an empty state naming the phase that
delivers them. The search box and "New node" button are visible but disabled. Settings shows
diagnostics fetched over the only IPC channel, `app:get-info`.

The app does not yet open or create a workspace or a database file. The only SQLite use at
runtime is an in-memory capability probe (version and FTS5 check) and, in smoke-test mode,
migrating a throwaway file. There are no repositories, no write coordinator, no workspace lock,
no backups, and no external-link opening yet.

## Request flow: one IPC call end to end

This is the full path of `app:get-info`, the pattern every future channel follows.

1. **Renderer.** `SettingsView` (`src/renderer/src/views/settings-view.tsx`) calls
   `window.mmap.app.getInfo()`. The type of `window.mmap` is `MmapRendererApi` from
   `packages/contracts/src/renderer-api.ts`, declared in `src/renderer/src/env.d.ts`.
2. **Preload.** `src/preload/index.ts` maps that method to
   `ipcRenderer.invoke('app:get-info')`. The channel name comes from
   `packages/contracts/src/channels.ts`; the renderer cannot choose it.
3. **Main, routing.** `src/main/ipc/register-ipc-handlers.ts` registered the channel with
   `ipcMain.handle`, wrapping the service in `createIpcHandler`.
4. **Sender check.** `createIpcHandler` (`src/main/ipc/ipc-handler.ts`) calls `isTrustedSender`:
   the sender frame must exist, must be the window's main frame (sub-frames are rejected even if
   same-origin), and its URL origin must be in the trusted set. Failure returns
   `FORBIDDEN_SENDER`; the service is never called.
5. **Request validation.** The payload is parsed with the channel's request schema from
   `IPC_CATALOGUE` (`packages/contracts/src/catalogue.ts`). `app:get-info` takes no argument, so
   anything other than `undefined` returns `INVALID_REQUEST`.
6. **Service.** `createAppInfoService` (`src/main/services/app-info-service.ts`) returns
   versions plus `probeStorageCapabilities()` from `packages/storage-sqlite/src/capabilities.ts`
   (SQLite version, FTS5 availability, latest schema version). The result is cached for the
   process lifetime.
7. **Response validation.** The result is parsed with the channel's response schema, which uses
   `z.strictObject`, so a service bug cannot leak an extra field such as a file path. A mismatch
   is logged and returned as `INTERNAL_ERROR`.
8. **Envelope.** The handler resolves with `{ ok: true, data }` or `{ ok: false, error }`. A thrown
   `DomainError` becomes its code and message; any other error is logged in redacted form and
   returned as `INTERNAL_ERROR` with a generic message.
9. **Renderer again.** `SettingsView` renders a table on success or the error message in a
   `role="alert"` paragraph on failure.

Envelope, error codes and the checklist for adding a channel are in
[ipc-contracts.md](ipc-contracts.md).

## Security implementation

This maps each part of the baseline in ADR-0003 and PRD §8 to the code that implements it.

| Control                       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window isolation              | `src/main/main-window.ts`: `nodeIntegration` (and in workers/sub-frames) off, `contextIsolation`, `sandbox`, `webSecurity` on, `webviewTag` off, `navigateOnDragDrop` off, devtools only when unpackaged.                                                                                                                                                                                                                                                                                                                                                                     |
| Custom origin instead of file | `src/main/security/app-protocol.ts` registers `app` as a standard, secure scheme and serves the bundle at `app://mmap`. It does not bypass CSP.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Protocol path safety          | `src/main/security/resolve-renderer-asset.ts`: wrong scheme/host → 403; NUL bytes, backslashes, drive letters or malformed escapes → 400; lexical path must stay inside the renderer root; the real path (symlinks and junctions resolved) must also stay inside; only regular files are served. Responses also get `X-Content-Type-Options: nosniff`.                                                                                                                                                                                                                        |
| Content Security Policy       | `src/main/security/content-security-policy.ts` builds the policy: `default-src 'none'`, scripts and connections only from `'self'`, no remote origins, no `unsafe-eval`, no inline scripts in production (inline styles are allowed for React Flow, Tiptap and KaTeX). It is applied in two places: the `app://` handler sets the header on its own responses, and `hardenSession` adds it to every response via `webRequest.onHeadersReceived`. The second also covers the dev server; the first keeps production safe if `webRequest` ever stops covering custom protocols. |
| Navigation and windows        | `src/main/security/harden-electron.ts` `guardAllWebContents`: `will-navigate` and `will-redirect` to an untrusted origin are cancelled, `window.open` and `target=_blank` are denied, `<webview>` attachment is prevented. Applied to every `webContents` the app ever creates.                                                                                                                                                                                                                                                                                               |
| Permissions                   | `hardenSession` denies every permission request, permission check and device permission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Trusted origins               | `src/main/security/trusted-origins.ts`: production trusts only `app://mmap`. The dev server is trusted only when unpackaged and on a loopback `http` URL, so an environment variable cannot point an installed build at web content.                                                                                                                                                                                                                                                                                                                                          |
| IPC sender and payload        | `src/main/ipc/ipc-handler.ts`: main-frame and origin check, zod validation of the request and of the response, result envelope.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Narrow bridge                 | `src/preload/index.ts` exposes one named method per operation. `ipcRenderer`, filesystem, shell and SQL are never exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Redacted logging              | `src/main/logging.ts` logs only the operation, the error class name and its code. Error messages are dropped because lower layers can embed titles or paths; stack traces appear only in unpackaged builds. IPC payloads are never logged.                                                                                                                                                                                                                                                                                                                                    |
| Database file hardening       | `packages/storage-sqlite/src/connection.ts`: extension loading off, `trusted_schema = OFF`, double-quoted string literals off, foreign keys on and verified.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Packaged binary               | Electron fuses in `apps/desktop/electron-builder.yml` (no run-as-Node, no `NODE_OPTIONS`, no inspector flags, ASAR integrity, app only from ASAR). See the [packaging runbook](runbooks/packaging.md#electron-fuses).                                                                                                                                                                                                                                                                                                                                                         |
| No network                    | The main process makes no network calls, and CSP blocks remote requests from the renderer. The smoke test runs with a dead proxy to prove the app starts offline.                                                                                                                                                                                                                                                                                                                                                                                                             |

Not implemented yet: opening approved HTTP(S) links through `shell.openExternal` after a user
action (ADR-0003 allows it; until then every new-window request is simply denied), note
sanitization (Phase 1), and the release security test suite (Phase 5).

## Where future phases plug in

These seams exist in the code today, but have no implementation behind them yet.

- **Repositories and search.** `packages/domain/src/ports/repositories.ts`, `search.ts`,
  `attachment-store.ts` and `transaction.ts` define the interfaces. Phase 1 and later add SQLite
  implementations in `packages/storage-sqlite`, each with contract tests on real temporary
  databases. Every repository method is scoped to one workspace and treats records from another
  workspace as not found.
- **Write coordinator.** PRD §5.1 and §7.3 require one writer per workspace. The
  `TransactionRunner` port is asynchronous so that the SQLite adapter can queue all write
  transactions through a single coordinator in the main process (or a worker) while reads proceed
  in parallel under WAL. Heavy work (archives, layouts, large queries) must stay out of the
  renderer.
- **Workspace lock.** Phase 1 adds the per-workspace `.lock` file with stale-lock recovery
  ([ADR-0005](adr/0005-workspace-location-and-supported-filesystems.md)). Until then the
  single-instance lock in `src/main/index.ts` is the only protection against two processes.
- **Pre-migration backup.** `migrateToLatest` in `packages/storage-sqlite/src/migrations/runner.ts`
  accepts a `beforeApply` hook that runs before the first pending migration; if it throws, nothing
  is applied. The desktop app will take an online SQLite backup there
  ([ADR-0006](adr/0006-backup-policy.md), [ADR-0007](adr/0007-database-migrations-strategy.md)).
- **New IPC channels.** Each feature adds channels through the contract catalogue
  ([ipc-contracts.md](ipc-contracts.md)). Long-running operations will additionally need progress,
  cancellation and idempotency keys (PRD §7.2); `transfer_jobs` in the schema already has
  `progress` and `idempotency_key` columns for this.

## Future server adapter seam

PRD §7.2 keeps an optional server/web phase possible without committing to it. Nothing for it
exists in the repository. The boundaries above are what keep it possible:

- The domain package has no runtime, storage or transport dependencies, so a server can reuse it
  unchanged.
- A PostgreSQL/Prisma adapter would be a new package implementing the same domain ports, with its
  own integration tests (PRD §10.6). The `TransactionRunner` port is already asynchronous for this
  reason.
- The zod schemas in `packages/contracts` describe DTOs independently of Electron, so an HTTP
  layer (Fastify in the PRD) could validate the same shapes. `DomainError` codes are
  transport-neutral; IPC maps them into its envelope today, and an HTTP layer would map them to
  status codes.
- Authorization belongs at the server boundary. Sync is explicitly out of scope and needs its own
  PRD.

Package names and the exact HTTP mapping are not decided; they belong to that future phase.
