/**
 * Reads a whole workspace for export (PRD §5.11).
 *
 * Consistency: every query runs synchronously inside one read transaction on the reader
 * connection. In WAL mode that transaction sees one committed state of the database, and since no
 * `await` happens in between, no other statement can use the reader meanwhile. Writers are not
 * blocked: the export never holds the write lock.
 *
 * Rows are converted with the same mappers the repositories use. Staged attachments (copies in
 * progress) are not part of the workspace yet and are left out.
 */

import type { DatabaseSync } from 'node:sqlite';

import {
  DomainError,
  type NodeId,
  type TagId,
  type UtcTimestamp,
  type WorkspaceId,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotReader,
} from '@mmap/domain';

import { toAttachmentRecord } from '../repositories/sqlite-attachment-repository';
import { toKnowledgeNodeRecord } from '../repositories/sqlite-knowledge-node-repository';
import {
  toMapConnectionRecord,
  toMindMapRecord,
  toPlacementRecord,
} from '../repositories/sqlite-map-repository';
import { toRelationshipRecord } from '../repositories/sqlite-relationship-repository';
import { toRelationshipTypeRecord } from '../repositories/sqlite-relationship-type-repository';
import { toTagRecord } from '../repositories/sqlite-tag-repository';
import { toTimelineEventRecord } from '../repositories/sqlite-timeline-event-repository';
import type { SqliteConnections } from '../sqlite-connections';

export class SqliteWorkspaceSnapshotReader implements WorkspaceSnapshotReader {
  public constructor(private readonly connections: SqliteConnections) {}

  public async read(workspaceId: WorkspaceId): Promise<WorkspaceSnapshot> {
    const database = this.connections.forRead();
    // Inside an open write transaction (tests), that transaction already gives one consistent view.
    const ownTransaction = !database.isTransaction;
    if (ownTransaction) database.exec('BEGIN;');
    try {
      return readAll(database, workspaceId);
    } finally {
      if (ownTransaction) database.exec('COMMIT;');
    }
  }
}

function readAll(database: DatabaseSync, workspaceId: WorkspaceId): WorkspaceSnapshot {
  const all = (sql: string) => database.prepare(sql).all(workspaceId);
  const workspace = database
    .prepare('SELECT id, name, timezone, created_at, updated_at FROM workspaces WHERE id = ?')
    .get(workspaceId);
  if (workspace === undefined) {
    throw new DomainError('NOT_FOUND', 'The workspace was not found.');
  }
  return {
    workspace: {
      id: String(workspace.id) as WorkspaceId,
      name: String(workspace.name),
      timezone: String(workspace.timezone),
      createdAt: String(workspace.created_at) as UtcTimestamp,
      updatedAt: String(workspace.updated_at) as UtcTimestamp,
    },
    // Ordered by creation (then ID), so archives of the same data come out the same.
    nodes: all('SELECT * FROM knowledge_nodes WHERE workspace_id = ? ORDER BY created_at, id').map(
      toKnowledgeNodeRecord,
    ),
    tags: all('SELECT * FROM tags WHERE workspace_id = ? ORDER BY normalized_label').map(
      toTagRecord,
    ),
    nodeTags: all(
      'SELECT node_id, tag_id, created_at FROM node_tags WHERE workspace_id = ? ORDER BY node_id, tag_id',
    ).map((row) => ({
      nodeId: String(row.node_id) as NodeId,
      tagId: String(row.tag_id) as TagId,
      createdAt: String(row.created_at) as UtcTimestamp,
    })),
    relationshipTypes: all(
      'SELECT * FROM relationship_types WHERE workspace_id = ? ORDER BY created_at, id',
    ).map(toRelationshipTypeRecord),
    relationships: all(
      'SELECT * FROM relationships WHERE workspace_id = ? ORDER BY created_at, id',
    ).map(toRelationshipRecord),
    maps: all('SELECT * FROM mind_maps WHERE workspace_id = ? ORDER BY created_at, id').map(
      toMindMapRecord,
    ),
    placements: all(
      'SELECT * FROM map_placements WHERE workspace_id = ? ORDER BY map_id, created_at, id',
    ).map(toPlacementRecord),
    connections: all(
      'SELECT * FROM map_connections WHERE workspace_id = ? ORDER BY map_id, created_at, id',
    ).map(toMapConnectionRecord),
    timelineEvents: all(
      'SELECT * FROM timeline_events WHERE workspace_id = ? ORDER BY occurred_at, id',
    ).map(toTimelineEventRecord),
    attachments: all(
      `SELECT * FROM attachments WHERE workspace_id = ? AND state = 'committed'
       ORDER BY created_at, id`,
    ).map(toAttachmentRecord),
    graphPositions: all(
      'SELECT node_id, x, y FROM graph_node_positions WHERE workspace_id = ? ORDER BY node_id',
    ).map((row) => ({
      nodeId: String(row.node_id) as NodeId,
      x: Number(row.x),
      y: Number(row.y),
    })),
  };
}
