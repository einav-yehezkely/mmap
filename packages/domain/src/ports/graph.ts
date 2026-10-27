/**
 * Global knowledge graph queries (PRD §5.7).
 *
 * The graph shows canonical nodes and semantic relationships of the active workspace, plus an
 * optional, separately styled layer of note references (wikilinks, PRD §4.3). Large workspaces
 * are loaded in bounded slices: every result says how many items matched in total, so the view
 * can state that it is partial instead of implying it shows everything (PRD §5.7, §13 criterion 9).
 *
 * Layout coordinates are not part of these results: they are visual state of the view and never
 * change knowledge (PRD §5.7).
 */

import type { UtcTimestamp } from '../clock';
import type { MapId, NodeId, RelationshipId, RelationshipTypeId, TagId, WorkspaceId } from '../ids';
import type { RelationshipDirectionality } from '../knowledge/relationship-rules';

/** PRD §9: the initial graph is capped at 1,000 nodes and 3,000 edges. */
export const MAX_GRAPH_NODES = 1_000;
export const MAX_GRAPH_EDGES = 3_000;
/** Largest number of neighbors returned by one expansion. */
export const MAX_GRAPH_NEIGHBORS = 200;

export interface GraphFilters {
  /** Only nodes carrying all of these tags. */
  readonly tagIds: readonly TagId[];
  /**
   * Only relationships of these types, and only nodes taking part in at least one of them.
   * Empty means every type.
   */
  readonly relationshipTypeIds: readonly RelationshipTypeId[];
  /**
   * Only nodes placed on at least one of these mind maps (the union of the maps). Empty means no
   * map filter: nodes on no map stay visible.
   */
  readonly mapIds: readonly MapId[];
  /** Full-text filter on title, summary and note (same rules as search); null for none. */
  readonly text: string | null;
  /** Whether to include the note-reference layer. */
  readonly includeReferences: boolean;
}

export interface GraphNode {
  readonly id: NodeId;
  readonly title: string;
  /** Number of relationships of the node within the type filter, across the whole workspace. */
  readonly degree: number;
  /**
   * Mind maps that place this node. Membership is shown in the graph but is not a relationship:
   * sharing a map never creates an edge (PRD §4.4).
   */
  readonly mapIds: readonly MapId[];
}

/** A mind map as the graph lists it (for membership badges and the map filter). */
export interface GraphMap {
  readonly id: MapId;
  readonly title: string;
  /** Number of nodes placed on the map. */
  readonly nodeCount: number;
}

export interface GraphEdge {
  readonly id: RelationshipId;
  readonly sourceNodeId: NodeId;
  readonly targetNodeId: NodeId;
  readonly typeId: RelationshipTypeId;
  readonly typeLabel: string;
  readonly directionality: RelationshipDirectionality;
}

/** One or more wikilinks from one note to another node, shown as a single line. */
export interface GraphReference {
  readonly sourceNodeId: NodeId;
  readonly targetNodeId: NodeId;
  readonly occurrences: number;
}

export interface GraphSlice {
  readonly nodes: readonly GraphNode[];
  /** Every mind map of the workspace, by title, so memberships can be named. */
  readonly maps: readonly GraphMap[];
  readonly edges: readonly GraphEdge[];
  readonly references: readonly GraphReference[];
  /** Nodes that match the filters in the whole workspace (or neighbors, for an expansion). */
  readonly totalNodes: number;
  /** True when some matching relationships between the returned nodes were left out. */
  readonly edgesTruncated: boolean;
  /** True when some note references between the returned nodes were left out. */
  readonly referencesTruncated: boolean;
}

export interface GraphQuery {
  /**
   * The best-connected matching nodes (by degree, then title, then ID, so the selection is
   * deterministic) up to `maxNodes`, with the relationships and references among them.
   */
  overview(
    workspaceId: WorkspaceId,
    filters: GraphFilters,
    limits: { readonly maxNodes: number; readonly maxEdges: number },
  ): Promise<GraphSlice>;
  /**
   * The node and its direct neighbors through relationships (and references, when included),
   * up to `maxNeighbors`, with all relationships and references among the returned nodes.
   * Neighbors are filtered by tags, types and text like the overview.
   */
  neighborhood(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    filters: GraphFilters,
    limits: { readonly maxNeighbors: number; readonly maxEdges: number },
  ): Promise<GraphSlice | null>;
}

export interface GraphNodePosition {
  readonly nodeId: NodeId;
  readonly x: number;
  readonly y: number;
}

/**
 * Where the user left nodes in the global graph (PRD §5.7: layout is visual state). Kept apart
 * from mind map placements, so moving a node here never moves it in a map. The viewport is not
 * stored: the graph always opens fitted to view.
 */
export interface GraphLayoutRepository {
  /** Saved positions of the given nodes (nodes without one are absent). */
  positions(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
  ): Promise<readonly GraphNodePosition[]>;
  /** Stores positions; positions of nodes that no longer exist in the workspace are ignored. */
  savePositions(
    workspaceId: WorkspaceId,
    positions: readonly GraphNodePosition[],
    updatedAt: UtcTimestamp,
  ): Promise<void>;
}
