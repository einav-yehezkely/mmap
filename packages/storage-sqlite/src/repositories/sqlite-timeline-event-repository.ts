/**
 * SQLite implementation of `TimelineEventRepository` (PRD §5.9).
 *
 * Events are ordered and filtered by their effective time, `coalesce(learned_at, occurred_at)`:
 * the user's learning date when given, otherwise when the action was recorded (an index on that
 * expression exists since migration 5). Listing is newest first, then by ID, with keyset paging:
 * the cursor holds the last row's effective time and ID, so pages never repeat or skip rows when
 * events are recorded meanwhile. The window query (visual timeline) returns one time range oldest
 * first with its total; when the range holds more events than the limit, they are taken evenly
 * across the range (see `window`). All filters are bound parameters.
 */

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import {
  clampPageSize,
  DomainError,
  type NodeId,
  type Page,
  type TimelineEntryRecord,
  type TimelineEventChanges,
  type TimelineEventId,
  type TimelineEventRecord,
  type TimelineEventRepository,
  type TimelineEventType,
  type TimelineFilters,
  type TimelineListQuery,
  type TimelineWindowQuery,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

const COLUMNS = `id, workspace_id, node_id, node_title_snapshot, event_type, occurred_at,
  last_activity_at, learned_at, title, reflection, is_imported, import_origin`;

/** The time an event is placed at on the timeline. */
const EFFECTIVE_TIME = 'coalesce(e.learned_at, e.occurred_at)';

type Row = Record<string, SQLOutputValue>;

/** Time buckets a full window is divided into, so a busy moment cannot hide a quiet one. */
const WINDOW_BUCKETS = 200;

export class SqliteTimelineEventRepository implements TimelineEventRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: TimelineEventRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO timeline_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.nodeId,
        record.nodeTitleSnapshot,
        record.eventType,
        record.occurredAt,
        record.lastActivityAt,
        record.learnedAt,
        record.title,
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
    const { conditions, parameters } = filterConditions(workspaceId, query);
    if (query.fromUtc !== null) {
      conditions.push(`${EFFECTIVE_TIME} >= ?`);
      parameters.push(query.fromUtc);
    }
    if (query.toUtcExclusive !== null) {
      conditions.push(`${EFFECTIVE_TIME} < ?`);
      parameters.push(query.toUtcExclusive);
    }
    if (query.page.cursor !== undefined) {
      const cursor = decodeCursor(query.page.cursor);
      conditions.push(`(${EFFECTIVE_TIME} < ? OR (${EFFECTIVE_TIME} = ? AND e.id < ?))`);
      parameters.push(cursor.effectiveAt, cursor.effectiveAt, cursor.id);
    }
    const limit = clampPageSize(query.page.limit);
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT e.*, n.title AS current_node_title
         FROM timeline_events AS e
         LEFT JOIN knowledge_nodes AS n ON n.id = e.node_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${EFFECTIVE_TIME} DESC, e.id DESC
         LIMIT ?`,
      )
      .all(...parameters, limit + 1);
    const items = rows.slice(0, limit).map(toEntry);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ effectiveAt: last.learnedAt ?? last.occurredAt, id: last.id })
          : null,
    };
  }

  public async window(
    workspaceId: WorkspaceId,
    query: TimelineWindowQuery,
  ): Promise<{ readonly items: readonly TimelineEntryRecord[]; readonly total: number }> {
    const { conditions, parameters } = filterConditions(workspaceId, query);
    conditions.push(`${EFFECTIVE_TIME} >= ?`, `${EFFECTIVE_TIME} < ?`);
    parameters.push(query.fromUtc, query.toUtcExclusive);
    const where = conditions.join(' AND ');
    const database = this.connections.forRead();
    const total = Number(
      database
        .prepare(`SELECT count(*) AS total FROM timeline_events AS e WHERE ${where}`)
        .get(...parameters)?.total ?? 0,
    );
    // The range is split into equal time buckets, and events are taken round-robin: the latest
    // event of every bucket, then the second latest, and so on, up to the limit. A window under
    // the limit returns everything; a full one still shows every period that has activity.
    const spanDays =
      Math.max(1, Date.parse(query.toUtcExclusive) - Date.parse(query.fromUtc)) / 86_400_000;
    const items = database
      .prepare(
        `WITH ranked AS (
           SELECT e.*, n.title AS current_node_title,
             ${EFFECTIVE_TIME} AS effective_at,
             row_number() OVER (
               PARTITION BY CAST((julianday(${EFFECTIVE_TIME}) - julianday(?)) * ? AS INTEGER)
               ORDER BY ${EFFECTIVE_TIME} DESC, e.id DESC
             ) AS bucket_rank
           FROM timeline_events AS e
           LEFT JOIN knowledge_nodes AS n ON n.id = e.node_id
           WHERE ${where}
         )
         SELECT * FROM ranked
         ORDER BY bucket_rank, effective_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        query.fromUtc,
        WINDOW_BUCKETS / spanDays,
        ...parameters,
        Math.max(1, Math.trunc(query.limit)),
      )
      .map(toEntry)
      .sort((a, b) => {
        const left = a.learnedAt ?? a.occurredAt;
        const right = b.learnedAt ?? b.occurredAt;
        return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    return { items, total };
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

  public async update(
    workspaceId: WorkspaceId,
    eventId: TimelineEventId,
    changes: TimelineEventChanges,
  ): Promise<void> {
    // Only the columns the caller changes are written; column names come from this list only.
    const assignments: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (changes.title !== undefined) {
      assignments.push('title = ?');
      parameters.push(changes.title);
    }
    if (changes.reflection !== undefined) {
      assignments.push('reflection = ?');
      parameters.push(changes.reflection);
    }
    if (changes.learnedAt !== undefined) {
      assignments.push('learned_at = ?');
      parameters.push(changes.learnedAt);
    }
    if (assignments.length === 0) return;
    this.connections
      .forWrite()
      .prepare(
        `UPDATE timeline_events SET ${assignments.join(', ')} WHERE workspace_id = ? AND id = ?`,
      )
      .run(...parameters, workspaceId, eventId);
  }

  public async delete(workspaceId: WorkspaceId, eventId: TimelineEventId): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM timeline_events WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, eventId);
  }
}

