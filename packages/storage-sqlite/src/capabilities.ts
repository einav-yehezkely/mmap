/**
 * Runtime capability probe for the embedded SQLite engine.
 *
 * Used by diagnostics and by the packaged-app smoke test to prove that the SQLite build inside
 * the installed Electron runtime has the features mmap depends on, rather than assuming that the
 * engine used in development is the one that ships.
 */

import { IN_MEMORY_DATABASE, openDatabase } from './connection';
import { ALL_MIGRATIONS, LATEST_SCHEMA_VERSION, migrateToLatest } from './migrations';

export interface StorageCapabilities {
  readonly sqliteVersion: string;
  readonly fts5Available: boolean;
  readonly latestSchemaVersion: number;
}

/** Reads the engine version and checks FTS5 using a throwaway in-memory database. */
export function probeStorageCapabilities(): StorageCapabilities {
  const database = openDatabase(IN_MEMORY_DATABASE);
  try {
    const versionRow = database.prepare('SELECT sqlite_version() AS version').get();
    return {
      sqliteVersion: String(versionRow?.version ?? 'unknown'),
      fts5Available: hasFts5(database),
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
    };
  } finally {
    database.close();
  }
}

function hasFts5(database: ReturnType<typeof openDatabase>): boolean {
  try {
    database.exec('CREATE VIRTUAL TABLE temp.fts5_probe USING fts5 (body);');
    database.exec('DROP TABLE temp.fts5_probe;');
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies every migration to a fresh database at `filePath` and runs a full-text query.
 * Throws on any failure. Used by the packaged smoke test; not part of normal startup.
 */
export async function verifySchemaOnFreshDatabase(filePath: string): Promise<void> {
  const database = openDatabase(filePath);
  try {
    await migrateToLatest(database, ALL_MIGRATIONS);
    database
      .prepare(
        "SELECT count(*) AS hits FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH 'probe'",
      )
      .get();
    const integrity = database.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed on a fresh database.');
    }
  } finally {
    database.close();
  }
}
