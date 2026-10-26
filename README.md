# mmap

mmap is a private, local-first personal knowledge graph for the Windows desktop. You capture
concepts as knowledge nodes, write rich notes, connect nodes with typed relationships that you
choose yourself, reuse the same nodes across several mind maps, and revisit what you learned on a
timeline. All data stays in a workspace folder on your own computer and the app works fully
offline: there is no account, no server, no telemetry, and no AI of any kind (no LLMs, embeddings,
generated content or inferred relationships). The product requirements are in
[`docs/PRD-desktop`](docs/PRD-desktop).

## Status

**Phase 0 — Foundation.** The repository contains the hardened Electron shell, the typed IPC
contract layer, the SQLite storage adapter with the complete initial schema and migration runner,
packaging, and a packaged-app smoke test.

What you can do with the app today: launch it, move between the five navigation areas (Library,
Mind Maps, Knowledge Graph, Timeline, Settings), and see runtime diagnostics in Settings. The
other areas show empty states. Workspaces, node editing, relationships, maps, search, the graph,
the timeline, attachments, export/import and backups arrive in Phases 1 to 5
([implementation plan](docs/implementation-plan.md)).

## Quick start

Requires Windows 10/11 x64, Node.js 24 (see `.nvmrc`) and git. No Python, Visual Studio or C++
build tools are needed. Full details: [docs/setup.md](docs/setup.md).

```sh
npm ci            # install exact locked dependencies
npm run verify    # format check, lint, typecheck, tests, build
npm run dev       # start the app with hot reload
```

## Repository layout

| Path                      | Contents                                                                        |
| ------------------------- | ------------------------------------------------------------------------------- |
| `apps/desktop`            | Electron app: `src/main` (main process), `src/preload`, `src/renderer` (React)  |
| `packages/domain`         | Pure TypeScript domain rules and ports; no Electron, React, SQLite or Node APIs |
| `packages/contracts`      | IPC channel catalogue, zod request/response schemas, result envelope            |
| `packages/storage-sqlite` | `node:sqlite` adapter: connection settings, migrations, schema                  |
| `tests`                   | Repository-level architecture (module boundary) test                            |
| `tooling`                 | `architecture-rules.mjs`, shared by ESLint and the architecture test            |
| `docs`                    | PRD, implementation plan, ADRs, developer documentation, runbooks               |

## Scripts

Run from the repository root.

| Command                                | What it does                                                          |
| -------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                          | Starts the app with electron-vite and a loopback Vite dev server      |
| `npm run verify`                       | `format:check`, `lint`, `typecheck`, `test`, `build`; run before a PR |
| `npm test`                             | Runs all Vitest projects once                                         |
| `npm run test:watch`                   | Runs Vitest in watch mode                                             |
| `npm run lint`                         | ESLint with zero warnings allowed, including module boundary rules    |
| `npm run typecheck`                    | Strict TypeScript checks for every package                            |
| `npm run format` / `format:check`      | Prettier write / check                                                |
| `npm run build`                        | Builds main, preload and renderer bundles into `apps/desktop/out`     |
| `npm run package:dir -w @mmap/desktop` | Builds an unpacked app in `apps/desktop/release/win-unpacked`         |
| `npm run package`                      | Builds the unsigned NSIS installer in `apps/desktop/release`          |
| `npm run smoke:packaged`               | Runs the packaged app offline in `--smoke-test` mode                  |

## Documentation

- [Local setup](docs/setup.md): prerequisites, daily commands, environment variables,
  troubleshooting
- [Architecture](docs/architecture.md): packages, process model, IPC request flow, security
- [Data model](docs/data-model.md): every table in the initial schema and why it looks that way
- [IPC contracts](docs/ipc-contracts.md): envelope, error codes, adding a channel, channel reference
- [Testing](docs/testing.md): test layers, rules, smoke test, what is not automated yet
- [Packaging runbook](docs/runbooks/packaging.md): build, package, smoke test, fuses, signing gap
- [Product requirements (PRD)](docs/PRD-desktop) and
  [implementation plan](docs/implementation-plan.md)
- Architecture Decision Records ([index](docs/adr/README.md)):
  - [ADR-0001 Monorepo and module boundaries](docs/adr/0001-monorepo-and-module-boundaries.md)
  - [ADR-0002 SQLite driver: built-in node:sqlite](docs/adr/0002-sqlite-driver-node-sqlite.md)
  - [ADR-0003 Electron version and security baseline](docs/adr/0003-electron-version-and-security-baseline.md)
  - [ADR-0004 Installer, code signing, and updates](docs/adr/0004-installer-signing-and-updates.md)
  - [ADR-0005 Workspace location and supported filesystems](docs/adr/0005-workspace-location-and-supported-filesystems.md)
  - [ADR-0006 Backup policy](docs/adr/0006-backup-policy.md)
  - [ADR-0007 Database migrations strategy](docs/adr/0007-database-migrations-strategy.md)
