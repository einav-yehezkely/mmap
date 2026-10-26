/** SQLite implementation of `RelationshipTypeRepository`. */

import type {
  RelationshipDirectionality,
  RelationshipTypeId,
  RelationshipTypeRecord,
  RelationshipTypeRepository,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

export class SqliteRelationshipTypeRepository implements RelationshipTypeRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: RelationshipTypeRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO relationship_types
           (id, workspace_id, label, normalized_label, directionality, is_archived, is_builtin,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.label,
        record.normalizedLabel,
        record.directionality,
        record.isArchived ? 1 : 0,
        record.isBuiltin ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async listByWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<readonly RelationshipTypeRecord[]> {
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT id, workspace_id, label, normalized_label, directionality, is_archived, is_builtin,
                created_at, updated_at
         FROM relationship_types WHERE workspace_id = ? ORDER BY normalized_label`,
      )
      .all(workspaceId);
    return rows.map((row) => ({
      id: String(row.id) as RelationshipTypeId,
      workspaceId: String(row.workspace_id) as WorkspaceId,
      label: String(row.label),
      normalizedLabel: String(row.normalized_label),
      directionality: String(row.directionality) as RelationshipDirectionality,
      isArchived: row.is_archived === 1,
      isBuiltin: row.is_builtin === 1,
      createdAt: String(row.created_at) as UtcTimestamp,
      updatedAt: String(row.updated_at) as UtcTimestamp,
    }));
  }
}
