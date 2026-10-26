/**
 * Consistent database snapshots (PRD §9: "Create consistent backups using SQLite's backup
 * mechanism … never a raw live-database copy that ignores WAL").
 *
 * `node:sqlite`'s `backup()` uses SQLite's online backup API, which copies a transactionally
 * consistent image of the database including committed pages still in the WAL file.
 */

import { backup, DatabaseSync } from 'node:sqlite';

import { readPragmaText } from './connection';

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
