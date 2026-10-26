/**
 * SQLite implementation of `KnowledgeNodeRepository`.
 *
 * Listing uses keyset pagination: the cursor holds the sort value and ID of the last row returned,
 * and the next page starts strictly after it. Unlike OFFSET paging, rows are not skipped or
 * repeated when nodes are created or edited between page requests.
 */

import {
  DomainError,
  type KnowledgeNodeRecord,
  type KnowledgeNodeRepository,
  type KnowledgeNodeSummary,
  type NodeDependents,
  type NodeId,
  type NodeListPage,
  type NodeListQuery,
  type NodeSortOrder,
  type Revision,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';

import type { SQLOutputValue } from 'node:sqlite';

import type { SqliteConnections } from '../sqlite-connections';

interface SortDefinition {
  /** SQL expression for the sort key, also used in the cursor comparison. */
  readonly keyExpression: string;
  readonly keyColumn: 'updated_at' | 'created_at' | 'title';
  readonly direction: 'ASC' | 'DESC';
}

const SORTS: Record<NodeSortOrder, SortDefinition> = {
  'updated-desc': { keyExpression: 'updated_at', keyColumn: 'updated_at', direction: 'DESC' },
  'created-desc': { keyExpression: 'created_at', keyColumn: 'created_at', direction: 'DESC' },
  // NOCASE folds ASCII only; locale-aware ordering would need ICU, which node:sqlite lacks.
  'title-asc': { keyExpression: 'title COLLATE NOCASE', keyColumn: 'title', direction: 'ASC' },
};

interface Cursor {
  readonly key: string;
  readonly id: string;
}

export class SqliteKnowledgeNodeRepository implements KnowledgeNodeRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async findById(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
  ): Promise<KnowledgeNodeRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(
        `SELECT id, workspace_id, title, summary, note_json, note_schema_version, note_plain_text,
                revision, created_at, updated_at
         FROM knowledge_nodes WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, nodeId);
    return row === undefined ? null : toRecord(row);
  }

  public async list(workspaceId: WorkspaceId, query: NodeListQuery): Promise<NodeListPage> {
    const sort = SORTS[query.sort];
    const cursor = query.page.cursor === undefined ? null : decodeCursor(query.page.cursor);
    const comparison = sort.direction === 'DESC' ? '<' : '>';
    const database = this.connections.forRead();

    // Fetch one extra row to learn whether another page exists.
    const rows = database
      .prepare(
        `SELECT id, title, created_at, updated_at FROM knowledge_nodes
         WHERE workspace_id = ?
           ${cursor === null ? '' : `AND (${sort.keyExpression} ${comparison} ? OR (${sort.keyExpression} = ? AND id ${comparison} ?))`}
         ORDER BY ${sort.keyExpression} ${sort.direction}, id ${sort.direction}
         LIMIT ?`,
      )
      .all(
        workspaceId,
        ...(cursor === null ? [] : [cursor.key, cursor.key, cursor.id]),
        query.page.limit + 1,
      );

    const pageRows = rows.slice(0, query.page.limit);
    const last = pageRows.at(-1);
    const total = database
      .prepare('SELECT count(*) AS total FROM knowledge_nodes WHERE workspace_id = ?')
      .get(workspaceId);

    return {
      items: pageRows.map(toSummary),
      nextCursor:
        rows.length > query.page.limit && last !== undefined
          ? encodeCursor({ key: String(last[sort.keyColumn]), id: String(last.id) })
          : null,
      totalCount: Number(total?.total ?? 0),
    };
  }

  public async insert(record: KnowledgeNodeRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO knowledge_nodes
           (id, workspace_id, title, summary, note_json, note_schema_version, note_plain_text,
            revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.title,
        record.summary,
        record.noteJson,
        record.noteSchemaVersion,
        record.notePlainText,
        record.revision,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async update(record: KnowledgeNodeRecord, expectedRevision: Revision): Promise<boolean> {
    const result = this.connections
      .forWrite()
      .prepare(
        `UPDATE knowledge_nodes
         SET title = ?, summary = ?, note_json = ?, note_schema_version = ?, note_plain_text = ?,
             revision = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .run(
        record.title,
        record.summary,
        record.noteJson,
        record.noteSchemaVersion,
        record.notePlainText,
        record.revision,
        record.updatedAt,
        record.workspaceId,
        record.id,
        expectedRevision,
      );
    return Number(result.changes) === 1;
  }

  public async countDependents(workspaceId: WorkspaceId, nodeId: NodeId): Promise<NodeDependents> {
    const database = this.connections.forRead();
    const count = (sql: string, ...parameters: string[]): number =>
      Number(database.prepare(sql).get(...parameters)?.total ?? 0);

    return {
      relationships: count(
        `SELECT count(*) AS total FROM relationships
         WHERE workspace_id = ? AND (source_node_id = ? OR target_node_id = ?)`,
        workspaceId,
        nodeId,
        nodeId,
      ),
      referencingNotes: count(
        `SELECT count(DISTINCT source_node_id) AS total FROM note_references
         WHERE workspace_id = ? AND target_node_id = ? AND source_node_id <> ?`,
        workspaceId,
        nodeId,
        nodeId,
      ),
      mapPlacements: count(
        'SELECT count(*) AS total FROM map_placements WHERE workspace_id = ? AND node_id = ?',
        workspaceId,
        nodeId,
      ),
      attachments: count(
        'SELECT count(*) AS total FROM attachments WHERE workspace_id = ? AND node_id = ?',
        workspaceId,
        nodeId,
      ),
    };
  }

  public async delete(workspaceId: WorkspaceId, nodeId: NodeId): Promise<void> {
    const database = this.connections.forWrite();
    // Promote children of this node's placements to the deleted placement's parent (or to roots),
    // because the hierarchy foreign key deliberately refuses to orphan them (see migration 1).
    database
      .prepare(
        `UPDATE map_placements AS child
         SET parent_placement_id = (
           SELECT parent.parent_placement_id FROM map_placements AS parent
           WHERE parent.id = child.parent_placement_id
         )
         WHERE child.parent_placement_id IN (
           SELECT id FROM map_placements WHERE workspace_id = ? AND node_id = ?
         )`,
      )
      .run(workspaceId, nodeId);
    // Relationships, placements, references from this node and attachment rows cascade.
    database
      .prepare('DELETE FROM knowledge_nodes WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, nodeId);
  }
}

type Row = Record<string, SQLOutputValue>;

function toRecord(row: Row): KnowledgeNodeRecord {
  return {
    id: String(row.id) as NodeId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    title: String(row.title),
    summary: row.summary === null ? null : String(row.summary),
    noteJson: String(row.note_json),
    noteSchemaVersion: Number(row.note_schema_version),
    notePlainText: String(row.note_plain_text),
    revision: Number(row.revision),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}

function toSummary(row: Row): KnowledgeNodeSummary {
  return {
    id: String(row.id) as NodeId,
    title: String(row.title),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.id]), 'utf8').toString('base64url');
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
      return { key: parsed[0], id: parsed[1] };
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new DomainError('VALIDATION_FAILED', 'The list position is invalid. Reload the list.');
}
