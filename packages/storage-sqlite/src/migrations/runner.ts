/**
 * Schema migration runner (PRD §9: "Back up before schema changes, migrate transactionally where
 * possible, and keep a recoverable original on failure. Refuse newer schemas without
 * modification. Prevent incompatible downgrades from opening migrated databases.").
 *
 * Bookkeeping lives in two places that must agree:
 * - `PRAGMA user_version`: a cheap header field we can read without touching any table, used to
 *   refuse newer databases before writing anything.
 * - `schema_migrations`: one row per applied migration with its SQL checksum, used to detect a
 *   database whose history does not match this build (edited or unknown migrations).
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { readPragmaNumber } from '../connection';
import type { Migration } from './migration';

export interface MigrationPlan {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pending: readonly Migration[];
}

export interface MigrationHooks {
  /**
   * Called once, before the first pending migration runs and only if there is at least one.
   * The desktop app takes a consistent pre-migration backup here (PRD §9). If the hook throws,
   * no migration is applied.
   */
  readonly beforeApply?: (plan: MigrationPlan) => Promise<void>;
  /** Supplies the `applied_at` timestamp; injected for deterministic tests. */
  readonly now?: () => string;
}

/** The database was written by a newer mmap version. It is left completely untouched. */
export class SchemaTooNewError extends Error {
  public constructor(
    public readonly databaseVersion: number,
    public readonly supportedVersion: number,
  ) {
    super(
      `This workspace uses schema version ${databaseVersion}, but this version of mmap supports ` +
        `up to ${supportedVersion}. Update mmap to open it.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

/** Stored migration history does not match the migrations shipped with this build. */
export class MigrationHistoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationHistoryError';
  }
}

/** A migration failed and was rolled back; the database remains at `fromVersion`. */
export class MigrationFailedError extends Error {
  public constructor(
    public readonly failedVersion: number,
    public readonly fromVersion: number,
    options: { cause: unknown },
  ) {
    super(`Schema migration ${failedVersion} failed and was rolled back.`, options);
    this.name = 'MigrationFailedError';
  }
}

const CREATE_BOOKKEEPING_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT;`;

/** SHA-256 of a migration's SQL text, used to detect edits to released migrations. */
export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql, 'utf8').digest('hex');
}

/**
 * Ensures the migration list is sequential (1, 2, 3, …) without gaps or duplicates.
 * A gap would make `user_version` ambiguous, so this is a programming error, not user error.
 */
export function assertSequentialMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations must be numbered sequentially from 1; found version ${migration.version} at position ${index + 1}.`,
      );
    }
  });
}

/**
 * Determines which migrations are pending without modifying the database.
 *
 * @throws SchemaTooNewError when the database is newer than this build.
 * @throws MigrationHistoryError when stored history disagrees with `migrations`.
 */
export function planMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[],
): MigrationPlan {
  assertSequentialMigrations(migrations);
  const targetVersion = migrations.length;
  const currentVersion = readPragmaNumber(database, 'user_version');

  // Checked first and before any write: an older build must never alter a newer database.
  if (currentVersion > targetVersion) {
    throw new SchemaTooNewError(currentVersion, targetVersion);
  }

  verifyHistory(database, migrations, currentVersion);

  return {
    currentVersion,
    targetVersion,
    pending: migrations.slice(currentVersion),
  };
}

/**
 * Brings the database schema up to the latest version.
 *
 * Each migration runs in its own `BEGIN IMMEDIATE` transaction together with its bookkeeping, so
 * a failure leaves the database at the last fully applied version. `BEGIN IMMEDIATE` takes the
 * write lock up front, so a concurrent writer causes a bounded busy wait rather than a failure
 * halfway through.
 */
export async function migrateToLatest(
  database: DatabaseSync,
  migrations: readonly Migration[],
  hooks: MigrationHooks = {},
): Promise<MigrationPlan> {
  const plan = planMigrations(database, migrations);
  if (plan.pending.length === 0) {
    return plan;
  }

  await hooks.beforeApply?.(plan);
  const now = hooks.now ?? (() => new Date().toISOString());

  let appliedVersion = plan.currentVersion;
  for (const migration of plan.pending) {
    applyOneMigration(database, migration, now(), appliedVersion);
    appliedVersion = migration.version;
  }

  return plan;
}

function applyOneMigration(
  database: DatabaseSync,
  migration: Migration,
  appliedAt: string,
  fromVersion: number,
): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(CREATE_BOOKKEEPING_TABLE);
    database.exec(migration.sql);
    database
      .prepare(
        'INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run(migration.version, migration.name, migrationChecksum(migration), appliedAt);
    // PRAGMA arguments cannot be bound parameters. `version` is a validated integer from code,
    // never user input, so interpolation is safe here.
    database.exec(`PRAGMA user_version = ${String(Math.trunc(migration.version))};`);
    database.exec('COMMIT;');
  } catch (error) {
    if (database.isTransaction) {
      database.exec('ROLLBACK;');
    }
    throw new MigrationFailedError(migration.version, fromVersion, { cause: error });
  }
}

interface StoredMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

function verifyHistory(
  database: DatabaseSync,
  migrations: readonly Migration[],
  currentVersion: number,
): void {
  const stored = readStoredHistory(database);

  if (stored.length !== currentVersion) {
    throw new MigrationHistoryError(
      `Schema version ${currentVersion} does not match ${stored.length} recorded migrations.`,
    );
  }

  stored.forEach((row, index) => {
    const expected = migrations[index];
    if (expected === undefined || row.version !== expected.version) {
      throw new MigrationHistoryError(`Unexpected migration ${row.version} in database history.`);
    }
    if (row.sha256 !== migrationChecksum(expected)) {
      throw new MigrationHistoryError(
        `Migration ${row.version} (${row.name}) differs from the version shipped with this build.`,
      );
    }
  });
}

function readStoredHistory(database: DatabaseSync): readonly StoredMigrationRow[] {
  const tableExists = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (tableExists === undefined) {
    return [];
  }
  const rows = database
    .prepare('SELECT version, name, sha256 FROM schema_migrations ORDER BY version')
    .all();
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    sha256: String(row.sha256),
  }));
}
