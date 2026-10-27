/** SQLite implementation of `TagRepository` (PRD §5.8). */

import type {
  NodeId,
  TagId,
  TagRecord,
  TagRepository,
  TagSummary,
  TagWithUsage,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';
import type { SQLOutputValue } from 'node:sqlite';

import type { SqliteConnections } from '../sqlite-connections';

export class SqliteTagRepository implements TagRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async listWithUsage(workspaceId: WorkspaceId): Promise<readonly TagWithUsage[]> {
    return this.connections
      .forRead()
      .prepare(
        `SELECT tags.id, tags.display_label, count(node_tags.node_id) AS node_count
         FROM tags LEFT JOIN node_tags ON node_tags.tag_id = tags.id
         WHERE tags.workspace_id = ?
         GROUP BY tags.id
         ORDER BY tags.normalized_label`,
      )
      .all(workspaceId)
      .map((row) => ({
        id: String(row.id) as TagId,
        label: String(row.display_label),
        nodeCount: Number(row.node_count),
      }));
  }

  public async findById(workspaceId: WorkspaceId, tagId: TagId): Promise<TagRecord | null> {
    const row = this.connections
      .forRead()
      .prepare('SELECT * FROM tags WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, tagId);
    return row === undefined ? null : toRecord(row);
  }

  public async findByNormalizedLabel(
    workspaceId: WorkspaceId,
    normalizedLabel: string,
  ): Promise<TagRecord | null> {
    const row = this.connections
      .forRead()
      .prepare('SELECT * FROM tags WHERE workspace_id = ? AND normalized_label = ?')
      .get(workspaceId, normalizedLabel);
    return row === undefined ? null : toRecord(row);
  }

  public async insert(record: TagRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO tags (id, workspace_id, display_label, normalized_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.displayLabel,
        record.normalizedLabel,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async rename(
    workspaceId: WorkspaceId,
    tagId: TagId,
    displayLabel: string,
    normalizedLabel: string,
    updatedAt: UtcTimestamp,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `UPDATE tags SET display_label = ?, normalized_label = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(displayLabel, normalizedLabel, updatedAt, workspaceId, tagId);
  }

  public async delete(workspaceId: WorkspaceId, tagId: TagId): Promise<void> {
    // node_tags rows cascade; knowledge nodes are untouched.
    this.connections
      .forWrite()
      .prepare('DELETE FROM tags WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, tagId);
  }

  public async listForNodes(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
  ): Promise<ReadonlyMap<NodeId, readonly TagSummary[]>> {
    const result = new Map<NodeId, TagSummary[]>(nodeIds.map((id) => [id, []]));
    if (nodeIds.length === 0) {
      return result;
    }
    // One query for the whole page instead of one per node. Node IDs are bound parameters; only
    // the number of placeholders is generated.
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT node_tags.node_id, tags.id, tags.display_label
         FROM node_tags JOIN tags ON tags.id = node_tags.tag_id
         WHERE node_tags.workspace_id = ? AND node_tags.node_id IN (${placeholders(nodeIds.length)})
         ORDER BY tags.normalized_label`,
      )
      .all(workspaceId, ...nodeIds);
    for (const row of rows) {
      result.get(String(row.node_id) as NodeId)?.push({
        id: String(row.id) as TagId,
        label: String(row.display_label),
      });
    }
    return result;
  }

  public async attach(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    tagId: TagId,
    createdAt: UtcTimestamp,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO node_tags (workspace_id, node_id, tag_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (node_id, tag_id) DO NOTHING`,
      )
      .run(workspaceId, nodeId, tagId, createdAt);
  }

  public async detach(workspaceId: WorkspaceId, nodeId: NodeId, tagId: TagId): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM node_tags WHERE workspace_id = ? AND node_id = ? AND tag_id = ?')
      .run(workspaceId, nodeId, tagId);
  }
}

/** `?, ?, ?` for `count` bound parameters. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function toRecord(row: Record<string, SQLOutputValue>): TagRecord {
  return {
    id: String(row.id) as TagId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    displayLabel: String(row.display_label),
    normalizedLabel: String(row.normalized_label),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}
