/** SQLite implementation of `TimelineEventRepository` (PRD §5.9). */

import type { TimelineEventRecord, TimelineEventRepository } from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

export class SqliteTimelineEventRepository implements TimelineEventRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async insert(record: TimelineEventRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO timeline_events
           (id, workspace_id, node_id, node_title_snapshot, event_type, occurred_at,
            last_activity_at, reflection, is_imported, import_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
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
}
