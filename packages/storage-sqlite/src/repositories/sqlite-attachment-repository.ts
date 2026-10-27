/** SQLite implementation of `AttachmentRepository` (PRD §5.10). */

import type {
  AttachmentId,
  AttachmentRecord,
  AttachmentRepository,
  NodeId,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';
import type { SQLOutputValue } from 'node:sqlite';

import type { SqliteConnections } from '../sqlite-connections';

const COLUMNS = `id, workspace_id, node_id, relative_path, original_name, mime_type, byte_size,
  sha256, state, created_at, updated_at`;

export class SqliteAttachmentRepository implements AttachmentRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: AttachmentRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(`INSERT INTO attachments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.workspaceId,
        record.nodeId,
        record.relativePath,
        record.originalName,
        record.mimeType,
        record.byteSize,
        record.sha256,
        record.state,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async findById(
    workspaceId: WorkspaceId,
    attachmentId: AttachmentId,
  ): Promise<AttachmentRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(`SELECT ${COLUMNS} FROM attachments WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, attachmentId);
    return row === undefined ? null : toRecord(row);
  }

  public async listForNode(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
  ): Promise<readonly AttachmentRecord[]> {
    return this.connections
      .forRead()
      .prepare(
        `SELECT ${COLUMNS} FROM attachments
         WHERE workspace_id = ? AND node_id = ? AND state = 'committed'
         ORDER BY created_at, id`,
      )
      .all(workspaceId, nodeId)
      .map(toRecord);
  }

  public async delete(workspaceId: WorkspaceId, attachmentId: AttachmentId): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM attachments WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, attachmentId);
  }

  public async listAllRelativePaths(workspaceId: WorkspaceId): Promise<readonly string[]> {
    return this.connections
      .forRead()
      .prepare('SELECT relative_path FROM attachments WHERE workspace_id = ?')
      .all(workspaceId)
      .map((row) => String(row.relative_path));
  }
}

function toRecord(row: Record<string, SQLOutputValue>): AttachmentRecord {
  return {
    id: String(row.id) as AttachmentId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    nodeId: String(row.node_id) as NodeId,
    relativePath: String(row.relative_path),
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    state: row.state === 'staged' ? 'staged' : 'committed',
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}
