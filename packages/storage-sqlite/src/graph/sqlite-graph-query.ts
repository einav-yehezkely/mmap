/**
 * SQLite implementation of the `GraphQuery` port (PRD §5.7).
 *
 * Every query is scoped to one workspace. Node selection is deterministic: most relationships
 * first (within the type filter), then title (case-insensitive like SQLite's NOCASE: ASCII
 * letters only), then ID, so the same data and filters always produce the same slice. Totals are
 * always reported, so the caller can tell the user that a view is partial (PRD §5.7 "never
 * silently imply that a partial view contains all nodes").
 *
 * Design: the SQL here is deliberately simple (one indexed scan per table, filters as bound
 * parameters) and the ranking and joining of the slice happen in TypeScript. On the PRD dataset
 * (10,000 nodes, 30,000 relationships) this is linear and predictable. Earlier versions that
 * pushed everything into SQL depended on query-plan choices: ID lists expanded with `json_each`
 * were re-evaluated per row (about 600 ms for the edges among 1,000 nodes), and per-node
 * correlated counts with a type filter picked the type index and took minutes (both measured on
 * the PRD dataset during development with temporary instrumentation). The current design is
 * measured by `search.benchmark.test.ts`.
 */

import type {
  GraphConnector,
  GraphEdge,
  GraphFilters,
  GraphMap,
  GraphNode,
  GraphQuery,
  GraphReference,
  GraphSlice,
  MapId,
  NodeId,
  RelationshipDirectionality,
  RelationshipId,
  RelationshipTypeId,
  WorkspaceId,
} from '@mmap/domain';
import type { SQLInputValue } from 'node:sqlite';

import { placeholders } from '../repositories/sqlite-tag-repository';
import { buildFtsMatchExpression } from '../search/fts-query';
import type { SqliteConnections } from '../sqlite-connections';

interface SqlFragment {
  readonly sql: string;
  readonly parameters: readonly SQLInputValue[];
}

/** A relationship row with what the slice needs, ordered by creation then ID. */
interface RelationshipRow extends GraphEdge {
  readonly createdAt: string;
}

const EMPTY: SqlFragment = { sql: '', parameters: [] };

const EMPTY_SLICE: GraphSlice = {
  nodes: [],
  maps: [],
  edges: [],
  references: [],
  connectors: [],
  totalNodes: 0,
  edgesTruncated: false,
  referencesTruncated: false,
  connectorsTruncated: false,
};

export class SqliteGraphQuery implements GraphQuery {
  public constructor(private readonly connections: SqliteConnections) {}

  public async overview(
    workspaceId: WorkspaceId,
    filters: GraphFilters,
    limits: { readonly maxNodes: number; readonly maxEdges: number },
  ): Promise<GraphSlice> {
    const maps = this.maps(workspaceId);
    const memberships = this.memberships(workspaceId);
    const candidates = this.candidateNodes(workspaceId, filters, memberships);
    if (candidates === null) return { ...EMPTY_SLICE, maps };
    const relationships = this.relationships(workspaceId, filters.relationshipTypeIds);
    const degrees = degreeMap(relationships);
    const ranked = rank(candidates, degrees, memberships, filters.relationshipTypeIds.length > 0);
    const nodes = ranked.slice(0, limits.maxNodes);
    return {
      nodes,
      maps,
      totalNodes: ranked.length,
      ...this.connectionsAmong(workspaceId, filters, nodes, relationships, limits.maxEdges),
    };
  }

