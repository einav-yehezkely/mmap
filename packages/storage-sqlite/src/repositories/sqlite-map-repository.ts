/** SQLite implementation of `MapRepository` (PRD §4.4, §5.6). */

import {
  PLACEMENT_COLORS,
  type MapConnectionId,
  type MapConnectionRecord,
  type MapConnectionWithRelationship,
  type MapOfNode,
  type MapRelationship,
  type RelationshipDirectionality,
  type MapId,
  type MapMode,
  type MapRepository,
  type MapViewport,
  type MindMapRecord,
  type MindMapSummary,
  type NodeId,
  type PlacementColor,
  type PlacementId,
  type PlacementRecord,
  type PlacementStyle,
  type PlacementWithNode,
  type RelationshipId,
  type Revision,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import type { SQLOutputValue } from 'node:sqlite';

import type { SqliteConnections } from '../sqlite-connections';

type Row = Record<string, SQLOutputValue>;

const DEFAULT_VIEWPORT: MapViewport = { x: 0, y: 0, zoom: 1 };

export class SqliteMapRepository implements MapRepository {
  public constructor(private readonly connections: SqliteConnections) {}

  public async listMaps(workspaceId: WorkspaceId): Promise<readonly MindMapSummary[]> {
    return this.connections
      .forRead()
      .prepare(
        `SELECT m.id, m.title, m.mode, m.revision, m.updated_at,
                (SELECT count(*) FROM map_placements AS p WHERE p.map_id = m.id) AS placement_count
         FROM mind_maps AS m
         WHERE m.workspace_id = ?
         ORDER BY m.updated_at DESC, m.id`,
      )
      .all(workspaceId)
      .map((row) => ({
        id: String(row.id) as MapId,
        title: String(row.title),
        mode: String(row.mode) as MapMode,
        revision: Number(row.revision),
        placementCount: Number(row.placement_count),
        updatedAt: String(row.updated_at) as UtcTimestamp,
      }));
  }

  public async findMap(workspaceId: WorkspaceId, mapId: MapId): Promise<MindMapRecord | null> {
    const row = this.connections
      .forRead()
      .prepare(
        `SELECT id, workspace_id, title, mode, viewport_json, revision, created_at, updated_at
         FROM mind_maps WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, mapId);
    return row === undefined ? null : toMindMapRecord(row);
  }

  public async insertMap(record: MindMapRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO mind_maps
           (id, workspace_id, title, mode, viewport_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.title,
        record.mode,
        JSON.stringify(record.viewport),
        record.revision,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async updateMap(record: MindMapRecord, expectedRevision: Revision): Promise<boolean> {
    const result = this.connections
      .forWrite()
      .prepare(
        `UPDATE mind_maps SET title = ?, mode = ?, viewport_json = ?, revision = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .run(
        record.title,
        record.mode,
        JSON.stringify(record.viewport),
        record.revision,
        record.updatedAt,
        record.workspaceId,
        record.id,
        expectedRevision,
      );
    return Number(result.changes) === 1;
  }

  public async updateViewport(
    workspaceId: WorkspaceId,
    mapId: MapId,
    viewport: MapViewport,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare('UPDATE mind_maps SET viewport_json = ? WHERE workspace_id = ? AND id = ?')
      .run(JSON.stringify(viewport), workspaceId, mapId);
  }

  public async deleteMap(workspaceId: WorkspaceId, mapId: MapId): Promise<void> {
    // Placements and connectors cascade; the parent reference among placements is satisfied
    // because the whole map is removed in one statement (see migration 1, design note 4).
    this.connections
      .forWrite()
      .prepare('DELETE FROM mind_maps WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, mapId);
  }

  public async listPlacements(
    workspaceId: WorkspaceId,
    mapId: MapId,
  ): Promise<readonly PlacementWithNode[]> {
    return this.connections
      .forRead()
      .prepare(
        `SELECT p.*, n.title AS node_title
         FROM map_placements AS p
         JOIN knowledge_nodes AS n ON n.id = p.node_id
         WHERE p.workspace_id = ? AND p.map_id = ?
         ORDER BY p.sibling_order, p.id`,
      )
      .all(workspaceId, mapId)
      .map((row) => ({ ...toPlacementRecord(row), nodeTitle: String(row.node_title) }));
  }

  public async insertPlacement(record: PlacementRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO map_placements
           (id, workspace_id, map_id, node_id, freeform_x, freeform_y, parent_placement_id,
            sibling_order, is_collapsed, style_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.mapId,
        record.nodeId,
        record.x,
        record.y,
        record.parentPlacementId,
        record.siblingOrder,
        record.isCollapsed ? 1 : 0,
        JSON.stringify(record.style),
        record.createdAt,
        record.updatedAt,
      );
  }

  public async updatePlacements(records: readonly PlacementRecord[]): Promise<void> {
    const statement = this.connections.forWrite().prepare(
      `UPDATE map_placements
       SET freeform_x = ?, freeform_y = ?, parent_placement_id = ?, sibling_order = ?,
           is_collapsed = ?, style_json = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    );
    for (const record of records) {
      statement.run(
        record.x,
        record.y,
        record.parentPlacementId,
        record.siblingOrder,
        record.isCollapsed ? 1 : 0,
        JSON.stringify(record.style),
        record.updatedAt,
        record.workspaceId,
        record.id,
      );
    }
  }

  public async deletePlacement(workspaceId: WorkspaceId, placementId: PlacementId): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM map_placements WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, placementId);
  }

  public async listConnections(
    workspaceId: WorkspaceId,
    mapId: MapId,
  ): Promise<readonly MapConnectionWithRelationship[]> {
    return this.connections
      .forRead()
      .prepare(
        `SELECT c.*, t.label AS relationship_type_label
         FROM map_connections AS c
         LEFT JOIN relationships AS r ON r.id = c.relationship_id
         LEFT JOIN relationship_types AS t ON t.id = r.type_id
         WHERE c.workspace_id = ? AND c.map_id = ?
         ORDER BY c.created_at, c.id`,
      )
      .all(workspaceId, mapId)
      .map((row) => ({
        ...toMapConnectionRecord(row),
        relationshipTypeLabel:
          row.relationship_type_label === null ? null : String(row.relationship_type_label),
      }));
  }

  public async listMapsForNode(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
  ): Promise<readonly MapOfNode[]> {
    return this.connections
      .forRead()
      .prepare(
        `SELECT m.id, m.title, m.mode
         FROM map_placements AS p
         JOIN mind_maps AS m ON m.id = p.map_id
         WHERE p.workspace_id = ? AND p.node_id = ?
         ORDER BY m.title COLLATE NOCASE, m.id`,
      )
      .all(workspaceId, nodeId)
      .map((row) => ({
        id: String(row.id) as MapId,
        title: String(row.title),
        mode: String(row.mode) as MapMode,
      }));
  }

  public async listRelationships(
    workspaceId: WorkspaceId,
    mapId: MapId,
  ): Promise<readonly MapRelationship[]> {
    // Both endpoints must be placed on this map; a node appears at most once per map, so each
    // relationship is returned once.
    return this.connections
      .forRead()
      .prepare(
        `SELECT r.id, r.source_node_id, r.target_node_id, r.directionality, t.label AS type_label
         FROM relationships AS r
         JOIN relationship_types AS t ON t.id = r.type_id
         JOIN map_placements AS source ON source.map_id = ? AND source.node_id = r.source_node_id
         JOIN map_placements AS target ON target.map_id = ? AND target.node_id = r.target_node_id
         WHERE r.workspace_id = ?
         ORDER BY r.created_at, r.id`,
      )
      .all(mapId, mapId, workspaceId)
      .map((row) => ({
        id: String(row.id) as RelationshipId,
        sourceNodeId: String(row.source_node_id) as NodeId,
        targetNodeId: String(row.target_node_id) as NodeId,
        typeLabel: String(row.type_label),
        directionality: String(row.directionality) as RelationshipDirectionality,
      }));
  }

  public async insertConnection(record: MapConnectionRecord): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        `INSERT INTO map_connections
           (id, workspace_id, map_id, source_placement_id, target_placement_id, relationship_id,
            label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.mapId,
        record.sourcePlacementId,
        record.targetPlacementId,
        record.relationshipId,
        record.label,
        record.createdAt,
        record.updatedAt,
      );
  }

  public async deleteConnection(
    workspaceId: WorkspaceId,
    connectionId: MapConnectionId,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare('DELETE FROM map_connections WHERE workspace_id = ? AND id = ?')
      .run(workspaceId, connectionId);
  }

  public async updateConnectionLabel(
    workspaceId: WorkspaceId,
    connectionId: MapConnectionId,
    label: string | null,
    updatedAt: string,
  ): Promise<void> {
    this.connections
      .forWrite()
      .prepare(
        'UPDATE map_connections SET label = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
      )
      .run(label, updatedAt, workspaceId, connectionId);
  }
}

export function toMindMapRecord(row: Row): MindMapRecord {
  return {
    id: String(row.id) as MapId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    title: String(row.title),
    mode: String(row.mode) as MapMode,
    viewport: parseViewport(String(row.viewport_json)),
    revision: Number(row.revision),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}

export function toPlacementRecord(row: Row): PlacementRecord {
  return {
    id: String(row.id) as PlacementId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    mapId: String(row.map_id) as MapId,
    nodeId: String(row.node_id) as NodeId,
    x: Number(row.freeform_x),
    y: Number(row.freeform_y),
    parentPlacementId:
      row.parent_placement_id === null ? null : (String(row.parent_placement_id) as PlacementId),
    siblingOrder: Number(row.sibling_order),
    isCollapsed: row.is_collapsed === 1,
    style: parseStyle(String(row.style_json)),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}

export function toMapConnectionRecord(row: Row): MapConnectionRecord {
  return {
    id: String(row.id) as MapConnectionId,
    workspaceId: String(row.workspace_id) as WorkspaceId,
    mapId: String(row.map_id) as MapId,
    sourcePlacementId: String(row.source_placement_id) as PlacementId,
    targetPlacementId: String(row.target_placement_id) as PlacementId,
    relationshipId:
      row.relationship_id === null ? null : (String(row.relationship_id) as RelationshipId),
    label: row.label === null ? null : String(row.label),
    createdAt: String(row.created_at) as UtcTimestamp,
    updatedAt: String(row.updated_at) as UtcTimestamp,
  };
}

/**
 * Viewport and style JSON are visual state written by this app; anything unexpected (for example
 * a hand-edited database) falls back to defaults instead of failing to open the map.
 */
function parseViewport(json: string): MapViewport {
  try {
    const value = JSON.parse(json) as Partial<MapViewport>;
    if (
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.zoom) &&
      (value.zoom ?? 0) > 0
    ) {
      return { x: Number(value.x), y: Number(value.y), zoom: Number(value.zoom) };
    }
  } catch {
    // Falls through to the default.
  }
  return DEFAULT_VIEWPORT;
}

function parseStyle(json: string): PlacementStyle {
  try {
    const value = JSON.parse(json) as { color?: unknown };
    if (PLACEMENT_COLORS.includes(value.color as PlacementColor)) {
      return { color: value.color as PlacementColor };
    }
  } catch {
    // Falls through to the default.
  }
  return { color: null };
}
