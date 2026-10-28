/**
 * Mind map storage port (PRD §4.4, §5.6).
 *
 * A map holds placements of canonical nodes and map-only connectors. Everything here is visual
 * or organizational state: node content lives on the node, and nothing in a map creates semantic
 * relationships. Placements are returned with the node's current title, so every map shows the
 * same, latest content of a node (PRD §13 acceptance criterion 6).
 */

import type { UtcTimestamp } from '../clock';
import type {
  MapConnectionId,
  MapId,
  NodeId,
  PlacementId,
  RelationshipId,
  WorkspaceId,
} from '../ids';
import type { RelationshipDirectionality } from '../knowledge/relationship-rules';
import type { Revision } from './repositories';

export const MAP_MODES = ['freeform', 'hierarchical'] as const;
export type MapMode = (typeof MAP_MODES)[number];

/** Pan and zoom of a map canvas. Visual state only. */
export interface MapViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Colors a placement may use; the renderer maps them to theme-aware styles. */
export const PLACEMENT_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type PlacementColor = (typeof PLACEMENT_COLORS)[number];

export interface PlacementStyle {
  readonly color: PlacementColor | null;
}

export interface MindMapRecord {
  readonly id: MapId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly mode: MapMode;
  readonly viewport: MapViewport;
  /** Increases with every structural change, for optimistic concurrency (PRD §14). */
  readonly revision: Revision;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface MindMapSummary {
  readonly id: MapId;
  readonly title: string;
  readonly mode: MapMode;
  readonly revision: Revision;
  readonly placementCount: number;
  readonly updatedAt: UtcTimestamp;
}

export interface PlacementRecord {
  readonly id: PlacementId;
  readonly workspaceId: WorkspaceId;
  readonly mapId: MapId;
  readonly nodeId: NodeId;
  /** Freeform position. Kept unchanged in hierarchical mode so switching back restores it. */
  readonly x: number;
  readonly y: number;
  readonly parentPlacementId: PlacementId | null;
  readonly siblingOrder: number;
  readonly isCollapsed: boolean;
  readonly style: PlacementStyle;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface PlacementWithNode extends PlacementRecord {
  readonly nodeTitle: string;
}

export interface MapConnectionRecord {
  readonly id: MapConnectionId;
  readonly workspaceId: WorkspaceId;
  readonly mapId: MapId;
  readonly sourcePlacementId: PlacementId;
  readonly targetPlacementId: PlacementId;
  /** Optional link to an existing semantic relationship, set only by an explicit user action. */
  readonly relationshipId: RelationshipId | null;
  readonly label: string | null;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface MapConnectionWithRelationship extends MapConnectionRecord {
  /** Label of the linked relationship's type, when the connector references one. */
  readonly relationshipTypeLabel: string | null;
}

/**
 * A semantic relationship whose two nodes are both on a map. Maps show these (PRD §4.2: the
 * relationship belongs to the nodes, so every map with both nodes shows it), but they are not map
 * data: they are derived each time the map is read, never stored as connectors, and never change
 * the hierarchy or positions.
 */
export interface MapRelationship {
  readonly id: RelationshipId;
  /** For undirected relationships, the endpoint with the lower ID. */
  readonly sourceNodeId: NodeId;
  readonly targetNodeId: NodeId;
  readonly typeLabel: string;
  readonly directionality: RelationshipDirectionality;
}

/** A map that shows a given node (for the node panel's "Mind maps" list). */
export interface MapOfNode {
  readonly id: MapId;
  readonly title: string;
  readonly mode: MapMode;
}

export interface MapRepository {
  listMaps(workspaceId: WorkspaceId): Promise<readonly MindMapSummary[]>;
  findMap(workspaceId: WorkspaceId, mapId: MapId): Promise<MindMapRecord | null>;
  insertMap(record: MindMapRecord): Promise<void>;
  /** Stores title, mode, viewport and revision when the stored revision is `expectedRevision`. */
  updateMap(record: MindMapRecord, expectedRevision: Revision): Promise<boolean>;
  /** Stores only the viewport (visual state; no revision change). */
  updateViewport(workspaceId: WorkspaceId, mapId: MapId, viewport: MapViewport): Promise<void>;
  /** Deletes the map with its placements and connectors. Canonical nodes are never deleted. */
  deleteMap(workspaceId: WorkspaceId, mapId: MapId): Promise<void>;

  listPlacements(workspaceId: WorkspaceId, mapId: MapId): Promise<readonly PlacementWithNode[]>;
  insertPlacement(record: PlacementRecord): Promise<void>;
  /** Updates position, parent, order, collapse state and style of each given placement. */
  updatePlacements(records: readonly PlacementRecord[]): Promise<void>;
  deletePlacement(workspaceId: WorkspaceId, placementId: PlacementId): Promise<void>;

  listConnections(
    workspaceId: WorkspaceId,
    mapId: MapId,
  ): Promise<readonly MapConnectionWithRelationship[]>;
  insertConnection(record: MapConnectionRecord): Promise<void>;
  /** Maps the node is placed on, by title. */
  listMapsForNode(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly MapOfNode[]>;
  /** Semantic relationships whose source and target are both placed on the map. */
  listRelationships(workspaceId: WorkspaceId, mapId: MapId): Promise<readonly MapRelationship[]>;
  deleteConnection(workspaceId: WorkspaceId, connectionId: MapConnectionId): Promise<void>;
  /** Sets or clears (null) the semantic relationship a connector refers to. */
  updateConnectionRelationship(
    workspaceId: WorkspaceId,
    connectionId: MapConnectionId,
    relationshipId: RelationshipId | null,
    updatedAt: string,
  ): Promise<void>;
  /** Sets or clears (null) the note written on a connector. */
  updateConnectionLabel(
    workspaceId: WorkspaceId,
    connectionId: MapConnectionId,
    label: string | null,
    updatedAt: string,
  ): Promise<void>;
}
