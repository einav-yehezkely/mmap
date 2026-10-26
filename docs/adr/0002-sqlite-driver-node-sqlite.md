# ADR-0002: SQLite driver: built-in node:sqlite

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §7.1 requires embedded SQLite with FTS5 and versioned migrations, "a maintained SQLite driver
with parameterized queries", and that native dependencies are packaged for Electron and tested
in the installed build. Users must not install Node.js or database services. PRD §9 requires
consistent backups through SQLite's backup mechanism, not raw file copies. PRD §14 asks for the
driver choice to be recorded and validated in a packaged spike.

Facts established by the Phase 0 spike (2026-10-26, Windows 11 x64):

| Check                                                                        | Result                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `better-sqlite3@13.0.3` prebuilt binary for Electron 44 (ABI 149, win32-x64) | **Not published** (HTTP 404); would need a local C++ toolchain to compile |
| Build machine toolchain                                                      | No Visual Studio C++ tools, no Python                                     |
| `node:sqlite` inside Electron 44.9.3 (Node 24.22.0)                          | Available; SQLite **3.53.4**; FTS5 works; `backup()` available            |
| `node:sqlite` in system Node 24.21.0 (tests)                                 | Same SQLite **3.53.4**; no experimental warning                           |
| Packaged app (`--smoke-test`, offline, ASAR + fuses)                         | Migrations, FTS5 query and `integrity_check` pass                         |

## Decision

Use Node's built-in `node:sqlite` module (`DatabaseSync`) as the SQLite driver, wrapped by
`packages/storage-sqlite`.

- Connections are opened only through `openDatabase()` (`connection.ts`), which enables foreign
  keys, WAL, `synchronous = FULL`, `trusted_schema = OFF`, a bounded busy timeout, disables
  double-quoted string literals and disables extension loading, and verifies the result.
- All values are passed as bound parameters. The only interpolated SQL is trusted literals
  (PRAGMA names, migration version integers), each marked with a comment.
- Consistent backups use `node:sqlite`'s `backup()` (online backup API) in Phase 5 and before
  migrations.
- Integration tests run on system Node 24 against real temporary database files. The packaged
  smoke test re-verifies the engine inside Electron, because the two runtimes could diverge in a
  future upgrade.

## Consequences

- No native module: nothing to compile, rebuild for the Electron ABI, sign separately, or
  unpack from ASAR. `electron-builder` runs with `npmRebuild: false`.
- Tests and the app use the same engine build, avoiding the classic "tests pass on Node's ABI,
  app crashes on Electron's ABI" problem.
- The SQLite version is tied to the Electron/Node version. Upgrading Electron can change SQLite;
  the upgrade checklist must include re-running the storage tests and the packaged smoke test,
  and comparing `sqlite_version()` in Settings › About.
- `DatabaseSync` is synchronous. Long operations would block the main process, so heavy work
  (import, export, backup, large migrations) must run in a worker thread with its own connection
  (PRD §7.2 "run heavy database/archive/layout work away from the renderer"). The write
  coordinator in Phase 1 serializes writes.
- `node:sqlite` has a smaller API than `better-sqlite3` (no user-defined aggregate helpers in
  older Node versions, fewer conveniences). Phase 0 needs none of them.
- Assumption: Node keeps `node:sqlite` stable through the Node 24 line. If an Electron upgrade
  ships a Node without it or with breaking changes, revisit this ADR.

## Alternatives considered

- **better-sqlite3.** Mature and fast, but no Electron 44 prebuild exists, so every developer and
  CI runner would need a C++ toolchain, and the native binary must be rebuilt for each Electron
  upgrade. Rejected for now; reconsider if `node:sqlite` proves insufficient.
- **sqlite3 (async, node-gyp).** Same native-build problem, callback API, less maintained.
  Rejected.
- **WASM SQLite (sql.js / official WASM build).** No native build, but file persistence, WAL and
  durability guarantees are weaker or require custom VFS work. Rejected.
