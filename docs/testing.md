# Testing

mmap uses [Vitest](https://vitest.dev) for every automated test, plus a smoke test that runs inside
the packaged app. This page lists the test layers, how to run them, the rules every change must
follow, and what is not automated yet.

## Test projects

`vitest.config.ts` at the root defines one Vitest project per package plus a repository-level
architecture project. All run on plain Node 24; none of them start Electron. Tests run in the
`node` environment; a file that needs a DOM opts in with a `// @vitest-environment jsdom` comment
(currently `editor-schema.test.ts` and `wikilink-node.test.ts`).

| Project          | Location                                   | What it covers                                                                                                                                                                                                                                                                                                                                                      | Tests |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `domain`         | `packages/domain/src/**/*.test.ts`         | Pure unit tests: timestamps and IDs, relationship endpoint rules, page sizes, workspace names and folder names, label normalization, note document validation and limits (including wikilinks), wikilink reference extraction, link policy, plain-text extraction, attachment file-type policy, editing-session boundaries.                                         | 346   |
| `contracts`      | `packages/contracts/src/**/*.test.ts`      | Catalogue matches the channel list; request schemas reject payloads; response schemas reject extra fields; error-code schema.                                                                                                                                                                                                                                       | 6     |
| `storage-sqlite` | `packages/storage-sqlite/src/**/*.test.ts` | Integration tests on real temporary SQLite files: connection settings, migrations, schema constraints and FTS5; the write coordinator and pre-migration backup; the node, tag, attachment, relationship and workspace services and note references running on the SQLite repositories; FTS query building, search and title lookup; workspace isolation throughout. | 191   |
| `desktop`        | `apps/desktop/src/**/*.test.ts`            | Security and IPC (renderer location, origins, CSP, `app://` paths, IPC handler); workspace manager; attachment file store, preview resolver and attachment services with real files; external links; the autosave state machine; the editor/schema contract; wikilink rendering; the Phase 1 acceptance test.                                                       | 187   |
| `architecture`   | `tests/**/*.test.ts`                       | Module boundary scan driven by `tooling/architecture-rules.mjs` (the same rules ESLint uses), plus a test of the import extractor itself.                                                                                                                                                                                                                           | 6     |

The total on branch `phase-2-connections` is **736 passing tests in 37 files, plus one skipped
benchmark file** (Phase 1 ended with 570, Phase 0 with 112). Run `npx vitest run` to see the
current numbers; the counts show the balance between layers and are not a target.

### Test files added in Phase 1

| Area                       | File                                                                                                                                                                    | What it proves                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain rules               | `packages/domain/src/notes/*.test.ts`, `files/attachment-policy.test.ts`, `text/labels.test.ts`, `timeline/editing-session.test.ts`, `workspace/workspace-name.test.ts` | Hostile note JSON (unknown types, prototype keys, oversized and deeply nested documents), unsafe and obfuscated links, plain-text output, executables by extension and magic bytes, disguised names, the 30-minute boundary.                                                                                                                             |
| Write coordinator          | `packages/storage-sqlite/src/sqlite-connections.test.ts`                                                                                                                | Writes outside a transaction are refused; readers do not see uncommitted writes; overlapping transactions are serialized; a failed transaction rolls back and the queue continues; nested calls join; `close` waits; pre-migration backup taken only for existing data and kept when a migration fails; workspace service seeding.                       |
| Node service               | `packages/storage-sqlite/src/repositories/knowledge-node-service.test.ts`                                                                                               | Create, update, duplicate, delete; stale revisions rejected without changes; unsafe notes rejected; plain text and FTS updated; timeline session grouping and title-only edits; keyset pagination stable under edits; tampered cursors; cross-workspace access; child placements promoted on delete.                                                     |
| Tag service                | `packages/storage-sqlite/src/repositories/tag-service.test.ts`                                                                                                          | Case- and spacing-insensitive reuse, idempotent assignment without revision bump, rename keeps assignments, duplicates rejected, delete keeps nodes, "has all tags" filter with honest totals, cross-workspace tagging blocked by service and foreign key.                                                                                               |
| Attachment service         | `packages/storage-sqlite/src/repositories/attachment-service.test.ts`                                                                                                   | Register and list, missing node, metadata removal before file removal, cascade on node delete, unsafe stored paths rejected by the database, no cross-workspace access.                                                                                                                                                                                  |
| Workspace manager          | `apps/desktop/src/main/workspaces/workspace-manager.test.ts`                                                                                                            | First run creates or adopts the default workspace; restart reopens it; missing folders and databases are reported and never replaced; invalid and newer manifests; locking, stale-lock recovery, foreign-host locks; switching keeps the old workspace on failure; network shares rejected; cloud-sync flagged; serialized operations; damaged settings. |
| File store and previews    | `apps/desktop/src/main/attachments/file-attachment-store.test.ts`, `attachment-preview.test.ts`                                                                         | Verified copies under generated names, size limit during copy, source changed, traversal, absolute paths and junction escapes, reconciliation of staging leftovers and orphans; preview host, ID and type rules, SVG refused.                                                                                                                            |
| Attachment flow end to end | `apps/desktop/src/main/services/attachment-ipc-services.test.ts`                                                                                                        | With real files and a real workspace: sources untouched and deletable, disguised executables refused, per-file size limit, cancelled dialog, open re-check refuses a stored file replaced by a program, file removal with the attachment and with the node, orphan cleanup on reopen.                                                                    |
| External links             | `apps/desktop/src/main/services/external-link-service.test.ts`                                                                                                          | Only `http`, `https` and `mailto` reach the OS opener; `file:`, custom protocols, UNC paths and scripts are refused.                                                                                                                                                                                                                                     |
| Autosave state machine     | `apps/desktop/src/renderer/src/nodes/node-draft-saver.test.ts`                                                                                                          | With Vitest fake timers: save after 1 s idle, "Saved" only after commit, edits during a save are saved next with the new revision, failures keep the draft and its recovery copy, conflict choices, flush, undo is no change, no automatic retry when invalid.                                                                                           |
| Editor and schema contract | `apps/desktop/src/renderer/src/notes/editor-schema.test.ts` (jsdom)                                                                                                     | The real Tiptap editor's output for every supported node and mark is accepted by `parseNoteDocument` and round-trips stably; `javascript:` links reach neither the DOM nor storage.                                                                                                                                                                      |
| Acceptance criterion 3     | `apps/desktop/src/main/phase1-acceptance.test.ts`                                                                                                                       | A node with formatted text, a table, a code block, inline and display math, tags and an attachment survives exit and restart (a new `WorkspaceManager` on the same profile), and the original file can be deleted.                                                                                                                                       |

### Test files added or extended in Phase 2

| Area                                     | File                                                                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relationships (acceptance criterion 4)   | `packages/storage-sqlite/src/repositories/relationship-service.test.ts` | A `depends on` B is stored and listed as A → B from both nodes; a reversed `related to` duplicate is rejected while other types between the same nodes are allowed; the reverse of a directed relationship is allowed but an exact duplicate is not; self-links rejected; reversal and type change re-check duplicates and re-order undirected endpoints; delete keeps nodes; `relationship_created` timeline event; description limit; built-in types; case-insensitive type names; archived types keep relationships but block new ones until restored; direction changes only while unused; no cross-workspace nodes or types.                                                                                 |
| Note references (acceptance criterion 5) | `packages/storage-sqlite/src/repositories/note-references.test.ts`      | A saved link puts the source in the target's backlinks with an excerpt and creates no relationship; renaming the target keeps the link (identity is the ID); removing the link and saving removes the backlink; deleting the target leaves the link text readable and unresolved; several links from one note count as one backlink; duplicates copy outgoing links; self-links are not backlinks; links to another workspace are never stored or resolved.                                                                                                                                                                                                                                                       |
| Reference extraction                     | `packages/domain/src/notes/note-references.test.ts`                     | One reference per occurrence in document order with excerpts, links inside tables, long excerpts shortened with ellipses, no references without links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Note schema version 2                    | `packages/domain/src/notes/note-document.test.ts`, `plain-text.test.ts` | Wikilinks with a canonical target ID and label are accepted, unknown attributes (a cached title) dropped, a wikilink used as a block rejected; plain text contains the label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Search                                   | `packages/storage-sqlite/src/search/sqlite-search-index.test.ts`        | Title matches and summary matches each rank above note-only matches; diacritics and case ignored; last-word prefix only; all words required; Hebrew and Arabic text; pointed Hebrew matches only with the same pointing; FTS triggers follow edits; hostile input (`"`, `title:secret`, `OR`, `NEAR(…)`, `*`, `^`, SQL text, NUL, 10,000 characters) is treated as literal words; plain-text snippets with markup kept literal and marker characters stripped; paging without gaps or repeats; equal scores ordered by ID; tag filters; workspace isolation of results, counts, tags and title lookup; title lookup ordering, LIKE wildcards literal, exclusions, limits, ASCII-only case folding, Hebrew titles. |
| FTS query building and snippets          | `packages/storage-sqlite/src/search/fts-query.test.ts`                  | Words quoted and joined with implicit AND, prefix only on the last word of two or more characters, emoji and operators dropped, niqqud kept inside words, mixed-direction text, bounded word count and length, no split surrogate pairs; snippet segment parsing, merging and stray-marker removal.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Wikilink rendering (jsdom)               | `apps/desktop/src/renderer/src/notes/wikilink-node.test.ts`             | With the real Tiptap editor: targets collected once; nothing marked before resolution arrives; only links whose target is missing are marked unresolved, with an explanatory label; repair points a link at another node and keeps its label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Editor and schema contract               | `apps/desktop/src/renderer/src/notes/editor-schema.test.ts`             | Extended with a wikilink, so editor output containing links is accepted by `parseNoteDocument` and round-trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Search benchmark (skipped by default)    | `packages/storage-sqlite/src/search/search.benchmark.test.ts`           | See [Search benchmark](#search-benchmark).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Running tests

| Command                                                 | Runs                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm test`                                              | Every project once                                                               |
| `npm run test:watch`                                    | Every project in watch mode                                                      |
| `npx vitest run --project storage-sqlite`               | One project (`domain`, `contracts`, `storage-sqlite`, `desktop`, `architecture`) |
| `npx vitest run packages/storage-sqlite/src/migrations` | Tests under one path                                                             |
| `npx vitest run -t "stale lock"`                        | Tests whose name matches                                                         |
| `npm run verify`                                        | Format, lint, typecheck, tests and build                                         |
| `npm run smoke:packaged`                                | The packaged smoke test (see below)                                              |

Storage tests create files named `mmap-test-*` in the OS temp directory; workspace, attachment and
acceptance tests create their own temporary folders. All of them are deleted when each test
finishes.

## Rules

These follow PRD §10.6 and §11 and the cross-cutting rules in the implementation plan.

- **Real SQLite, not mocks.** Anything involving SQL, transactions, constraints, triggers, FTS5 or
  migrations is tested against a real database file. Use
  `packages/storage-sqlite/src/test-support/temporary-database.ts`: `openMigratedTemporaryDatabase()`
  gives a fully migrated file in a temp folder with a `dispose()` that cleans up; the `insert`
  helpers create minimal valid rows; `nextTestId()` returns deterministic canonical UUIDs;
  `FIXED_TIME` is a valid UTC timestamp. Use a file rather than `:memory:` so WAL behaviour is
  real. Domain services are tested in `packages/storage-sqlite` for this reason: they run on the
  real repositories.
- **Real files for file handling.** The attachment store and the workspace manager are tested on
  real temporary folders; the store tests create Windows junctions for the escape cases.
- **Mock only external boundaries.** Fakes are fine for things outside the unit under test: the
  native dialogs and OS opener passed to the attachment and workspace services, `isProcessAlive`
  in the lock environment, the service passed to an IPC handler, the failure logger. Inject clocks,
  ID generators and timers instead of mocking globals where possible; the autosave tests use
  Vitest fake timers.
- **Every bug fix gets a regression test** that fails without the fix. Phase 1 examples: a
  follow-up autosave was never scheduled for edits made during an in-flight save; `list()` threw
  synchronously on an invalid cursor instead of rejecting.
- **Negative and security tests are required.** For each rule, test that the violation is
  rejected, not only that valid input works. Every IPC channel needs tests for untrusted senders,
  malformed and hostile payloads, and response leakage. Path handling needs traversal, encoded
  separator, drive-letter and symlink or junction cases.
- **Test the database's second line of defense separately** from the domain rule. Services
  enforce invariants first; schema tests prove the database still rejects a violation if a
  service has a bug (for example cross-workspace tagging and unsafe attachment paths).
- **Keep domain tests free of infrastructure.** The architecture test will fail if a domain test
  file imports Node built-ins, SQLite or Electron, because it scans all files under
  `packages/domain/src`.

### Recommended habit: check that a test can fail

A passing test only helps if it would fail when the rule breaks. When you add a test for a rule,
break the rule on purpose (comment out the revision check, accept `javascript:` links, skip the
lock check), run the test, confirm it fails for the right reason, and restore the code. This
is a manual practice, not an automated mutation-testing tool; nothing in CI does it for you.

## Packaged smoke test

Unit and integration tests run on system Node, not inside Electron. The smoke test checks what only
the packaged app can prove: that the bundled runtime, protocol, CSP, bridge and workspace stack
work together offline.

```sh
npm run package:dir -w @mmap/desktop
npm run smoke:packaged
```

`apps/desktop/scripts/smoke-packaged.mjs` starts `apps/desktop/release/win-unpacked/mmap.exe` with
`--smoke-test --smoke-report=<temp file>` and Chromium flags that send all traffic to a closed
local port (`--proxy-server=http://127.0.0.1:9`), so any network request would fail. In smoke-test
mode the app uses a fresh temporary profile directory (so it never touches your real settings or
workspaces), never shows its window, runs the checks in `apps/desktop/src/main/smoke-test.ts`,
closes the workspace, writes a JSON report and exits. The script prints one line per check and
fails if any check fails, the exit code is not 0, or 120 seconds pass.

| Check                                                             | What it proves                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sqlite migrations, FTS5 and integrity on a fresh file             | The SQLite inside Electron runs every migration, answers an FTS5 query and passes `integrity_check`.                                                                                                                                                                                                    |
| renderer loads from app protocol                                  | The `app://mmap` handler serves the bundled renderer.                                                                                                                                                                                                                                                   |
| React shell renders main navigation                               | Bundled scripts and styles are allowed by the CSP and React mounted (`nav[aria-label="Main"]`).                                                                                                                                                                                                         |
| preload bridge returns app info over IPC                          | `window.mmap.app.getInfo()` succeeds end to end and reports FTS5 as available.                                                                                                                                                                                                                          |
| first-run workspace is created and open                           | On a fresh profile, `workspace:get-state` reports an open workspace (the default `My Knowledge`).                                                                                                                                                                                                       |
| node create, save, conflict and delete through the bridge         | From the renderer: create a node, save a note (revision 2), a stale save returns `REVISION_CONFLICT`, the note round-trips, tagging and tag filtering work, delete succeeds.                                                                                                                            |
| relationships, wikilinks, backlinks and search through the bridge | From the renderer: a `depends on` relationship keeps its direction, a reversed `related to` duplicate returns `DUPLICATE`, a note with a wikilink saves and appears in the target's backlinks, `search:query` finds the note text, `nodes:lookup` finds the target title; both nodes are deleted again. |
| renderer has no Node.js access                                    | `require`, `process` and `module` are undefined in the page.                                                                                                                                                                                                                                            |
| content security policy blocks inline scripts                     | An injected inline `<script>` does not execute.                                                                                                                                                                                                                                                         |
| attachment stored and previewed through mmap-attachment           | The main process copies a one-pixel PNG through the real attachment store and registers it (`smoke-attachments.ts`); the page loads it through `mmap-attachment://current/<id>`, and an unknown ID does not load.                                                                                       |

There are 10 checks. The attachment check bypasses `attachments:add`, because adding a file through
the bridge needs a native dialog; the full add flow is covered by `attachment-ipc-services.test.ts`
and the acceptance test instead. The smoke test runs the unpacked build, not the NSIS installer.
See the [packaging runbook](runbooks/packaging.md) for building and for manual installer checks.

## Search benchmark

`packages/storage-sqlite/src/search/search.benchmark.test.ts` measures `SqliteSearchIndex` on the
PRD §9 dataset size. It is skipped unless `MMAP_BENCHMARK=1` is set, because building the data
takes a while. Run it from the repository root (Git Bash syntax):

```sh
MMAP_BENCHMARK=1 npx vitest run --project storage-sqlite search.benchmark --silent=false
```

What it does:

- Builds a fresh migrated database with 10,000 nodes, 30,000 relationships and 200 tags, generated
  by a seeded pseudo-random generator so every run measures the same data. Rows are inserted with
  SQL directly, not through the services. Word frequencies are skewed, and the vocabulary
  includes Hebrew words.
- Runs 250 searches: single words, second pages, two words, prefixes, tag filters, Hebrew words
  and queries with no hits. Runs 220 title lookups, a third of them substrings from the middle of
  a title (the slower, non-prefix path).
- Prints p50, p95 and maximum for all searches, per search workload and for title lookup, and
  fails if search p95 is 500 ms or more
  (PRD §9) or title lookup p95 is 100 ms or more (a budget for interactive typing). Each search
  asks for 20 results.

Results measured on 2026-10-27 on a developer machine (not the reference machine):

| Operation    | Calls | p50    | p95   | Max   |
| ------------ | ----- | ------ | ----- | ----- |
| Search       | 250   | 3.3 ms | 50 ms | 63 ms |
| Title lookup | 220   | 25 ms  | 31 ms | 41 ms |

Limits of this measurement: it runs on system Node, calls the index directly (no IPC, no
renderer), on a developer computer rather than the documented four-core, 16 GB, SSD reference
machine, and not with the installed build. The PRD target is met with a wide margin here, but it
still has to be confirmed on the reference machine with the installed app (Phase 5 performance
pass).

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, every pull request, and on demand. It has
three jobs:

| Job                                      | Runner           | Steps                                                                                                                                                                                                              |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verify, package and smoke test (Windows) | `windows-latest` | `npm ci`, `format:check`, `lint`, `typecheck`, `npm test`, `npm run package -w @mmap/desktop` (builds and creates the installer), `npm run smoke:packaged`, upload the installer as a build artifact (kept 7 days) |
| Dependency audit                         | `ubuntu-latest`  | `npm ci --ignore-scripts`, then `npm audit --audit-level=critical` (dev dependencies included, because they are bundled into the app)                                                                              |
| Secret scan                              | `ubuntu-latest`  | gitleaks over the full git history                                                                                                                                                                                 |

`.github/dependabot.yml` proposes weekly npm and GitHub Actions updates.

To reproduce the Windows job locally before pushing:

```sh
npm run verify
npm run package:dir -w @mmap/desktop
npm run smoke:packaged
```

## Not automated yet

These are required by PRD §11 but are not covered yet. Do not assume they are.

| Area                                      | Status and owner                                                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed-app end-to-end tests            | Nothing drives the UI of the installed app (clicks, typing, dialogs). The smoke test drives the bridge only. Still missing after Phase 2: typing `[[`, the picker, relationship forms and search box are not exercised in the real app. |
| Renderer component tests                  | Only the autosave state machine, the editor/schema contract and wikilink rendering are tested; React components (library, search, panels, pickers, dialogs, banners) have no tests.                                                     |
| Offline workflow tests                    | The smoke test runs startup and node workflows offline; attachments and the full UI are not exercised offline in the packaged app.                                                                                                      |
| Recovery tests                            | Stale locks, failed migrations and orphan cleanup are covered in Node tests. Killing the real app during a save, and disk-full on a real volume, are not; Phase 5.                                                                      |
| Hostile archives                          | Malicious ZIP imports arrive with import in Phase 5.                                                                                                                                                                                    |
| Performance                               | The search harness exists and passes on a developer machine ([Search benchmark](#search-benchmark)); it is not run in CI. The reference-machine, installed-build pass is Phase 5.                                                       |
| Accessibility                             | Keyboard, WCAG 2.2 AA and screen-reader smoke tests: Phase 5 pass, with checks per feature earlier.                                                                                                                                     |
| Clean-machine install, upgrade, uninstall | Phase 5 release gate ([ADR-0004](adr/0004-installer-signing-and-updates.md)).                                                                                                                                                           |
| Mutation testing                          | Not automated; see [the recommended habit](#recommended-habit-check-that-a-test-can-fail).                                                                                                                                              |

## Added after the Phase 2 review

- `packages/contracts/src/catalogue.test.ts`: every IPC channel (44) rejects hostile payloads —
  raw SQL text, arrays, objects with unexpected properties such as paths, `null` and numbers.
- `apps/desktop/src/main/services/phase2-ipc-services.test.ts`: the relationship, relationship-type,
  lookup, backlinks, link-resolution and search channel handlers against a real workspace,
  including user-facing error codes (`INVARIANT_VIOLATION`, `VALIDATION_FAILED`).
- `packages/storage-sqlite/src/migrations/upgrade.test.ts`: a database created exactly as a Phase 1
  build would is backed up, upgraded to the current schema with its data intact, and is then
  refused by the Phase 1 migration list (`SchemaTooNewError`).
