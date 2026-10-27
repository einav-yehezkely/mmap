/**
 * Global knowledge graph (PRD §5.7): validates filters and limits, then delegates to the
 * `GraphQuery` port. Limits are clamped to the PRD caps (1,000 nodes and 3,000 edges for the
 * initial view, 200 neighbors per expansion), so a request can never ask for an unbounded graph.
 *
 * Graph positions are visual state of this view only. They are stored apart from
 * mind map placements and never change knowledge or any map's layout.
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { MapId, NodeId, RelationshipTypeId, TagId, WorkspaceId } from '../ids';
import {
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NEIGHBORS,
  MAX_GRAPH_NODES,
  type GraphFilters,
  type GraphLayoutRepository,
  type GraphNodePosition,
  type GraphQuery,
  type GraphSlice,
} from '../ports/graph';
import type { TransactionRunner } from '../ports/transaction';

/** Longest graph text filter, in characters (the same bound as search text). */
export const MAX_GRAPH_FILTER_TEXT_LENGTH = 500;
/** Largest number of positions read or saved in one call. */
export const MAX_GRAPH_POSITIONS_PER_CALL = 5_000;
/** Coordinates beyond this are treated as corrupt input (e.g. from a broken drag event). */
const MAX_COORDINATE = 1_000_000;

export interface GraphServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly graph: GraphQuery;
  readonly layout: GraphLayoutRepository;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
}

export interface GraphFilterInput {
  readonly tagIds?: readonly TagId[];
  readonly relationshipTypeIds?: readonly RelationshipTypeId[];
  readonly mapIds?: readonly MapId[];
  readonly text?: string | null;
  readonly includeReferences?: boolean;
}

export interface GraphService {
  overview(filters: GraphFilterInput, maxNodes?: number): Promise<GraphSlice>;
  /** A node with its direct neighbors, for expanding the view around it. */
  neighborhood(nodeId: NodeId, filters: GraphFilterInput): Promise<GraphSlice>;
  /** Saved positions of the given nodes (nodes without one are absent). */
  positions(nodeIds: readonly NodeId[]): Promise<readonly GraphNodePosition[]>;
  savePositions(positions: readonly GraphNodePosition[]): Promise<void>;
}

function clamp(requested: number | undefined, maximum: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return maximum;
  return Math.min(maximum, Math.max(1, Math.trunc(requested)));
}

function validCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

export function normalizeGraphFilters(input: GraphFilterInput): GraphFilters {
  const text = input.text?.trim() ?? '';
  if (text.length > MAX_GRAPH_FILTER_TEXT_LENGTH) {
    throw new DomainError('VALIDATION_FAILED', 'The filter text is too long.');
  }
  return {
    tagIds: [...new Set(input.tagIds ?? [])],
    relationshipTypeIds: [...new Set(input.relationshipTypeIds ?? [])],
    mapIds: [...new Set(input.mapIds ?? [])],
    text: text === '' ? null : text,
    includeReferences: input.includeReferences ?? false,
  };
}

export function createGraphService({
  workspaceId,
  graph,
  layout,
  transactions,
  clock,
}: GraphServiceDependencies): GraphService {
  const checkCount = (count: number) => {
    if (count > MAX_GRAPH_POSITIONS_PER_CALL) {
      throw new DomainError('VALIDATION_FAILED', 'Too many graph positions in one request.');
    }
  };

  return {
    overview: (filters, maxNodes) =>
      graph.overview(workspaceId, normalizeGraphFilters(filters), {
        maxNodes: clamp(maxNodes, MAX_GRAPH_NODES),
        maxEdges: MAX_GRAPH_EDGES,
      }),

    neighborhood: async (nodeId, filters) => {
      const slice = await graph.neighborhood(workspaceId, nodeId, normalizeGraphFilters(filters), {
        maxNeighbors: MAX_GRAPH_NEIGHBORS,
        maxEdges: MAX_GRAPH_EDGES,
      });
      if (slice === null) {
        throw new DomainError('NOT_FOUND', 'This node no longer exists.');
      }
      return slice;
    },

    positions: async (nodeIds) => {
      checkCount(nodeIds.length);
      return layout.positions(workspaceId, [...new Set(nodeIds)]);
    },

    savePositions: async (positions) => {
      checkCount(positions.length);
      if (
        positions.some((position) => !validCoordinate(position.x) || !validCoordinate(position.y))
      ) {
        throw new DomainError('VALIDATION_FAILED', 'A graph position is outside the canvas.');
      }
      return transactions.runInTransaction(() =>
        layout.savePositions(workspaceId, positions, clock.now()),
      );
    },
  };
}
