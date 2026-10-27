# Testing

mmap uses [Vitest](https://vitest.dev) for every automated test, plus a smoke test that runs inside
the packaged app. This page lists the test layers, how to run them, the rules every change must
follow, and what is not automated yet.

## Test projects

`vitest.config.ts` at the root defines one Vitest project per package plus a repository-level
architecture project. All run on plain Node 24; none of them start Electron. Tests run in the
`node` environment; a file that needs a DOM opts in with a `// @vitest-environment jsdom` comment
(currently only `editor-schema.test.ts`).

| Project          | Location                                   | What it covers                                                                                                                                                                                                                                                                            | Tests |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `domain`         | `packages/domain/src/**/*.test.ts`         | Pure unit tests: timestamps and IDs, relationship endpoint rules, page sizes, workspace names and folder names, label normalization, note document validation and limits, link policy, plain-text extraction, attachment file-type policy, editing-session boundaries.                    | 323   |
| `contracts`      | `packages/contracts/src/**/*.test.ts`      | Catalogue matches the channel list; request schemas reject payloads; response schemas reject extra fields; error-code schema.                                                                                                                                                             | 6     |
| `storage-sqlite` | `packages/storage-sqlite/src/**/*.test.ts` | Integration tests on real temporary SQLite files: connection settings, migrations, schema constraints and FTS5; the write coordinator and pre-migration backup; the node, tag, attachment and workspace services running on the SQLite repositories, including workspace isolation.       | 85    |
| `desktop`        | `apps/desktop/src/**/*.test.ts`            | Security and IPC (renderer location, origins, CSP, `app://` paths, IPC handler); workspace manager; attachment file store, preview resolver and attachment services with real files; external links; the autosave state machine; the editor/schema contract; the Phase 1 acceptance test. | 150   |
| `architecture`   | `tests/**/*.test.ts`                       | Module boundary scan driven by `tooling/architecture-rules.mjs` (the same rules ESLint uses), plus a test of the import extractor itself.                                                                                                                                                 | 6     |

The total on branch `phase-1-knowledge-base` is **570 tests in 29 files** (Phase 0 ended with 112).
Run `npx vitest run` to see the current numbers; the counts show the balance between layers and
are not a target.

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

| Check                                                     | What it proves                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sqlite migrations, FTS5 and integrity on a fresh file     | The SQLite inside Electron runs every migration, answers an FTS5 query and passes `integrity_check`.                                                                         |
| renderer loads from app protocol                          | The `app://mmap` handler serves the bundled renderer.                                                                                                                        |
| React shell renders main navigation                       | Bundled scripts and styles are allowed by the CSP and React mounted (`nav[aria-label="Main"]`).                                                                              |
| preload bridge returns app info over IPC                  | `window.mmap.app.getInfo()` succeeds end to end and reports FTS5 as available.                                                                                               |
| first-run workspace is created and open                   | On a fresh profile, `workspace:get-state` reports an open workspace (the default `My Knowledge`).                                                                            |
| node create, save, conflict and delete through the bridge | From the renderer: create a node, save a note (revision 2), a stale save returns `REVISION_CONFLICT`, the note round-trips, tagging and tag filtering work, delete succeeds. |
| renderer has no Node.js access                            | `require`, `process` and `module` are undefined in the page.                                                                                                                 |
| content security policy blocks inline scripts             | An injected inline `<script>` does not execute.                                                                                                                              |

Attachments are not covered by the smoke test, because adding a file needs a native dialog; they
are covered by `attachment-ipc-services.test.ts` and the acceptance test instead. The smoke test
runs the unpacked build, not the NSIS installer. See the
[packaging runbook](runbooks/packaging.md) for building and for manual installer checks.

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

| Area                                      | Status and owner                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Installed-app end-to-end tests            | Nothing drives the UI of the installed app (clicks, typing, dialogs). The smoke test drives the bridge only. Needed from Phase 2 onward.                           |
| Renderer component tests                  | Only the autosave state machine and the editor/schema contract are tested; React components (library, panels, dialogs, banners) have no tests.                     |
| Offline workflow tests                    | The smoke test runs startup and node workflows offline; attachments and the full UI are not exercised offline in the packaged app.                                 |
| Recovery tests                            | Stale locks, failed migrations and orphan cleanup are covered in Node tests. Killing the real app during a save, and disk-full on a real volume, are not; Phase 5. |
| Hostile archives                          | Malicious ZIP imports arrive with import in Phase 5.                                                                                                               |
| Performance                               | Benchmarks on the PRD §9 reference dataset and machine: search harness in Phase 2, full pass in Phase 5.                                                           |
| Accessibility                             | Keyboard, WCAG 2.2 AA and screen-reader smoke tests: Phase 5 pass, with checks per feature earlier.                                                                |
| Clean-machine install, upgrade, uninstall | Phase 5 release gate ([ADR-0004](adr/0004-installer-signing-and-updates.md)).                                                                                      |
| Mutation testing                          | Not automated; see [the recommended habit](#recommended-habit-check-that-a-test-can-fail).                                                                         |
