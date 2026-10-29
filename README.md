# mmap

mmap is a private, local-first personal knowledge graph for the Windows desktop. You capture
concepts as knowledge nodes, write rich notes, connect nodes with typed relationships that you
choose yourself, reuse the same nodes across several mind maps, and revisit what you learned on a
timeline. All data stays in a workspace folder on your own computer and the app works fully
offline: there is no account, no server, no telemetry, and no AI of any kind (no LLMs, embeddings,
generated content or inferred relationships). The product requirements are in
[`docs/PRD-desktop`](docs/PRD-desktop).

## Status

- **Phase 0 — Foundation: done.** Hardened Electron shell, typed IPC contracts, SQLite storage
  with the complete initial schema and migration runner, packaging, packaged-app smoke test.
- **Phase 1 — Private knowledge base: done, merged into `main`.** What was left out is listed in
  the [Phase 1 status](docs/implementation-plan.md#6-phase-1-status-2026-10-26).
- **Phase 2 — Connections and discovery: done, merged into `main`.** Relationships, wikilinks,
  backlinks and search. What works and what is still missing is listed in the
  [Phase 2 status](docs/implementation-plan.md#7-phase-2-status-2026-10-27).
- **Phase 3 — Mind maps: done, merged into `main`.** Multiple maps that reuse nodes, freeform
  and hierarchical modes, persistence. What works and what is still missing is listed in the
  [Phase 3 status](docs/implementation-plan.md#8-phase-3-status-2026-10-27).
- **Phase 4 — Graph and timeline: done, merged into `main`.** Knowledge
  graph with bounded, clearly labelled partial views, mind map membership, saved positions and a
  list alternative; a visual learning timeline with reviews, reflections, milestones, learning
  dates and a workspace timezone. What works and what is still missing is
  listed in the [Phase 4 status](docs/implementation-plan.md#9-phase-4-status-2026-10-27).
- **Phase 5 — Portability and release: partly done, on branch `phase-5-portability`.** Lossless
  ZIP export and validated import, Markdown export, daily verified backups with restore, a Home
  page, the app icon, an automated WCAG 2.2 AA check of the primary views, and the code-signing
  configuration. **Not releasable yet:** there is no signing certificate (builds are unsigned), no
  automatic updates, and no clean-machine or reference-machine verification. The full list is in
  the [Phase 5 status](docs/implementation-plan.md#10-phase-5-status-2026-10-27).

What works in the app today:

- **Home.** The app opens on a Home page: a greeting and today's date in the workspace's
  timezone, quick actions (new node, search, mind maps, graph), the notes you edited most
  recently, recent mind maps and activity, and the backup status. A new workspace shows three
  "Get started" steps.
- **Workspaces.** A `My Knowledge` workspace is created on first launch under
  `%APPDATA%\mmap\workspaces`. Create more (default location or a folder you choose), open an
  existing workspace folder, switch, rename, and see the folder in Settings. Missing or damaged
  workspaces are reported, never replaced. One process at a time per workspace (lock file with
  stale-lock recovery).
- **Nodes.** Create, edit, duplicate and delete knowledge nodes in the Library (three sort orders,
  paging). Edits autosave after one second; stale saves are detected and offered as a conflict;
  unsaved drafts are recoverable after a crash.
- **Rich notes.** Headings, formatting, lists, checklists, links, quotes, code blocks, tables,
  inline and display math (KaTeX), undo and redo, and per-paragraph right-to-left text.
- **Tags.** Add tags to nodes, filter the Library and search results by tags, rename and delete
  tags.
- **Attachments.** Copy files into the workspace, with programs and scripts refused and a
  configurable size limit (20 MB by default). Images are shown inline; other files open in their
  default application.
- **Relationships.** Connect two nodes with a typed relationship that you choose: five built-in
  types plus your own, directed (with an arrow) or undirected. Duplicates, reversed undirected
  duplicates and self-links are refused. Types can be renamed and archived; a type's direction
  can change only while no relationship uses it.
- **Wikilinks and backlinks.** Type `[[` in a note to link to another node, or to create one.
  Links follow the node, not its title, so renaming keeps them working. Each node lists the notes
  that link to it under "Linked from". Links to deleted nodes stay readable and can be repaired.
  Links never create relationships.
- **Search.** Full-text search over titles, summaries and notes (Ctrl+K), with title matches
  ranked first, highlighted snippets, tag filters and paging.
- **Mind maps.** Create, rename, duplicate and delete maps that place existing or new nodes; the
  same node can sit on many maps and always shows its current content. Freeform maps with
  dragging, connectors with notes and undo, pan and zoom, and a read-only note preview on
  double-click; hierarchical maps with automatic tree layout, reordering,
  indenting and collapsing; a reviewed switch from freeform to hierarchy that keeps freeform
  positions; colors; and a keyboard-accessible outline. Deleting a map or removing an item never
  deletes nodes, and map hierarchy never creates relationships.
- **Knowledge graph.** All nodes and typed relationships of the workspace in Cytoscape, with
  arrows for directed relationships, labels on hover, selection or on request, and note links as a
  separate dashed layer. Node positions are remembered (separately from mind maps): new nodes
  appear next to their neighbors, dragged nodes stay put, and **Rearrange** lays the graph out
  again on request; the view opens fitted. Mind map membership is shown on the nodes (colored
  badges, always also named), never as lines; filter by text, tags, relationship types and maps,
  highlight a map or open it. Selecting a node highlights its neighborhood and opens a side panel;
  Focus mode shows a node with its neighbors; expand neighbors on demand. Large workspaces load at
  most 1,000 nodes at a time, and the view always says whether it is partial ("showing X of Y").
  A List tab presents the same information for keyboard and screen-reader users. Map regions
  outline each map's nodes, and a map can be collapsed into one summary node.
- **Timeline.** Created nodes, note editing sessions, new relationships, reviews and learning
  milestones on a horizontal time axis (older left, newer right) with dates in the workspace's
  timezone (set in Settings): pan by dragging, scrolling or the arrow buttons, zoom by day, week,
  month or year, and click a marker for its details. Each kind of entry has its own marker shape,
  nearby entries are grouped into a numbered cluster, and every marker is a keyboard-reachable
  button; a List tab shows the same entries newest first, grouped by day. Filters by date range,
  event type, tag and node. "Mark as reviewed…" in the node panel records a review with an
  optional reflection; **Add milestone** records a milestone with a title and optional details.
  Any entry can be given a learning date (when the learning actually happened), which places it
  on the timeline while its recorded time is kept. Reviews and milestones can be edited or
  deleted; recorded activity cannot be changed. The timeline is a record, not a score.
- **Backups.** The open workspace is backed up once a day (and on request) with SQLite's online
  backup API, with every attached file checked against its checksum. Seven daily and four weekly
  backups are kept by default; the folder (for example on another drive) and the numbers can be
  changed. Settings shows the last backup, any failure, and a warning when backups are on the
  workspace's own drive. Restore replaces the open workspace after a safety backup, or recreates
  a lost workspace from a backup folder; every byte is verified first.
- **Export and import.** Export a workspace as one ZIP file (manifest, all data, attachment files
  with checksums) and import it into any workspace: the whole archive is validated first (size
  and entry limits, safe file names, schemas, checksums), a preview shows what will be added, and
  everything is added as new items with new IDs in one transaction. Tags and relationship types
  with the same name are reused, imported timeline entries are marked as imported, and importing
  the same archive twice needs confirmation. A Markdown export writes one readable file per node
  with wikilinks, math and relationships (it cannot be imported).

Not yet available: automatic updates, a signed installer, merging imports into existing nodes,
Markdown import, and progress or cancel for long operations
([implementation plan](docs/implementation-plan.md#not-yet-done-in-phase-5)). End-user
instructions are in the [user guide](docs/user-guide.md).

## Install

mmap runs on Windows 10 and 11 (64-bit).

1. Open the repository's [Releases](../../releases) page on GitHub and download
   `mmap-setup-<version>-x64.exe` from the latest release (for example `mmap-setup-0.1.0-x64.exe`).
2. Run the downloaded file. The installer is not code-signed yet, so Windows SmartScreen shows
   "Windows protected your PC": click **More info**, then **Run anyway**. (A signed installer is a
   release requirement still to come; see [ADR-0004](docs/adr/0004-installer-signing-and-updates.md).)
3. Follow the installer. It installs for your Windows user only (no administrator rights needed),
   lets you choose the folder, and adds Desktop and Start menu shortcuts.
4. Start **mmap**. On first start it creates your workspace under `%APPDATA%\mmap\workspaces`, and
   it takes a backup every day into `%APPDATA%\mmap\backups`. Everything stays on your computer.

**Updating:** download the newer installer and run it; your workspace is kept. **Uninstalling:**
Windows Settings › Apps › mmap › Uninstall. Your workspace and backups are kept in `%APPDATA%\mmap`;
delete that folder yourself if you want them gone.

**Bringing notes from a development build:** the installed app and `npm run dev` use separate data
(`%APPDATA%\mmap` and `%APPDATA%\mmap-dev`). In the development build use **Settings › Export and
import › Export workspace (ZIP)…**, then in the installed app **Settings › Export and import ›
Import from an export…** and choose that ZIP file.

**Building the installer yourself:** after the [quick start](#quick-start) steps, run
`npm run package`; the installer is written to `apps/desktop/release/` (see
[docs/runbooks/packaging.md](docs/runbooks/packaging.md)).

## Quick start

Requires Windows 10/11 x64, Node.js 24 (see `.nvmrc`) and git. No Python, Visual Studio or C++
build tools are needed. Full details: [docs/setup.md](docs/setup.md).

```sh
npm ci            # install exact locked dependencies
npm run verify    # format check, lint, typecheck, tests, build
npm run dev       # start the app with hot reload
```

## Repository layout

| Path                      | Contents                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop`            | Electron app: `src/main` (main process: workspaces, attachment store, export and import, backups, IPC services), `src/preload`, `src/renderer` (React)             |
| `packages/domain`         | Pure TypeScript domain rules, application services and ports; no Electron, React, SQLite or Node APIs                                                              |
| `packages/contracts`      | IPC channel catalogue, zod request/response schemas, result envelope                                                                                               |
| `packages/storage-sqlite` | `node:sqlite` adapter: connection settings, migrations, schema, write coordinator, repositories, FTS5 search, graph query, verified backup, export snapshot reader |
| `tests`                   | Repository-level architecture (module boundary) test                                                                                                               |
| `tooling`                 | `architecture-rules.mjs`, shared by ESLint and the architecture test                                                                                               |
| `docs`                    | PRD, implementation plan, ADRs, developer documentation, runbooks                                                                                                  |

## Scripts

Run from the repository root.

| Command                                                      | What it does                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                | Starts the app in watch mode with a loopback Vite dev server                                                    |
| `npm run verify`                                             | `format:check`, `lint`, `typecheck`, `test`, `build`; run before a PR                                           |
| `npm test`                                                   | Runs all Vitest projects once                                                                                   |
| `npm run test:watch`                                         | Runs Vitest in watch mode                                                                                       |
| `npm run lint`                                               | ESLint with zero warnings allowed, including module boundary rules                                              |
| `npm run typecheck`                                          | Strict TypeScript checks for every package                                                                      |
| `npm run format` / `format:check`                            | Prettier write / check                                                                                          |
| `npm run build`                                              | Builds main, preload and renderer bundles into `apps/desktop/out`                                               |
| `npm run package:dir -w @mmap/desktop`                       | Builds an unpacked app in `apps/desktop/release/win-unpacked`                                                   |
| `npm run package`                                            | Builds the NSIS installer in `apps/desktop/release` (unsigned unless `CSC_LINK` and `CSC_KEY_PASSWORD` are set) |
| `npm run smoke:packaged`                                     | Runs the packaged app offline in `--smoke-test` mode (17 checks, including WCAG 2.2 AA)                         |
| `powershell -File apps/desktop/scripts/verify-signature.ps1` | Release check: fails unless the installer and `mmap.exe` are signed and timestamped                             |

## Documentation

- [Local setup](docs/setup.md): prerequisites, daily commands, environment variables,
  troubleshooting
- [User guide](docs/user-guide.md): how to use Home, workspaces, nodes, notes, links,
  relationships, mind maps, the knowledge graph, the timeline, search, tags, attachments,
  backups, and export and import
- [Architecture](docs/architecture.md): packages, process model, IPC request flow, workspace
  lifecycle, write coordinator, autosave, notes, relationships, wikilinks, search, mind maps,
  knowledge graph, learning timeline, attachments, export and import, backups and restore,
  security
- [Data model](docs/data-model.md): every table and how it is used, references and backlinks,
  timeline grouping, reviews, milestones, learning dates and timezone, attachment lifecycle,
  import history, the export archive and backup layouts, migrations
- [IPC contracts](docs/ipc-contracts.md): envelope, error codes, adding a channel, all 97 channels
- [Testing](docs/testing.md): test layers, rules, smoke test, accessibility check, search and
  portability benchmarks, security tests for archives and backups, what is not automated yet
- [Packaging runbook](docs/runbooks/packaging.md): build, package, smoke test, fuses, app icon,
  code signing, updating an installation, release checklist
- [Backup and restore runbook](docs/runbooks/backup-and-restore.md): where backups are, changing
  the folder, restoring the open workspace, restoring after losing a drive, what is verified,
  measured restore time
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
  - [ADR-0008 Wikilinks and note schema version 2](docs/adr/0008-wikilinks-and-note-schema-v2.md)
  - [ADR-0009 Mind map editing](docs/adr/0009-mind-map-editing.md)
  - [ADR-0010 Knowledge graph and learning timeline](docs/adr/0010-graph-and-timeline.md)
  - [ADR-0011 Workspace export and import](docs/adr/0011-export-import.md)
