/**
 * SQLite implementation of `GraphLayoutRepository` (PRD §5.7): where the user left nodes in the
 * global graph. Stored in a table of its own (migration 3), never in map placements, so the graph
 * and every mind map keep independent layouts.
 */

import type {
  GraphLayoutRepository,
  GraphNodePosition,
  NodeId,
  UtcTimestamp,
  WorkspaceId,
} from '@mmap/domain';

import { placeholders } from '../repositories/sqlite-tag-repository';
import type { SqliteConnections } from '../sqlite-connections';

/** Keeps each statement far below SQLite's parameter limit. */
const BATCH_SIZE = 500;

export class SqliteGraphLayoutRepository implements GraphLayoutRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async positions(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
  ): Promise<readonly GraphNodePosition[]> {
    const database = this.connections.forRead();
    const positions: GraphNodePosition[] = [];
    for (let start = 0; start < nodeIds.length; start += BATCH_SIZE) {
      const batch = nodeIds.slice(start, start + BATCH_SIZE);
      const rows = database
        .prepare(
          `SELECT node_id, x, y FROM graph_node_positions
           WHERE workspace_id = ? AND node_id IN (${placeholders(batch.length)})`,
        )
        .all(workspaceId, ...batch);
      for (const row of rows) {
        positions.push({
          nodeId: String(row.node_id) as NodeId,
          x: Number(row.x),
          y: Number(row.y),
        });
      }
    }
    return positions;
  }

  public async savePositions(
    workspaceId: WorkspaceId,
    positions: readonly GraphNodePosition[],
    updatedAt: UtcTimestamp,
  ): Promise<void> {
    // INSERT … SELECT … WHERE EXISTS skips nodes deleted (or from another workspace) since the
    // renderer read them, instead of failing the whole save on the foreign key.
    const statement = this.connections.forWrite().prepare(
      `INSERT INTO graph_node_positions (workspace_id, node_id, x, y, updated_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM knowledge_nodes WHERE workspace_id = ? AND id = ?)
       ON CONFLICT (workspace_id, node_id) DO UPDATE
         SET x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
    );
    for (const position of positions) {
      statement.run(
        workspaceId,
        position.nodeId,
        position.x,
        position.y,
        updatedAt,
        workspaceId,
        position.nodeId,
      );
    }
  }
}
