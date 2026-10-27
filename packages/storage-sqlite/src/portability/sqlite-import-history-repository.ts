/**
 * Import history in the `transfer_jobs` table (PRD §5.11: "Re-importing the same archive must
 * show a duplicate warning before proceeding").
 *
 * Each completed import is one `import_zip` row in state `succeeded`. The idempotency key is
 * `import:<exportId>:<jobId>`: unique per import (the table requires that), and searchable by the
 * archive's export ID.
 */

import type {
  ImportHistoryRepository,
  ImportRecord,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

const KEY_PREFIX = 'import:';

export class SqliteImportHistoryRepository implements ImportHistoryRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async findImports(
    workspaceId: WorkspaceId,
    exportId: string,
  ): Promise<readonly ImportRecord[]> {
    // `substr` instead of LIKE, so characters in the export ID can never act as wildcards.
    const prefix = `${KEY_PREFIX}${exportId}:`;
    return this.connections
      .forRead()
      .prepare(
        `SELECT created_at FROM transfer_jobs
         WHERE workspace_id = ? AND kind = 'import_zip' AND state = 'succeeded'
           AND substr(idempotency_key, 1, ?) = ?
         ORDER BY created_at`,
      )
      .all(workspaceId, prefix.length, prefix)
      .map((row) => ({ exportId, importedAt: String(row.created_at) as UtcTimestamp }));
  }

  public async recordImport(
    workspaceId: WorkspaceId,
    jobId: string,
    exportId: string,
    importedAt: UtcTimestamp,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO transfer_jobs
           (id, workspace_id, kind, state, progress, idempotency_key, created_at, updated_at)
         VALUES (?, ?, 'import_zip', 'succeeded', 1, ?, ?, ?)`,
      )
      .run(jobId, workspaceId, `${KEY_PREFIX}${exportId}:${jobId}`, importedAt, importedAt);
  }
}
