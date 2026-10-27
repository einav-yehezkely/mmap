/**
 * SQLite implementation of `WorkspaceRepository`. Queries are parameterized; row values are
 * mapped explicitly so a schema change surfaces as a type error here rather than in callers.
 */

import type { UtcTimestamp, WorkspaceId, WorkspaceRecord, WorkspaceRepository } from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async findById(workspaceId: WorkspaceId): Promise<WorkspaceRecord | null> {
    const row = this.connections
      .forRead()
      .prepare('SELECT id, name, timezone, created_at, updated_at FROM workspaces WHERE id = ?')
      .get(workspaceId);
    return row === undefined
      ? null
      : {
          id: String(row.id) as WorkspaceId,
          name: String(row.name),
          timezone: String(row.timezone),
          createdAt: String(row.created_at) as UtcTimestamp,
          updatedAt: String(row.updated_at) as UtcTimestamp,
        };
  }

  public async insert(record: WorkspaceRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        'INSERT INTO workspaces (id, name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.name, record.timezone, record.createdAt, record.updatedAt);
  }

  public async rename(
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: UtcTimestamp,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, updatedAt, workspaceId);
  }

  public async setTimezone(
    workspaceId: WorkspaceId,
    timezone: string,
    updatedAt: UtcTimestamp,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare('UPDATE workspaces SET timezone = ?, updated_at = ? WHERE id = ?')
      .run(timezone, updatedAt, workspaceId);
  }
}
