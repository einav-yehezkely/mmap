/**
 * Consistent database snapshots (PRD §9: "Create consistent backups using SQLite's backup
 * mechanism … never a raw live-database copy that ignores WAL").
 *
 * `node:sqlite`'s `backup()` uses SQLite's online backup API, which copies a transactionally
 * consistent image of the database including committed pages still in the WAL file.
 */

import { backup, DatabaseSync } from 'node:sqlite';

import { readPragmaNumber, readPragmaText } from './connection';

/**
 * Writes a consistent copy of `source` to `destinationPath` and verifies it with
 * `PRAGMA integrity_check`. The destination must not exist yet.
 *
 * @throws Error when the copy fails or the copy is not intact.
 */
export async function createVerifiedBackup(
  source: DatabaseSync,
  destinationPath: string,
): Promise<void> {
  await backup(source, destinationPath);

  // Opened directly (not via openDatabase) and read-only, so verification does not change the
  // copy's journal mode or create WAL side files next to it.
  const copy = new DatabaseSync(destinationPath, { readOnly: true, allowExtension: false });
  try {
    if (readPragmaText(copy, 'integrity_check') !== 'ok') {
      throw new Error('The database backup failed its integrity check.');
    }
  } finally {
    copy.close();
  }
}

export interface DatabaseFileContents {
  /** The workspace the database belongs to (its single `workspaces` row). */
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** `PRAGMA user_version`: the last migration applied to the file. */
  readonly schemaVersion: number;
  /** Committed attachments, whose files a snapshot must contain. */
  readonly attachments: readonly {
    readonly relativePath: string;
    readonly sha256: string;
    readonly byteSize: number;
  }[];
}

/**
 * Opens a database file read-only (no side files are created), checks its integrity and reads
 * what backups and restores need to know about it.
 *
 * @throws Error when the file cannot be opened, fails the integrity check, or does not hold
 *   exactly one workspace.
 */
export function inspectDatabaseFile(path: string): DatabaseFileContents {
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    if (readPragmaText(database, 'integrity_check') !== 'ok') {
      throw new Error('The database failed its integrity check.');
    }
    const workspaces = database.prepare('SELECT id, name FROM workspaces').all();
    if (workspaces.length !== 1) {
      throw new Error('The database does not contain exactly one workspace.');
    }
    const attachments = database
      .prepare(
        `SELECT relative_path, sha256, byte_size FROM attachments
         WHERE state = 'committed' ORDER BY relative_path`,
      )
      .all()
      .map((row) => ({
        relativePath: String(row.relative_path),
        sha256: String(row.sha256),
        byteSize: Number(row.byte_size),
      }));
    return {
      workspaceId: String(workspaces[0]!.id),
      workspaceName: String(workspaces[0]!.name),
      schemaVersion: readPragmaNumber(database, 'user_version'),
      attachments,
    };
  } finally {
    database.close();
  }
}
