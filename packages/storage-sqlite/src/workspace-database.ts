/**
 * Opens a workspace's database file for use by the application: migrates it (with a verified
 * pre-migration backup when an existing database is upgraded) and returns the connection pair.
 */

import { join } from 'node:path';

import { openDatabase } from './connection';
import { createVerifiedBackup } from './backup';
import { ALL_MIGRATIONS, migrateToLatest, type Migration, type MigrationPlan } from './migrations';
import { SqliteConnections } from './sqlite-connections';

export interface OpenWorkspaceDatabaseOptions {
  /** Directory for pre-migration backups, typically `<workspace>/recovery`. Must exist. */
  readonly backupDirectory: string;
  /** Timestamp source for backup file names; injected for tests. */
  readonly now?: () => Date;
  /** Overrides the shipped migrations; tests only. */
  readonly migrations?: readonly Migration[];
}

export interface OpenedWorkspaceDatabase {
  readonly connections: SqliteConnections;
  /** The migration plan that was executed (empty `pending` when already up to date). */
  readonly migrationPlan: MigrationPlan;
  /** Path of the pre-migration backup, when one was taken. */
  readonly preMigrationBackupPath: string | null;
}

export async function openWorkspaceDatabase(
  databasePath: string,
  options: OpenWorkspaceDatabaseOptions,
): Promise<OpenedWorkspaceDatabase> {
  const now = options.now ?? (() => new Date());
  const writer = openDatabase(databasePath);
  let preMigrationBackupPath: string | null = null;

  try {
    const migrationPlan = await migrateToLatest(writer, options.migrations ?? ALL_MIGRATIONS, {
      beforeApply: async (plan) => {
        // A brand-new database has nothing to protect. Any existing data is backed up first so
        // a failed or faulty migration always leaves a recoverable original (PRD §9).
        if (plan.currentVersion === 0) {
          return;
        }
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        preMigrationBackupPath = join(
          options.backupDirectory,
          `pre-migration-v${plan.currentVersion}-to-v${plan.targetVersion}-${stamp}.sqlite`,
        );
        await createVerifiedBackup(writer, preMigrationBackupPath);
      },
    });

    const reader = openDatabase(databasePath, { readOnly: true });
    return {
      connections: new SqliteConnections(writer, reader),
      migrationPlan,
      preMigrationBackupPath,
    };
  } catch (error) {
    writer.close();
    throw error;
  }
}
