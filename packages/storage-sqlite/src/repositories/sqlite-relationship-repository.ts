/** SQLite implementation of `RelationshipRepository` (PRD §4.2). */

import type {
  NodeId,
  RelationshipDetails,
  RelationshipDirectionality,
  RelationshipId,
  RelationshipRecord,
  RelationshipRepository,
  RelationshipTypeId,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';
import type { SQLOutputValue } from 'node:sqlite';

import type { SqliteConnections } from '../sqlite-connections';

const COLUMNS = `r.id, r.workspace_id, r.source_node_id, r.target_node_id, r.type_id,
  r.directionality, r.description, r.created_at, r.updated_at`;

export class SqliteRelationshipRepository implements RelationshipRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: RelationshipRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO relationships
           (id, workspace_id, source_node_id, target_node_id, type_id, directionality,
            description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.sourceNodeId,
        record.targetNodeId,
        record.typeId,
        record.directionality,
        record.description,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async findById(
    workspaceId: WorkspaceId,
    relationshipId: RelationshipId,
  ): Promise<RelationshipRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(`SELECT ${COLUMNS} FROM relationships AS r WHERE r.workspace_id = ? AND r.id = ?`)
      .get(workspaceId, relationshipId);
    return row === undefined ? null : toRelationshipRecord(row);
  }

  public async findByEndpoints(
    workspaceId: WorkspaceId,
    sourceNodeId: NodeId,
    targetNodeId: NodeId,
    typeId: RelationshipTypeId,
  ): Promise<RelationshipRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(
        `SELECT ${COLUMNS} FROM relationships AS r
         WHERE r.workspace_id = ? AND r.source_node_id = ? AND r.target_node_id = ? AND r.type_id = ?`,
      )
      .get(workspaceId, sourceNodeId, targetNodeId, typeId);
    return row === undefined ? null : toRelationshipRecord(row);
  }

  public async update(record: RelationshipRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `UPDATE relationships
         SET source_node_id = ?, target_node_id = ?, type_id = ?, directionality = ?,
             description = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        record.sourceNodeId,
        record.targetNodeId,
        record.typeId,
        record.directionality,
        record.description,
        record.updatedAt,
        record.workspaceId,
        record.id,
      );
  }

  public async delete(workspaceId: WorkspaceId, relationshipId: RelationshipId): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM relationships WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, relationshipId);
  }

  public async listForNode(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
  ): Promise<readonly RelationshipDetails[]> {
    // One query with the labels needed for display; both directions of the node.
    return this.connections
      .forRead()
      .prepare(
        `SELECT ${COLUMNS}, t.label AS type_label,
                s.title AS source_title, g.title AS target_title
         FROM relationships AS r
         JOIN relationship_types AS t ON t.id = r.type_id
         JOIN knowledge_nodes AS s ON s.id = r.source_node_id
         JOIN knowledge_nodes AS g ON g.id = r.target_node_id
         WHERE r.workspace_id = ? AND (r.source_node_id = ? OR r.target_node_id = ?)
         ORDER BY t.normalized_label,
                  CASE WHEN r.source_node_id = ? THEN g.title ELSE s.title END COLLATE NOCASE,
                  r.id`,
      )
      .all(workspaceId, nodeId, nodeId, nodeId)
      .map((row) => ({
        ...toRelationshipRecord(row),
        typeLabel: String(row.type_label),
        sourceTitle: String(row.source_title),
        targetTitle: String(row.target_title),
      }));
  }
}

export function toRelationshipRecord(row: Record<string, SQLOutputValue>): RelationshipRecord {
  return {
    id: String(row.id) as RelationshipId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    sourceNodeId: String(row.source_node_id) as NodeId,
    targetNodeId: String(row.target_node_id) as NodeId,
    typeId: String(row.type_id) as RelationshipTypeId,
    directionality: String(row.directionality) as RelationshipDirectionality,
    description: row.description === null ? null : String(row.description),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}
