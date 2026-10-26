import { readFileSync, rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, readPragmaNumber, readPragmaText } from '../connection';
import { createTemporaryDatabaseFile } from '../test-support/temporary-database';
import {
  ALL_MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  MigrationFailedError,
  MigrationHistoryError,
  migrateToLatest,
  SchemaTooNewError,
  type Migration,
} from './index';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function openFreshDatabase() {
  const { directory, filePath } = createTemporaryDatabaseFile();
  const database = openDatabase(filePath);
  cleanups.push(() => {
    if (database.isOpen) {
      database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, filePath };
}

describe('openDatabase', () => {
  it('enables foreign keys, WAL, full sync and an untrusted schema', () => {
    const { database } = openFreshDatabase();

    expect(readPragmaNumber(database, 'foreign_keys')).toBe(1);
    expect(readPragmaText(database, 'journal_mode')).toBe('wal');
    // 2 = FULL
    expect(readPragmaNumber(database, 'synchronous')).toBe(2);
    expect(readPragmaNumber(database, 'trusted_schema')).toBe(0);
  });
});

describe('migrateToLatest', () => {
  it('migrates a fresh database to the latest version', async () => {
    const { database } = openFreshDatabase();

    const plan = await migrateToLatest(database, ALL_MIGRATIONS);

    expect(plan).toMatchObject({ currentVersion: 0, targetVersion: LATEST_SCHEMA_VERSION });
    expect(readPragmaNumber(database, 'user_version')).toBe(LATEST_SCHEMA_VERSION);
    expect(readPragmaText(database, 'integrity_check')).toBe('ok');
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('is idempotent and does not call the backup hook when nothing is pending', async () => {
    const { database } = openFreshDatabase();
    await migrateToLatest(database, ALL_MIGRATIONS);
    let hookCalls = 0;

    const plan = await migrateToLatest(database, ALL_MIGRATIONS, {
      beforeApply: async () => {
        hookCalls += 1;
      },
    });

    expect(plan.pending).toHaveLength(0);
    expect(hookCalls).toBe(0);
  });

  it('calls the pre-migration backup hook before applying anything', async () => {
    const { database } = openFreshDatabase();
    const versionsSeenByHook: number[] = [];

    await migrateToLatest(database, ALL_MIGRATIONS, {
      beforeApply: async () => {
        versionsSeenByHook.push(readPragmaNumber(database, 'user_version'));
      },
    });

    expect(versionsSeenByHook).toEqual([0]);
  });

  it('applies nothing when the backup hook fails', async () => {
    const { database } = openFreshDatabase();

    await expect(
      migrateToLatest(database, ALL_MIGRATIONS, {
        beforeApply: () => Promise.reject(new Error('backup destination unavailable')),
      }),
    ).rejects.toThrow('backup destination unavailable');

    expect(readPragmaNumber(database, 'user_version')).toBe(0);
  });

  it('refuses a newer schema without modifying the file', async () => {
    const { database, filePath } = openFreshDatabase();
    await migrateToLatest(database, ALL_MIGRATIONS);
    database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 5};`);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const bytesBefore = readFileSync(filePath);

    await expect(migrateToLatest(database, ALL_MIGRATIONS)).rejects.toBeInstanceOf(
      SchemaTooNewError,
    );

    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    expect(readFileSync(filePath).equals(bytesBefore)).toBe(true);
  });

  it('rolls back a failing migration and keeps the previous version', async () => {
    const { database } = openFreshDatabase();
    await migrateToLatest(database, ALL_MIGRATIONS);
    const broken: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      name: 'broken',
      // The first statement succeeds, the second fails: the first must be rolled back too.
      sql: 'CREATE TABLE half_applied (id INTEGER) STRICT; INSERT INTO missing_table VALUES (1);',
    };

    const failure = migrateToLatest(database, [...ALL_MIGRATIONS, broken]);

    await expect(failure).rejects.toBeInstanceOf(MigrationFailedError);
    await expect(failure).rejects.toMatchObject({
      failedVersion: broken.version,
      fromVersion: LATEST_SCHEMA_VERSION,
    });
    expect(readPragmaNumber(database, 'user_version')).toBe(LATEST_SCHEMA_VERSION);
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE name = 'half_applied'").get(),
    ).toBeUndefined();
    expect(database.isTransaction).toBe(false);
  });

  it('detects a released migration that was edited afterwards', async () => {
    const { database } = openFreshDatabase();
    await migrateToLatest(database, ALL_MIGRATIONS);
    const edited = ALL_MIGRATIONS.map((migration, index) =>
      index === 0 ? { ...migration, sql: `${migration.sql}\n-- edited` } : migration,
    );

    await expect(migrateToLatest(database, edited)).rejects.toBeInstanceOf(MigrationHistoryError);
  });

  it('rejects non-sequential migration lists', async () => {
    const { database } = openFreshDatabase();
    const gapped: Migration[] = [{ version: 2, name: 'gap', sql: 'SELECT 1;' }];

    await expect(migrateToLatest(database, gapped)).rejects.toThrow(/sequentially/);
  });
});
