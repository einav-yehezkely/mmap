/** SQLite implementation of `TimelineEventRepository` (PRD §5.9). */

import type { SQLOutputValue } from 'node:sqlite';

import type {
  NodeId,
  TimelineEventId,
  TimelineEventRecord,
  TimelineEventRepository,
  TimelineEventType,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

const COLUMNS = `id, workspace_id, node_id, node_title_snapshot, event_type, occurred_at,
  last_activity_at, reflection, is_imported, import_origin`;

export class SqliteTimelineEventRepository implements TimelineEventRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: TimelineEventRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(`INSERT INTO timeline_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.workspaceId,
        record.nodeId,
        record.nodeTitleSnapshot,
        record.eventType,
        record.occurredAt,
        record.lastActivityAt,
        record.reflection,
        record.isImported ? 1 : 0,
        record.importOrigin,
      );
  }

  public async findLatestForNode(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    eventType: TimelineEventType,
  ): Promise<TimelineEventRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(
        `SELECT ${COLUMNS} FROM timeline_events
         WHERE workspace_id = ? AND node_id = ? AND event_type = ? AND is_imported = 0
         ORDER BY last_activity_at DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId, nodeId, eventType);
    return row === undefined ? null : toRecord(row);
  }

  public async extendSession(
    workspaceId: WorkspaceId,
    eventId: TimelineEventId,
    lastActivityAt: UtcTimestamp,
    nodeTitleSnapshot: string,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `UPDATE timeline_events SET last_activity_at = ?, node_title_snapshot = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(lastActivityAt, nodeTitleSnapshot, workspaceId, eventId);
  }
}

function toRecord(row: Record<string, SQLOutputValue>): TimelineEventRecord {
  return {
    id: String(row.id) as TimelineEventId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    nodeId: row.node_id === null ? null : (String(row.node_id) as NodeId),
    nodeTitleSnapshot: row.node_title_snapshot === null ? null : String(row.node_title_snapshot),
    eventType: String(row.event_type) as TimelineEventType,
    occurredAt: String(row.occurred_at) as UtcTimestamp,
    lastActivityAt: String(row.last_activity_at) as UtcTimestamp,
    reflection: row.reflection === null ? null : String(row.reflection),
    isImported: row.is_imported === 1,
    importOrigin: row.import_origin === null ? null : String(row.import_origin),
  };
}
