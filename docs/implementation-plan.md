# mmap Desktop — Implementation Plan

Source of truth: [`docs/PRD-desktop`](./PRD-desktop) (v2.0, 2026-10-26). This plan turns the PRD's
phased delivery table (§12) into concrete, reviewable increments. Each phase ends with its PRD
exit criteria verified by automated tests where possible and a short manual checklist otherwise.

## 1. Requirement review — key observations

| Area                                           | Observation                                                                                                                               | Consequence for the plan                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage identity                               | One workspace = one folder = one SQLite file, yet the logical model carries `workspace_id` everywhere.                                    | Keep `workspace_id` columns and enforce them with composite foreign keys `(workspace_id, id)`. Cross-workspace links become impossible at the constraint level, and the schema stays server-ready.                        |
| Relationships vs. references vs. map structure | Three distinct concepts that users will confuse (§4.2–4.4, §14).                                                                          | Three separate tables (`relationships`, `note_references`, `map_connections` / placement parent) and separate domain modules. Nothing creates one from another implicitly.                                                |
| Undirected duplicates                          | Must use canonical endpoint ordering.                                                                                                     | Domain rule normalizes ordering, and a CHECK constraint rejects non-canonical undirected rows as a second line of defense.                                                                                                |
| Type directionality                            | Cannot change while used.                                                                                                                 | Relationships copy the type's directionality into a composite FK, so the DB blocks the change; service check and migration flow in Phase 2.                                                                               |
| Native dependencies                            | The build machine has no C++ toolchain; `better-sqlite3@13.0.3` has **no** Electron 44 Windows prebuild (verified: HTTP 404 for ABI 149). | Use the SQLite engine built into Node (`node:sqlite`) — no native build, same engine (SQLite 3.53.4, FTS5, online backup API) in Node 24 tests and inside Electron 44. Recorded in ADR-0002.                              |
| Testing vs. runtime parity                     | Tests run on system Node 24.21, app runs on Electron's Node 24.22.                                                                        | Same SQLite version in both (verified). CI additionally runs a packaged-app smoke test that exercises migrations inside Electron.                                                                                         |
| Security                                       | Electron hardening, narrow IPC, sanitized notes, safe archives (§8, §11).                                                                 | Built into Phase 0 shell (not retrofitted): sandbox, context isolation, CSP, custom `app://` protocol, navigation/window denial, sender validation, schema-validated IPC. Later phases add their own hostile-input tests. |
| Signing                                        | Signed installer + verified updates required for release.                                                                                 | Phase 0 packages unsigned NSIS builds; signing/update pipeline is a Phase 5 release gate (ADR-0004).                                                                                                                      |
| Offline / no CDN                               | Fonts, KaTeX, editor assets must be bundled.                                                                                              | CSP forbids remote origins; Vite bundles all assets.                                                                                                                                                                      |

### Ambiguities resolved by default (revisit if wrong)

1. **Package manager:** npm workspaces (bundled with Node; no extra global install).
2. **Electron line:** 44.x (current stable minus one; 45.0.0 is days old). ADR-0003.
3. **TypeScript:** 6.0.x, because `typescript-eslint` does not yet support TypeScript 7.
4. **Migrations:** ordered TypeScript modules exporting SQL text, so they bundle into the main process without loose files.
5. **Undirected relationship ordering:** lexicographic order of node UUIDs (`source_id < target_id`).

## 2. Repository layout

```
apps/desktop/                 Electron app (electron-vite)
  src/main/                   main process: window, security, IPC handlers, composition root
  src/preload/                minimal typed bridge (contextBridge)
  src/renderer/               React + Tailwind + shadcn/ui
packages/domain/              pure TypeScript domain rules + ports (no Electron/React/SQLite)
packages/contracts/           IPC channel catalogue, DTO schemas (zod), error codes
packages/storage-sqlite/      node:sqlite adapter: connection, migrations, repositories
docs/                         PRD, plan, architecture, ADRs, runbooks
```

The dependency direction is `apps/desktop → storage-sqlite → domain` and `apps/desktop → contracts → domain`.
`domain` imports nothing infrastructural. ESLint rules plus an architecture test enforce this.

## 3. Phases

### Phase 0 — Foundation (this increment)

Deliverables

