/**
 * SQLite implementation of `TimelineEventRepository` (PRD §5.9).
 *
 * Listing is newest first by `occurred_at` (the start of an editing session), then ID, with
 * keyset paging: the cursor holds the last row's time and ID, so pages never repeat or skip rows
 * when new events are recorded meanwhile. All filters are bound parameters.
 */

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import {
  clampPageSize,
  DomainError,
  type NodeId,
  type Page,
  type TimelineEntryRecord,
  type TimelineListQuery,
  type TimelineEventId,
  type TimelineEventRecord,
  type TimelineEventRepository,
  type TimelineEventType,
  type UtcTimestamp,
  type WorkspaceId,
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

  public async list(
    workspaceId: WorkspaceId,
    query: TimelineListQuery,
  ): Promise<Page<TimelineEntryRecord>> {
    const conditions: string[] = ['e.workspace_id = ?'];
    const parameters: SQLInputValue[] = [workspaceId];
    if (query.fromUtc !== null) {
      conditions.push('e.occurred_at >= ?');
      parameters.push(query.fromUtc);
    }
    if (query.toUtcExclusive !== null) {
      conditions.push('e.occurred_at < ?');
      parameters.push(query.toUtcExclusive);
    }
    if (query.eventTypes.length > 0) {
      conditions.push('e.event_type IN (SELECT value FROM json_each(?))');
      parameters.push(JSON.stringify(query.eventTypes));
    }
    if (query.nodeId !== null) {
      conditions.push('e.node_id = ?');
      parameters.push(query.nodeId);
    }
    if (query.tagIds.length > 0) {
      // Events of nodes that currently carry every selected tag (the library's "match all" rule).
      conditions.push(`e.node_id IN (
        SELECT node_id FROM node_tags
        WHERE workspace_id = ? AND tag_id IN (SELECT value FROM json_each(?))
        GROUP BY node_id HAVING count(DISTINCT tag_id) = ?
      )`);
      parameters.push(workspaceId, JSON.stringify(query.tagIds), query.tagIds.length);
    }
    if (query.page.cursor !== undefined) {
      const cursor = decodeCursor(query.page.cursor);
      conditions.push('(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))');
      parameters.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
    }
    const limit = clampPageSize(query.page.limit);
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT e.*, n.title AS current_node_title
         FROM timeline_events AS e
         LEFT JOIN knowledge_nodes AS n ON n.id = e.node_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY e.occurred_at DESC, e.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit + 1);
    const items = rows.slice(0, limit).map((row) => ({
      ...toRecord(row),
      currentNodeTitle: row.current_node_title === null ? null : String(row.current_node_title),
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
    };
  }

  public async findById(
    workspaceId: WorkspaceId,
    eventId: TimelineEventId,
  ): Promise<TimelineEventRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(`SELECT ${COLUMNS} FROM timeline_events WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, eventId);
    return row === undefined ? null : toRecord(row);
  }

  public async updateReflection(
    workspaceId: WorkspaceId,
    eventId: TimelineEventId,
    reflection: string | null,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare('UPDATE timeline_events SET reflection = ? WHERE workspace_id = ? AND id = ?')
      .run(reflection, workspaceId, eventId);
  }

  public async delete(workspaceId: WorkspaceId, eventId: TimelineEventId): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM timeline_events WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, eventId);
  }
}

interface Cursor {
  readonly occurredAt: string;
  readonly id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.occurredAt, cursor.id]), 'utf8').toString('base64url');
}

function decodeCursor(encoded: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { occurredAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new DomainError('VALIDATION_FAILED', 'The list position is invalid. Reload the list.');
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
