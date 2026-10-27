/** SQLite implementation of `RelationshipTypeRepository`. */

import type {
  RelationshipDirectionality,
  RelationshipTypeId,
  RelationshipTypeRecord,
  RelationshipTypeRepository,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';
import type { SQLOutputValue } from 'node:sqlite';

import type { SqliteConnections } from '../sqlite-connections';

const COLUMNS = `id, workspace_id, label, normalized_label, directionality, is_archived, is_builtin,
  created_at, updated_at`;

export class SqliteRelationshipTypeRepository implements RelationshipTypeRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: RelationshipTypeRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(`INSERT INTO relationship_types (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
    return this.connections
      .forRead()
      .prepare(
        `SELECT ${COLUMNS} FROM relationship_types WHERE workspace_id = ? ORDER BY normalized_label`,
      )
      .all(workspaceId)
      .map(toRelationshipTypeRecord);
  }

  public async findById(
    workspaceId: WorkspaceId,
    typeId: RelationshipTypeId,
  ): Promise<RelationshipTypeRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(`SELECT ${COLUMNS} FROM relationship_types WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, typeId);
    return row === undefined ? null : toRelationshipTypeRecord(row);
  }

  public async findByNormalizedLabel(
    workspaceId: WorkspaceId,
    normalizedLabel: string,
  ): Promise<RelationshipTypeRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(
        `SELECT ${COLUMNS} FROM relationship_types WHERE workspace_id = ? AND normalized_label = ?`,
      )
      .get(workspaceId, normalizedLabel);
    return row === undefined ? null : toRelationshipTypeRecord(row);
  }

  public async update(record: RelationshipTypeRecord): Promise<void> {
    // Changing directionality while relationships reference the type fails with a foreign key
    // error (see migration 1, design note 2); the service checks first to give a clear message.
    this.connections
      .forWrite()
      .prepare(
        `UPDATE relationship_types
         SET label = ?, normalized_label = ?, directionality = ?, is_archived = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        record.label,
        record.normalizedLabel,
        record.directionality,
        record.isArchived ? 1 : 0,
        record.updatedAt,
        record.workspaceId,
        record.id,
      );
  }

  public async countUsage(
    workspaceId: WorkspaceId,
  ): Promise<ReadonlyMap<RelationshipTypeId, number>> {
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT type_id, count(*) AS usage FROM relationships WHERE workspace_id = ?
         GROUP BY type_id`,
      )
      .all(workspaceId);
    return new Map(
      rows.map((row) => [String(row.type_id) as RelationshipTypeId, Number(row.usage)]),
    );
  }
}

export function toRelationshipTypeRecord(
  row: Record<string, SQLOutputValue>,
): RelationshipTypeRecord {
  return {
    id: String(row.id) as RelationshipTypeId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    label: String(row.label),
    normalizedLabel: String(row.normalized_label),
    directionality: String(row.directionality) as RelationshipDirectionality,
    isArchived: row.is_archived === 1,
    isBuiltin: row.is_builtin === 1,
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}
