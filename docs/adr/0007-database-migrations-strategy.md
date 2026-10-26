# ADR-0007: Database migrations strategy

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §7.1 requires versioned SQL migrations. PRD §9 requires: back up before schema changes,
migrate transactionally where possible, keep a recoverable original on failure, refuse newer
schemas without modification, and prevent incompatible downgrades from opening migrated
databases. Each workspace is its own SQLite file (PRD §5.1), so every workspace migrates
independently when it is opened.

## Decision

Implemented in `packages/storage-sqlite/src/migrations/`.

1. **Format.** Each migration is a TypeScript module exporting `{ version, name, sql }`
   (`0001-initial-schema.ts`, …), listed in order in `migrations/index.ts`. TypeScript modules,
   not loose `.sql` files, so migrations are bundled into the main process and cannot be missing
   from an installed build. Versions are sequential from 1 with no gaps (checked at runtime).
2. **Two version records.** `PRAGMA user_version` holds the current version and is read before
   anything is written. The `schema_migrations` table holds one row per applied migration with a
   SHA-256 of its SQL.
3. **Refuse newer.** If `user_version` is greater than the newest migration this build knows,
   `SchemaTooNewError` is thrown before any write. Tests confirm that the file bytes are unchanged.
   This is also what stops an older (downgraded) app from opening a migrated database.
4. **Immutable history.** If a stored checksum differs from the shipped migration, or the history
   and `user_version` disagree, `MigrationHistoryError` is thrown. Released migrations are never
   edited; changes go in a new migration.
5. **Backup first.** `migrateToLatest` calls a `beforeApply` hook once, only when something is
   pending, before any change. The desktop app takes a consistent `node:sqlite` `backup()` in
   that hook (wired up in Phase 1, together with the workspace lifecycle). If the hook fails,
   nothing is migrated.
6. **One transaction per migration.** Each migration runs in `BEGIN IMMEDIATE … COMMIT`
   together with its `schema_migrations` row and `user_version` update. On error it rolls back
   and throws `MigrationFailedError` with the version reached. Migrations must not contain
   statements that cannot run in a transaction (`VACUUM`, `PRAGMA journal_mode`).
7. **Constraints as a second line of defense.** Migrations encode PRD invariants as STRICT
   tables, CHECK, UNIQUE and composite foreign keys, and a few triggers (see
   `docs/data-model.md`). Services remain the primary place for the rules.

## Consequences

- A failed migration leaves the database at the last complete version, and the pre-migration
  backup remains as the recoverable original.
- Rebuilding a table (SQLite's 12-step `ALTER TABLE` procedure) needs foreign keys turned off,
  which is not possible inside a transaction. A migration that needs it requires a dedicated
  runner path and its own ADR.
- Very large data migrations may hold the write lock for a long time; they should run in a
  worker with visible progress (PRD §7.2).
- Editing a released migration is caught by checksum in every existing workspace. Developers
  must reset local test databases instead of editing history.

## Alternatives considered

- **ORM-managed migrations (Prisma, Drizzle, Knex).** Prisma is reserved for the future
  PostgreSQL adapter (PRD §7.1). The others add a dependency and abstraction without supporting
  `node:sqlite` directly. Rejected.
- **Loose `.sql` files read at runtime.** Must be copied into the package and resolved from the
  ASAR at runtime: more ways to fail in the installed build. Rejected.
- **Down migrations.** SQLite's limited `ALTER TABLE` makes reliable down migrations expensive;
  the backup taken before migrating is the rollback path. Rejected.
