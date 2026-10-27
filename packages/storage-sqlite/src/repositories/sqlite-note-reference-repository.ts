/** SQLite implementation of `NoteReferenceRepository` (PRD §4.3, §5.4). */

import type {
  BacklinkRecord,
  NodeId,
  NoteReferenceInput,
  NoteReferenceRepository,
  WorkspaceId,
} from '@mmap/domain';

import type { SqliteConnections } from '../sqlite-connections';

export class SqliteNoteReferenceRepository implements NoteReferenceRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async replaceForSource(
    workspaceId: WorkspaceId,
    sourceNodeId: NodeId,
    references: readonly NoteReferenceInput[],
  ): Promise<void> {
    const database = this.connections.forWrite();
    database
      .prepare('DELETE FROM note_references WHERE workspace_id = ? AND source_node_id = ?')
      .run(workspaceId, sourceNodeId);
    // INSERT … SELECT … WHERE EXISTS stores a reference only when its target exists in this
    // workspace. Links to deleted or foreign nodes stay in the note JSON and render as unresolved.
    const insert = database.prepare(
      `INSERT INTO note_references
         (workspace_id, source_node_id, ordinal, target_node_id, label, context_excerpt)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM knowledge_nodes WHERE workspace_id = ? AND id = ?)`,
    );
    for (const reference of references) {
      insert.run(
        workspaceId,
        sourceNodeId,
        reference.ordinal,
        reference.targetNodeId,
        reference.label,
        reference.excerpt,
        workspaceId,
        reference.targetNodeId,
      );
    }
  }

  public async listBacklinks(
    workspaceId: WorkspaceId,
    targetNodeId: NodeId,
  ): Promise<readonly BacklinkRecord[]> {
    // One row per source note: the first occurrence's label and excerpt plus a count.
    return this.connections
      .forRead()
      .prepare(
        `SELECT r.source_node_id, n.title AS source_title, r.label, r.context_excerpt,
                counts.occurrences
         FROM note_references AS r
         JOIN (
           SELECT source_node_id, min(ordinal) AS first_ordinal, count(*) AS occurrences
           FROM note_references
           WHERE workspace_id = ? AND target_node_id = ? AND source_node_id <> target_node_id
           GROUP BY source_node_id
         ) AS counts
           ON counts.source_node_id = r.source_node_id AND counts.first_ordinal = r.ordinal
         JOIN knowledge_nodes AS n ON n.id = r.source_node_id
         ORDER BY n.title COLLATE NOCASE, n.id`,
      )
      .all(workspaceId, targetNodeId)
      .map((row) => ({
        sourceNodeId: String(row.source_node_id) as NodeId,
        sourceTitle: String(row.source_title),
        label: String(row.label),
        excerpt: String(row.context_excerpt),
        occurrences: Number(row.occurrences),
      }));
  }
}
