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
| Type directionality                            | Cannot change while used.                                                                                                                 | Relationships copy the type's directionality into a composite FK, so the DB blocks the change. Phase 2 adds the service check and requires a new type instead of a migration flow.                                        |
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

### Phase 0 — Foundation (done)

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
Merged into `main`; see [§6](#6-phase-1-status-2026-10-26) for what was done and what was not.

### Phase 2 — Connections and discovery

Relationship types (seeded defaults, custom, archive), relationship CRUD with direction and
uniqueness rules, wikilink picker and reference reconciliation in the note-save transaction,
backlinks with excerpts, unresolved-link repair, FTS5 search with title boosting, snippets,
filters, pagination; search benchmark harness on the PRD dataset.
Implemented on branch `phase-2-connections`; see [§7](#7-phase-2-status-2026-10-27).

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

## 6. Phase 1 status (2026-10-26)

Implemented on branch `phase-1-knowledge-base` in five slices (`git log --oneline main..HEAD`):
1.1 workspaces, write coordinator, note and file policies; 1.2 nodes, library and autosave;
1.3 rich notes with Tiptap and KaTeX; 1.4 tags; 1.5 managed attachments. Test suite: 570 tests in
29 files ([testing.md](testing.md)).

| PRD §12 exit criterion / deliverable          | Evidence                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exit: workspace isolation passes              | `workspace-manager.test.ts` (switching keeps workspaces isolated); cross-workspace tests in `knowledge-node-service.test.ts`, `tag-service.test.ts` (service and composite foreign key) and `attachment-service.test.ts`; preview protocol limited to the open workspace; `Workbench` keyed by workspace ID                                                         |
| Exit: content survives restart                | `apps/desktop/src/main/phase1-acceptance.test.ts` (PRD §13 criterion 3: formatted text, table, code block, inline and display math, tags and an attachment survive exit and restart, and deletion of the original file); `workspace-manager.test.ts` restart test                                                                                                   |
| Exit: workflows work offline                  | No network code in the main process; CSP without remote origins; packaged smoke test with a dead proxy creates the first-run workspace and runs node create/save/conflict/tag/filter/delete through the real bridge (8 checks)                                                                                                                                      |
| Local workspaces (PRD §5.1)                   | `apps/desktop/src/main/workspaces/`: manifest, default location, create/open/rename/switch with native dialogs, recent list, lock with stale recovery, missing/damaged handling, network shares blocked, cloud-sync warning, flush on quit; `workspace-manager.test.ts`                                                                                             |
| One writer coordinator                        | `packages/storage-sqlite/src/sqlite-connections.ts` (queued `BEGIN IMMEDIATE` writer, read-only WAL reader, `AsyncLocalStorage`); `sqlite-connections.test.ts`                                                                                                                                                                                                      |
| Pre-migration backup                          | `packages/storage-sqlite/src/workspace-database.ts` and `backup.ts` (verified online backup into `recovery/`); `sqlite-connections.test.ts`                                                                                                                                                                                                                         |
| Node CRUD, revisions, autosave (PRD §5.2)     | `knowledge-node-service.ts` and `knowledge-node-service.test.ts`; renderer `node-draft-saver.ts` and its fake-timer tests; conflict banner with three choices; local recovery copies; delete preview                                                                                                                                                                |
| Library listing                               | Three sort orders, keyset pagination ("Load more"), totals, tag filter; pagination stability tests                                                                                                                                                                                                                                                                  |
| Tiptap and KaTeX, bundled (PRD §5.3)          | `apps/desktop/src/renderer/src/notes/`; `editor-schema.test.ts` (jsdom) proves editor output is accepted and stable; KaTeX `trust: false` with size and expansion limits                                                                                                                                                                                            |
| Validated, versioned note JSON and plain text | `packages/domain/src/notes/note-document.ts`, `plain-text.ts`; written in one transaction with FTS update; `note-document.test.ts` (115 tests), `plain-text.test.ts`                                                                                                                                                                                                |
| Note sanitization and safe links              | Hostile-document and link-policy tests (`note-document.test.ts`, `link-policy.test.ts`, `editor-schema.test.ts`); `app:open-external-link` re-validation, `external-link-service.test.ts`                                                                                                                                                                           |
| Tags (PRD §5.8, tag part)                     | `tag-service.ts`, `tag-service.test.ts`; tag chips, filter bar and "Manage tags" in the UI; smoke test tags and filters                                                                                                                                                                                                                                             |
| Managed attachments (PRD §5.10)               | `file-attachment-store.ts` (staging, SHA-256 verification, generated names, traversal and junction checks, reconciliation), `attachment-policy.ts` (executables by extension and content), configurable size limit, preview protocol; `file-attachment-store.test.ts`, `attachment-preview.test.ts`, `attachment-ipc-services.test.ts`, `attachment-policy.test.ts` |
| Timeline recording (PRD §5.9, recording part) | `node_created` and session-grouped `note_updated` events; `editing-session.test.ts`, `knowledge-node-service.test.ts`                                                                                                                                                                                                                                               |
| External-link IPC channel (from Phase 0)      | `app:open-external-link`                                                                                                                                                                                                                                                                                                                                            |
| Documentation                                 | [architecture](architecture.md), [data model](data-model.md), [IPC contracts](ipc-contracts.md), [testing](testing.md), [setup](setup.md), [user guide](user-guide.md); ADR-0005 amendment                                                                                                                                                                          |

### Not yet done in Phase 1

PRD §5.1 and §5.2 items that are **not** implemented:

- **Multiple app windows** (PRD §5.1). The app has a single window. Revision checks are in place
  and reject stale writes, so a second window can be added on top of the same services.
- **Timeline UI.** Events are recorded; the Timeline view is Phase 4.
- **Search UI.** The FTS5 index is maintained on every save; search and title lookup are Phase 2.
- **Opening a node from search, graph, timeline, map or backlink** (PRD §5.2). Only the Library
  opens nodes; the other entry points arrive with their views.

Other gaps found while checking the code:

- **Worker thread for heavy database work** (carried from Phase 0). Not done: all SQLite and file
  work runs on the main process thread. Phase 1 workloads are small; revisit before imports,
  exports and layouts.
- **Delete preview counts for relationships and referencing notes are always 0** until Phase 2
  writes those tables.
- **No test drives the real UI with clicks.** The packaged smoke test exercises the bridge, the
  attachment store, the preview protocol and the CSP inside the real app, but not the React
  components or native dialogs.
- **Accessibility pass** (PRD §6, §11): components use labels, roles and keyboard-reachable
  controls, but no structured accessibility check has been run (Phase 5).

## 7. Phase 2 status (2026-10-27)

Implemented on branch `phase-2-connections` (not yet committed at the time of writing; see
`git diff main --stat`). Test suite: 736 passing tests in 37 files plus one benchmark file that is
skipped by default ([testing.md](testing.md)).

| PRD §12 exit criterion / deliverable             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exit: direction and uniqueness rules pass        | `relationship-service.test.ts`, block "direction and uniqueness (acceptance criterion 4)": A `depends on` B stays A → B from both nodes, a reversed `related to` duplicate is `DUPLICATE` while other types are allowed, the reverse of a directed type is allowed, self-links are rejected; reversal and type change are re-checked. Domain rule: `relationship-rules.test.ts`. Second line of defense: `initial-schema.test.ts` (canonical order, directionality copy, cross-workspace). Packaged smoke check 7. |
| Exit: rename/delete references behave correctly  | `note-references.test.ts`, block "wikilinks and backlinks (acceptance criterion 5)": the link survives a rename of the target, removing the link removes the backlink after save, deleting the target leaves the link readable and unresolved, no relationship is created. `wikilink-node.test.ts` (jsdom) marks only missing targets and repairs a link without changing its label. Packaged smoke check 7.                                                                                                       |
| Exit: search targets measured                    | `search.benchmark.test.ts` on 10,000 nodes, 30,000 relationships and 200 tags, on a developer machine: search p50 3.3 ms, p95 50 ms, max 63 ms (250 queries); title lookup p50 25 ms, p95 31 ms, max 41 ms (220 lookups). PRD target: search p95 below 500 ms. Measured, but not yet on the reference machine (see below).                                                                                                                                                                                         |
| Relationship types (PRD §4.2, §5.5)              | Five seeded built-in types; create, rename, archive and restore; direction changes only while unused, otherwise "create a new type"; `manage-relationship-types-dialog.tsx`                                                                                                                                                                                                                                                                                                                                        |
| Relationship editing                             | `relationship-service.ts`, `relationships:*` channels, `node-relationships.tsx`: add with type, direction, other node and optional description; reverse; change type; delete with confirmation; direction shown as arrow or dash, with text for screen readers; `relationship_created` timeline event                                                                                                                                                                                                              |
| Wikilinks (PRD §4.3, §5.4)                       | Note schema version 2 with the `wikilink` node; `[[` and a toolbar button open a picker; new nodes only through an explicit "Create a new node" option; links store the target ID and a label; [ADR-0008](adr/0008-wikilinks-and-note-schema-v2.md)                                                                                                                                                                                                                                                                |
| Reference reconciliation in the save transaction | `KnowledgeNodeService` rebuilds `note_references` on create, duplicate and note update, in the same transaction as the note (PRD §14); only existing targets are stored                                                                                                                                                                                                                                                                                                                                            |
| Backlinks with excerpts                          | `nodes:backlinks`, "Linked from" section: one entry per source note with excerpt and link count                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unresolved-link repair                           | `nodes:resolve-links` plus ProseMirror decorations; clicking an unresolved link opens a picker for a new target                                                                                                                                                                                                                                                                                                                                                                                                    |
| FTS5 search (PRD §5.8)                           | `SqliteSearchIndex`: escaped queries, BM25 weights 10/4/1 (title boosting), plain-text snippet segments, tag filters, totals, paging; search view and Ctrl+K; `sqlite-search-index.test.ts` including hostile input and workspace isolation                                                                                                                                                                                                                                                                        |
| Deterministic title lookup for pickers           | `nodes:lookup`: prefix matches first, then other substring matches, ordered by length, title and ID; `NodePicker` combobox                                                                                                                                                                                                                                                                                                                                                                                         |
| Compatibility with Phase 1 builds                | Migration 2 (`0002-note-schema-v2-marker.ts`) raises the database version, so Phase 1 builds refuse upgraded workspaces with `WORKSPACE_TOO_NEW`; verified pre-migration backup as for every migration                                                                                                                                                                                                                                                                                                             |
| IPC                                              | 13 new channels (44 in total) with strict request and response schemas; [ipc-contracts.md](ipc-contracts.md)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Documentation                                    | [architecture](architecture.md), [data model](data-model.md), [IPC contracts](ipc-contracts.md), [testing](testing.md), [user guide](user-guide.md), ADR-0008                                                                                                                                                                                                                                                                                                                                                      |

Phase 1 gaps closed by Phase 2: the search UI exists; nodes open from search results, backlinks
and relationships, not only from the Library; the delete preview reports real relationship and
linking-note counts.

### Not yet done in Phase 2

- **Search target not confirmed on the reference machine.** The benchmark ran on a developer
  machine, on system Node, calling the index directly (no IPC, no renderer), with rows inserted by
  SQL. PRD §9 requires the installed release on the documented four-core, 16 GB, SSD computer.
  That measurement belongs to the Phase 5 performance pass. The benchmark is not run in CI.
- **"Ambiguous title requires selection" applies only to the picker.** There is no Markdown or
  raw-text import yet, so no code resolves `[[Title]]` text. Every link is made by choosing one
  node in the picker, so ambiguity cannot arise today. Import (Phase 5) needs its own resolution
  step that asks the user.
- **Changing the text of an existing link.** New links can get custom text (`[[target|label]]`
  via the "Link text" field); to change it later, delete the link and insert it again.
- **Hebrew niqqud.** Pointed and unpointed Hebrew words do not match each other in search (a
  tokenizer limitation, documented and tested). Fixing it needs custom normalization of indexed
  and query text.
- **Offset-based search paging.** Editing nodes between "Load more" requests can repeat or skip a
  result; ranked results have no stable keyset.
- **Picker case and accent folding.** Title lookup folds ASCII case only and does not ignore
  accents, unlike full-text search, because `node:sqlite` has no ICU.
- **Relationship-type filters in search** (PRD §5.8, "where applicable") are not implemented.
  Creating relationships from a graph action (PRD §5.5) waits for the Phase 4 graph.
- **No UI tests** for the picker, relationship form, types dialog, backlinks or search view, and no
  structured accessibility check of them (Phase 5).
- **Worker thread** (carried from Phases 0 and 1). Search and all other database work still run on
  the main process thread.
