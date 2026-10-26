# Testing

mmap uses [Vitest](https://vitest.dev) for every automated test, plus a smoke test that runs inside
the packaged app. This page lists the test layers, how to run them, the rules every change must
follow, and what is not automated yet.

## Test projects

`vitest.config.ts` at the root defines one Vitest project per package plus a repository-level
architecture project. All run on plain Node 24; none of them start Electron.

| Project          | Location                                   | What it covers                                                                                                                                                                                                                                                                                                                                                                                   | Tests (Phase 0) |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `domain`         | `packages/domain/src/**/*.test.ts`         | Unit tests: UTC timestamp format, canonical UUIDs, relationship endpoint rules (self-links, canonical undirected order), page-size clamping.                                                                                                                                                                                                                                                     | 23              |
| `contracts`      | `packages/contracts/src/**/*.test.ts`      | Catalogue matches the channel list; request schemas reject payloads; response schemas reject extra fields; error-code schema.                                                                                                                                                                                                                                                                    | 6               |
| `storage-sqlite` | `packages/storage-sqlite/src/**/*.test.ts` | Integration tests on real temporary SQLite files: connection settings (foreign keys, WAL, `synchronous`, `trusted_schema`); migrations (fresh migrate, idempotence, backup hook ordering and failure, refusing newer schemas, rollback on failure, checksum mismatch, sequence check); schema constraints, workspace isolation, hierarchy cycles, FTS5 sync and Unicode, attachment path checks. | 37              |
| `desktop`        | `apps/desktop/src/**/*.test.ts`            | Security and IPC: renderer location and dev-server rules, trusted-origin checks, CSP content, `app://` path resolution (traversal, encoded separators, drive letters, NUL, junction escape), IPC handler sender checks, payload validation, response leakage, error mapping.                                                                                                                     | 40              |
| `architecture`   | `tests/**/*.test.ts`                       | Module boundary scan driven by `tooling/architecture-rules.mjs` (the same rules ESLint uses), plus a test of the import extractor itself.                                                                                                                                                                                                                                                        | 6               |

The total at the end of Phase 0 is 112 tests. The counts will grow; they are listed to show the
balance between layers, not as a target.

## Running tests

| Command                                                 | Runs                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `npm test`                                              | Every project once                                                               |
| `npm run test:watch`                                    | Every project in watch mode                                                      |
| `npx vitest run --project storage-sqlite`               | One project (`domain`, `contracts`, `storage-sqlite`, `desktop`, `architecture`) |
| `npx vitest run packages/storage-sqlite/src/migrations` | Tests under one path                                                             |
| `npx vitest run -t "hierarchy cycles"`                  | Tests whose name matches                                                         |
| `npm run verify`                                        | Format, lint, typecheck, tests and build                                         |
| `npm run smoke:packaged`                                | The packaged smoke test (see below)                                              |

Storage tests create files named `mmap-test-*` in the OS temp directory and delete them when each
test finishes.

## Rules

These follow PRD §10.6 and §11 and the cross-cutting rules in the implementation plan.

- **Real SQLite, not mocks.** Anything involving SQL, transactions, constraints, triggers, FTS5 or
  migrations is tested against a real database file. Use
  `packages/storage-sqlite/src/test-support/temporary-database.ts`: `openMigratedTemporaryDatabase()`
  gives a fully migrated file in a temp folder with a `dispose()` that cleans up; the `insert`
  helpers create minimal valid rows; `nextTestId()` returns deterministic canonical UUIDs;
  `FIXED_TIME` is a valid UTC timestamp. Use a file rather than `:memory:` so WAL behaviour is
  real.
- **Mock only external boundaries.** Fakes are fine for things outside the unit under test, such
  as the service passed to an IPC handler or the failure logger (`vi.fn()`). Inject clocks and ID
  generators (`Clock`, `IdGenerator` in `packages/domain`) instead of mocking `Date`.
- **Every bug fix gets a regression test** that fails without the fix.
- **Negative and security tests are required.** For each rule, test that the violation is
  rejected, not only that valid input works. Every IPC channel needs tests for untrusted senders,
  malformed and hostile payloads, and response leakage. Path handling needs traversal, encoded
  separator, drive-letter and symlink or junction cases.
- **Test the database's second line of defense separately** from the domain rule. Services
  enforce invariants first; schema tests prove the database still rejects a violation if a
  service has a bug.
- **Keep domain tests free of infrastructure.** The architecture test will fail if a domain test
  file imports Node built-ins, SQLite or Electron, because it scans all files under
  `packages/domain/src`.

## Packaged smoke test

Unit and integration tests run on system Node, not inside Electron. The smoke test checks what only
the packaged app can prove: that the bundled runtime, protocol, CSP and bridge work together
offline.

```sh
npm run package:dir -w @mmap/desktop
npm run smoke:packaged
```

`apps/desktop/scripts/smoke-packaged.mjs` starts `apps/desktop/release/win-unpacked/mmap.exe` with
`--smoke-test --smoke-report=<temp file>` and Chromium flags that send all traffic to a closed
local port (`--proxy-server=http://127.0.0.1:9`), so any network request would fail. In smoke-test
mode the app uses a temporary profile directory, never shows its window, runs the checks in
`apps/desktop/src/main/smoke-test.ts`, writes a JSON report and exits. The script prints one line
per check and fails if any check fails, the exit code is not 0, or 120 seconds pass.

| Check                                                 | What it proves                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| sqlite migrations, FTS5 and integrity on a fresh file | The SQLite inside Electron runs every migration, answers an FTS5 query and passes `integrity_check`. |
| renderer loads from app protocol                      | The `app://mmap` handler serves the bundled renderer.                                                |
| React shell renders main navigation                   | Bundled scripts and styles are allowed by the CSP and React mounted (`nav[aria-label="Main"]`).      |
| preload bridge returns app info over IPC              | `window.mmap.app.getInfo()` succeeds end to end and reports FTS5 as available.                       |
| renderer has no Node.js access                        | `require`, `process` and `module` are undefined in the page.                                         |
| content security policy blocks inline scripts         | An injected inline `<script>` does not execute.                                                      |

The smoke test runs the unpacked build, not the NSIS installer. See the
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

These are required by PRD §11 but belong to later phases. Do not assume they are covered.

| Area                                      | Status and owner                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Installed-app end-to-end tests            | Nothing drives the NSIS-installed app through user workflows. Added as features land (Phases 1–5).       |
| Offline workflow tests                    | Only startup is checked offline (smoke test). Full offline workflows need the features first.            |
| Recovery tests                            | Termination during save/import, disk full, stale locks, failed migrations in the app: Phases 1 and 5.    |
| Hostile notes and archives                | Note sanitization (Phase 1) and malicious ZIP imports (Phase 5).                                         |
| Repository contract tests                 | No repositories exist yet; each one arrives with its tests from Phase 1.                                 |
| Performance                               | Benchmarks on the PRD §9 reference dataset and machine: search harness in Phase 2, full pass in Phase 5. |
| Accessibility                             | Keyboard, WCAG 2.2 AA and screen-reader smoke tests: Phase 5 pass, with checks per feature earlier.      |
| Clean-machine install, upgrade, uninstall | Phase 5 release gate ([ADR-0004](adr/0004-installer-signing-and-updates.md)).                            |
| Renderer component tests                  | There is no DOM test environment yet; add one when the renderer gains real logic.                        |