- Monorepo with strict TypeScript, ESLint, Prettier, Vitest, lockfile, pinned versions.
- `domain`: IDs, clock, error model, repository/transaction/search/attachment-store ports.
- `contracts`: typed IPC catalogue with runtime validation, error envelope.
- `storage-sqlite`: connection factory (foreign keys, WAL, busy timeout), migration runner
  (transactional, refuses newer schemas), full initial schema for the logical data model
  incl. FTS5, integrity triggers.
- `apps/desktop`: hardened Electron shell, `app://` protocol, CSP, sender-validated IPC,
  React shell with the five main navigation areas, diagnostics view, `--smoke-test` mode.
- Packaging: electron-builder NSIS x64 (unsigned), packaged smoke test.
- CI (GitHub Actions, Windows): format, lint, typecheck, unit/integration tests, build,
  package, packaged smoke test, dependency audit, secret scan.
- Docs: README, local setup, architecture overview, ADRs required by PRD §14.

Exit criteria: clean `npm ci && npm run verify` works; packaged app launches offline;
migrations/builds pass.

### Phase 1 — Private knowledge base

Workspace lifecycle (create/open/rename/switch, manifest, process lock with stale recovery,
missing-folder handling, verified move), node CRUD with revisions and autosave states,
Tiptap editor with KaTeX (bundled), validated versioned note JSON + derived plain text,
tags, managed attachments (staging, checksums, reconciliation, traversal/symlink protection),
note sanitization tests. Exit: workspace isolation, content survives restart, offline.

### Phase 2 — Connections and discovery

Relationship types (seeded defaults, custom, archive), relationship CRUD with direction and
uniqueness rules, wikilink picker and reference reconciliation in the note-save transaction,
backlinks with excerpts, unresolved-link repair, FTS5 search with title boosting, snippets,
filters, pagination; search benchmark harness on the PRD dataset.

### Phase 3 — Mind maps

Map CRUD/duplicate, placements of canonical nodes, React Flow freeform mode, hierarchical
mode with deterministic layout, cycle rejection, reviewed freeform→hierarchy conversion,
viewport/coordinates persistence, map revisions, keyboard alternatives.

### Phase 4 — Graph and timeline

Cytoscape graph with bounded neighborhood loading, visible partial-result indicators, filters,
optional note-reference layer, accessible list alternative; timeline events with editing-session
grouping (30 min inactivity), reviewed/reflection events, timezone display.

### Phase 5 — Portability and release

ZIP export/import (validation, limits, traversal protection, ID mapping, duplicate warning,
transactional apply), Markdown export, SQLite-backup-based snapshots with retention and restore,
signed installer and update verification, accessibility pass, security test suite, complete
documentation, performance verification on the reference machine.

## 4. Cross-cutting rules applied in every phase

- Every bug fix ships with a regression test.
- SQLite behaviour is tested against real temporary databases, never mocks.
- New IPC channels require: contract schema, sender validation, handler test, and a doc entry.
- Comments explain intent, invariants and security decisions in English.
- Consequential decisions get a short ADR in `docs/adr/`.

## 5. Phase 0 status (2026-10-26)

| Exit criterion / deliverable     | Evidence                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean setup works                | `npm ci && npm run verify` (format, lint, typecheck, tests, build)                                                                                |
| Migrations pass                  | `packages/storage-sqlite` integration tests on real temp files (fresh, idempotent, rollback, refuse-newer with unchanged bytes, checksum history) |
| Packaged app launches offline    | `npm run package:dir -w @mmap/desktop && npm run smoke:packaged`: 6 checks in the real packaged runtime with network blackholed                   |
| Electron shell security baseline | `apps/desktop/src/main/security/*` + unit tests; smoke test verifies CSP and renderer isolation; fuses verified with `@electron/fuses read`       |
| Contracts                        | `packages/contracts` catalogue with request and response validation                                                                               |
| Architecture boundaries          | `tooling/architecture-rules.mjs` enforced by ESLint and `tests/architecture.test.ts`                                                              |
| Architectural decisions          | `docs/adr/0001`–`0007`                                                                                                                            |
| CI                               | `.github/workflows/ci.yml` (not yet run on GitHub: no remote configured)                                                                          |

Carried into Phase 1: workspace lifecycle and lock, write coordinator, pre-migration backup
wiring, worker thread for heavy database work, external-link IPC channel.