/** Conditions shared by the list and the window: workspace, types, node and tags. */
function filterConditions(
  workspaceId: WorkspaceId,
  filters: TimelineFilters,
): { conditions: string[]; parameters: SQLInputValue[] } {
  const conditions: string[] = ['e.workspace_id = ?'];
  const parameters: SQLInputValue[] = [workspaceId];
  if (filters.eventTypes.length > 0) {
    conditions.push('e.event_type IN (SELECT value FROM json_each(?))');
    parameters.push(JSON.stringify(filters.eventTypes));
  }
  if (filters.nodeId !== null) {
    conditions.push('e.node_id = ?');
    parameters.push(filters.nodeId);
  }
  if (filters.tagIds.length > 0) {
    // Events of nodes that currently carry every selected tag (the library's "match all" rule).
    conditions.push(`e.node_id IN (
      SELECT node_id FROM node_tags
      WHERE workspace_id = ? AND tag_id IN (SELECT value FROM json_each(?))
      GROUP BY node_id HAVING count(DISTINCT tag_id) = ?
    )`);
    parameters.push(workspaceId, JSON.stringify(filters.tagIds), filters.tagIds.length);
  }
  return { conditions, parameters };
}

interface Cursor {
  readonly effectiveAt: string;
  readonly id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.effectiveAt, cursor.id]), 'utf8').toString('base64url');
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
      return { effectiveAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new DomainError('VALIDATION_FAILED', 'The list position is invalid. Reload the list.');
}

function toEntry(row: Row): TimelineEntryRecord {
  return {
    ...toRecord(row),
    currentNodeTitle: row.current_node_title === null ? null : String(row.current_node_title),
  };
}

function toRecord(row: Row): TimelineEventRecord {
  return {
    id: String(row.id) as TimelineEventId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    nodeId: row.node_id === null ? null : (String(row.node_id) as NodeId),
    nodeTitleSnapshot: row.node_title_snapshot === null ? null : String(row.node_title_snapshot),
    eventType: String(row.event_type) as TimelineEventType,
    occurredAt: String(row.occurred_at) as UtcTimestamp,
    lastActivityAt: String(row.last_activity_at) as UtcTimestamp,
    learnedAt: row.learned_at === null ? null : (String(row.learned_at) as UtcTimestamp),
    title: row.title === null ? null : String(row.title),
    reflection: row.reflection === null ? null : String(row.reflection),
    isImported: row.is_imported === 1,
    importOrigin: row.import_origin === null ? null : String(row.import_origin),
  };
}