  public async neighborhood(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    filters: GraphFilters,
    limits: { readonly maxNeighbors: number; readonly maxEdges: number },
  ): Promise<GraphSlice | null> {
    const centerRow = this.connections
      .forRead()
      .prepare('SELECT id, title FROM knowledge_nodes WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, nodeId);
    if (centerRow === undefined) return null;
    const relationships = this.relationships(workspaceId, filters.relationshipTypeIds);
    const degrees = degreeMap(relationships);
    const memberships = this.memberships(workspaceId);
    const center: GraphNode = {
      id: nodeId,
      title: String(centerRow.title),
      degree: degrees.get(nodeId) ?? 0,
      mapIds: memberships.get(nodeId) ?? [],
    };

    const neighborIds = new Set<string>();
    for (const relationship of relationships) {
      if (relationship.sourceNodeId === nodeId) neighborIds.add(relationship.targetNodeId);
      if (relationship.targetNodeId === nodeId) neighborIds.add(relationship.sourceNodeId);
    }
    if (filters.includeReferences) {
      for (const reference of this.references(workspaceId)) {
        if (reference.sourceNodeId === nodeId) neighborIds.add(reference.targetNodeId);
        if (reference.targetNodeId === nodeId) neighborIds.add(reference.sourceNodeId);
      }
    }
    if (filters.includeConnectors) {
      for (const connector of this.connectors(workspaceId)) {
        if (connector.sourceNodeId === nodeId) neighborIds.add(connector.targetNodeId);
        if (connector.targetNodeId === nodeId) neighborIds.add(connector.sourceNodeId);
      }
    }
    neighborIds.delete(nodeId);

    // The expanded node itself is always shown; its neighbors follow the filters.
    const candidates = this.candidateNodes(workspaceId, filters, memberships) ?? [];
    const neighbors = rank(
      candidates.filter((candidate) => neighborIds.has(candidate.id)),
      degrees,
      memberships,
      false,
    );
    const nodes = [center, ...neighbors.slice(0, limits.maxNeighbors)];
    return {
      nodes,
      maps: this.maps(workspaceId),
      totalNodes: neighbors.length,
      ...this.connectionsAmong(workspaceId, filters, nodes, relationships, limits.maxEdges),
    };
  }

  /**
   * Nodes matching the tag, text and map filters, as (id, title). Returns null when the text has
   * no searchable word, which means "nothing matches". With a map filter, a node qualifies when it
   * is placed on any of the selected maps (their union).
   */
  private candidateNodes(
    workspaceId: WorkspaceId,
    filters: GraphFilters,
    memberships: ReadonlyMap<string, readonly MapId[]>,
  ): { id: NodeId; title: string }[] | null {
    const text = textFilter(filters.text);
    if (text === null) return null;
    const tags = tagFilter(workspaceId, filters.tagIds);
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT n.id, n.title FROM knowledge_nodes AS n
         WHERE n.workspace_id = ? ${tags.sql} ${text.sql}`,
      )
      .all(workspaceId, ...tags.parameters, ...text.parameters)
      .map((row) => ({ id: String(row.id) as NodeId, title: String(row.title) }));
    if (filters.mapIds.length === 0) return rows;
    const selected = new Set<string>(filters.mapIds);
    return rows.filter((row) =>
      (memberships.get(row.id) ?? []).some((mapId) => selected.has(mapId)),
    );
  }

  /** Every mind map of the workspace with its node count, by title. */
  private maps(workspaceId: WorkspaceId): GraphMap[] {
    return this.connections
      .forRead()
      .prepare(
        `SELECT m.id, m.title,
                (SELECT count(*) FROM map_placements AS p WHERE p.map_id = m.id) AS node_count
         FROM mind_maps AS m
         WHERE m.workspace_id = ?
         ORDER BY m.title COLLATE NOCASE, m.id`,
      )
      .all(workspaceId)
      .map((row) => ({
        id: String(row.id) as MapId,
        title: String(row.title),
        nodeCount: Number(row.node_count),
      }));
  }

  /** Map IDs per node, from map placements (a node appears at most once per map). */
  private memberships(workspaceId: WorkspaceId): Map<string, MapId[]> {
    const memberships = new Map<string, MapId[]>();
    const rows = this.connections
      .forRead()
      .prepare('SELECT node_id, map_id FROM map_placements WHERE workspace_id = ? ORDER BY map_id')
      .all(workspaceId);
    for (const row of rows) {
      const nodeId = String(row.node_id);
      const list = memberships.get(nodeId);
      if (list === undefined) memberships.set(nodeId, [String(row.map_id) as MapId]);
      else list.push(String(row.map_id) as MapId);
    }
    return memberships;
  }

  /** Every relationship of the workspace within the type filter, oldest first. */
  private relationships(
    workspaceId: WorkspaceId,
    typeIds: readonly RelationshipTypeId[],
  ): RelationshipRow[] {
    const unique = [...new Set(typeIds)];
    const types =
      unique.length === 0
        ? EMPTY
        : { sql: `AND r.type_id IN (${placeholders(unique.length)})`, parameters: unique };
    return this.connections
      .forRead()
      .prepare(
        `SELECT r.id, r.source_node_id, r.target_node_id, r.type_id, r.directionality,
                r.created_at, t.label AS type_label
         FROM relationships AS r
         JOIN relationship_types AS t ON t.id = r.type_id
         WHERE r.workspace_id = ? ${types.sql}
         ORDER BY r.created_at, r.id`,
      )
      .all(workspaceId, ...types.parameters)
      .map((row) => ({
        id: String(row.id) as RelationshipId,
        sourceNodeId: String(row.source_node_id) as NodeId,
        targetNodeId: String(row.target_node_id) as NodeId,
        typeId: String(row.type_id) as RelationshipTypeId,
        typeLabel: String(row.type_label),
        directionality: String(row.directionality) as RelationshipDirectionality,
        createdAt: String(row.created_at),
      }));
  }

  /**
   * Note references of the workspace, one per (source, target) pair with its count, ordered by
   * source then target. A note linking to its own node is not a connection and is left out.
   */
  private references(workspaceId: WorkspaceId): GraphReference[] {
    return this.connections
      .forRead()
      .prepare(
        `SELECT source_node_id, target_node_id, count(*) AS occurrences
         FROM note_references
         WHERE workspace_id = ? AND source_node_id <> target_node_id
         GROUP BY source_node_id, target_node_id
         ORDER BY source_node_id, target_node_id`,
      )
      .all(workspaceId)
      .map((row) => ({
        sourceNodeId: String(row.source_node_id) as NodeId,
        targetNodeId: String(row.target_node_id) as NodeId,
        occurrences: Number(row.occurrences),
      }));
  }

  /**
   * Map connectors between nodes, grouped by direction: one entry per ordered pair of nodes, with
   * every map that has such a connector. Connectors from a node to itself are not connections.
   */
  private connectors(workspaceId: WorkspaceId): GraphConnector[] {
    const rows = this.connections
      .forRead()
      .prepare(
        `SELECT source.node_id AS source_node_id, target.node_id AS target_node_id, c.map_id
         FROM map_connections AS c
         JOIN map_placements AS source ON source.id = c.source_placement_id
         JOIN map_placements AS target ON target.id = c.target_placement_id
         WHERE c.workspace_id = ? AND source.node_id <> target.node_id
         ORDER BY source.node_id, target.node_id, c.map_id`,
      )
      .all(workspaceId);
    const byPair = new Map<
      string,
      { sourceNodeId: NodeId; targetNodeId: NodeId; mapIds: MapId[] }
    >();
    for (const row of rows) {
      const sourceNodeId = String(row.source_node_id) as NodeId;
      const targetNodeId = String(row.target_node_id) as NodeId;
      const mapId = String(row.map_id) as MapId;
      const key = `${sourceNodeId}>${targetNodeId}`;
      const entry = byPair.get(key) ?? { sourceNodeId, targetNodeId, mapIds: [] };
      if (!entry.mapIds.includes(mapId)) entry.mapIds.push(mapId);
      byPair.set(key, entry);
    }
    return [...byPair.values()];
  }

  /** Relationships and (optionally) references whose both ends are among `nodes`. */
  private connectionsAmong(
    workspaceId: WorkspaceId,
    filters: GraphFilters,
    nodes: readonly GraphNode[],
    relationships: readonly RelationshipRow[],
    maxEdges: number,
  ): Pick<
    GraphSlice,
    | 'edges'
    | 'references'
    | 'connectors'
    | 'edgesTruncated'
    | 'referencesTruncated'
    | 'connectorsTruncated'
  > {
    const shown = new Set<string>(nodes.map((node) => node.id));
    const among = relationships.filter(
      (relationship) =>
        shown.has(relationship.sourceNodeId) && shown.has(relationship.targetNodeId),
    );
    const edges = among
      .slice(0, maxEdges)
      .map(({ id, sourceNodeId, targetNodeId, typeId, typeLabel, directionality }) => ({
        id,
        sourceNodeId,
        targetNodeId,
        typeId,
        typeLabel,
        directionality,
      }));
    const references = filters.includeReferences
      ? this.references(workspaceId).filter(
          (reference) => shown.has(reference.sourceNodeId) && shown.has(reference.targetNodeId),
        )
      : [];
    const connectors = filters.includeConnectors
      ? this.connectors(workspaceId).filter(
          (connector) => shown.has(connector.sourceNodeId) && shown.has(connector.targetNodeId),
        )
      : [];
    return {
      edges,
      references: references.slice(0, maxEdges),
      connectors: connectors.slice(0, maxEdges),
      edgesTruncated: among.length > maxEdges,
      referencesTruncated: references.length > maxEdges,
      connectorsTruncated: connectors.length > maxEdges,
    };
  }
}

/** Relationship count per node; each relationship counts once for each of its two ends. */
function degreeMap(relationships: readonly RelationshipRow[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const { sourceNodeId, targetNodeId } of relationships) {
    degrees.set(sourceNodeId, (degrees.get(sourceNodeId) ?? 0) + 1);
    degrees.set(targetNodeId, (degrees.get(targetNodeId) ?? 0) + 1);
  }
  return degrees;
}

/** Folds ASCII letters only, like SQLite's built-in NOCASE collation. */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Ranks candidates by degree (descending), then title (ASCII case-insensitive), then ID. With
 * `requireDegree`, nodes without a relationship (within the type filter) are left out.
 */
function rank(
  candidates: readonly { id: NodeId; title: string }[],
  degrees: ReadonlyMap<string, number>,
  memberships: ReadonlyMap<string, readonly MapId[]>,
  requireDegree: boolean,
): GraphNode[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      degree: degrees.get(candidate.id) ?? 0,
      mapIds: memberships.get(candidate.id) ?? [],
    }))
    .filter((node) => !requireDegree || node.degree > 0)
    .map((node) => ({ node, folded: foldAscii(node.title) }))
    .sort(
      (a, b) =>
        b.node.degree - a.node.degree ||
        compareCodeUnits(a.folded, b.folded) ||
        compareCodeUnits(a.node.id, b.node.id),
    )
    .map(({ node }) => node);
}

/** Nodes carrying all of `tagIds` (the same "match all" rule as the library and search). */
function tagFilter(workspaceId: WorkspaceId, tagIds: readonly string[]): SqlFragment {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return EMPTY;
  return {
    sql: `AND n.id IN (
      SELECT node_id FROM node_tags
      WHERE workspace_id = ? AND tag_id IN (${placeholders(unique.length)})
      GROUP BY node_id HAVING count(DISTINCT tag_id) = ?
    )`,
    parameters: [workspaceId, ...unique, unique.length],
  };
}

/**
 * Full-text condition with the same escaping and matching rules as search. Returns null when
 * the text has no searchable word, which means "nothing matches"; no text means no filter.
 */
function textFilter(text: string | null): SqlFragment | null {
  if (text === null || text.trim() === '') return EMPTY;
  const match = buildFtsMatchExpression(text);
  if (match === null) return null;
  return {
    sql: `AND n.row_key IN (
      SELECT rowid FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH ?
    )`,
    parameters: [match],
  };
}
