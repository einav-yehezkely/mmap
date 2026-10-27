/**
 * Map regions and collapsing in the knowledge graph (graph redesign, section 5).
 *
 * Mind map membership overlaps: one canonical node can be on several maps. So maps are never
 * turned into an exclusive hierarchy (Cytoscape compound nodes would force each node into one
 * parent). Instead:
 * - Regions: each shown map gets a soft, labeled outline drawn behind the graph around its
 *   visible members (a padded convex hull). Regions may overlap; a shared node simply lies inside
 *   every region of its maps, still as one node.
 * - Collapsing: a collapsed map is drawn as one summary node with its name and node count. Only
 *   members that belong to no expanded map are hidden into it; a member that is also on an
 *   expanded map stays visible as its one canonical node. Relationships to hidden members are
 *   aggregated onto the summary (one line per pair, with a count), so connections between
 *   collapsed maps and the rest of the graph stay visible.
 *
 * Pure functions, unit-tested; the canvas only draws their results.
 */

import type { GraphState } from './graph-model';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Prefix of summary node IDs (map IDs are UUIDs, so no clash with node IDs). */
export const SUMMARY_PREFIX = 'map:';

export function summaryId(mapId: string): string {
  return `${SUMMARY_PREFIX}${mapId}`;
}

export function isSummaryId(id: string): boolean {
  return id.startsWith(SUMMARY_PREFIX);
}

export interface MapSummary {
  readonly mapId: string;
  readonly title: string;
  /** Members of the map among the loaded nodes (hidden or not). */
  readonly memberCount: number;
  readonly memberIds: readonly string[];
  /** Members hidden into this summary (on no expanded map). */
  readonly hiddenIds: readonly string[];
}

export interface AggregatedConnection {
  readonly id: string;
  /** A visible node ID or a summary ID. */
  readonly source: string;
  readonly target: string;
  /** Number of relationships and note links this line stands for. */
  readonly count: number;
}

export interface CollapseResult {
  /** Loaded nodes not drawn because every map they are on is collapsed. */
  readonly hidden: ReadonlySet<string>;
  readonly summaries: readonly MapSummary[];
  readonly connections: readonly AggregatedConnection[];
}

/**
 * Applies collapsed maps to the loaded graph. Nodes on no map are never hidden; a node is hidden
 * only when it is on at least one collapsed map and on no expanded one.
 */
export function collapseMaps(
  state: GraphState,
  collapsedMapIds: ReadonlySet<string>,
): CollapseResult {
  if (collapsedMapIds.size === 0) return { hidden: new Set(), summaries: [], connections: [] };
  const hidden = new Set<string>();
  const hiddenInto = new Map<string, string[]>();
  const membersOf = new Map<string, string[]>();
  for (const node of state.nodes.values()) {
    for (const mapId of node.mapIds) {
      if (collapsedMapIds.has(mapId))
        membersOf.set(mapId, [...(membersOf.get(mapId) ?? []), node.id]);
    }
    if (node.mapIds.length === 0) continue;
    if (node.mapIds.every((mapId) => collapsedMapIds.has(mapId))) {
      hidden.add(node.id);
      for (const mapId of node.mapIds) {
        hiddenInto.set(mapId, [...(hiddenInto.get(mapId) ?? []), node.id]);
      }
    }
  }

  const summaries: MapSummary[] = state.maps
    .filter((map) => collapsedMapIds.has(map.id) && (membersOf.get(map.id)?.length ?? 0) > 0)
    .map((map) => ({
      mapId: map.id,
      title: map.title,
      memberCount: membersOf.get(map.id)?.length ?? 0,
      memberIds: membersOf.get(map.id) ?? [],
      hiddenIds: hiddenInto.get(map.id) ?? [],
    }));

  // Where an endpoint is drawn: itself if visible, otherwise every collapsed map it is hidden in.
  const endpoints = (nodeId: string): string[] => {
    if (!hidden.has(nodeId)) return [nodeId];
    const node = state.nodes.get(nodeId);
    return (node?.mapIds ?? []).filter((id) => collapsedMapIds.has(id)).map(summaryId);
  };
  const counts = new Map<string, { source: string; target: string; count: number }>();
  const add = (sourceId: string, targetId: string) => {
    if (!hidden.has(sourceId) && !hidden.has(targetId)) return; // drawn as a normal line
    for (const source of endpoints(sourceId)) {
      for (const target of endpoints(targetId)) {
        if (source === target) continue; // inside one collapsed map
        // Undirected aggregate: one line per unordered pair.
        const [a, b] = source < target ? [source, target] : [target, source];
        const key = `${a}|${b}`;
        const current = counts.get(key);
        counts.set(key, { source: a, target: b, count: (current?.count ?? 0) + 1 });
      }
    }
  };
  for (const edge of state.edges.values()) add(edge.sourceNodeId, edge.targetNodeId);
  for (const reference of state.references.values()) {
    add(reference.sourceNodeId, reference.targetNodeId);
  }
  const connections = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ id: `aggregate:${key}`, ...value }));
  return { hidden, summaries, connections };
}

/**
 * Where a summary node is drawn: the center of its hidden members, or of all its members when
 * none is hidden (every member is shared with an expanded map and stays visible).
 */
export function summaryPosition(summary: MapSummary, positions: ReadonlyMap<string, Point>): Point {
  const ids = summary.hiddenIds.length > 0 ? summary.hiddenIds : summary.memberIds;
  const points = ids
    .map((id) => positions.get(id))
    .filter((point): point is Point => point !== undefined);
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function cross(origin: Point, a: Point, b: Point): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

/**
 * Convex hull (Andrew's monotone chain), counter-clockwise, without repeated points. One or two
 * points return themselves; the canvas pads the outline, so they still get a visible region.
 */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter(
    (point, index) =>
      index === 0 || point.x !== sorted[index - 1]?.x || point.y !== sorted[index - 1]?.y,
  );
  if (unique.length <= 2) return unique;
  const lower: Point[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface RegionSpec {
  readonly mapId: string;
  readonly title: string;
  readonly color: string;
  /** Visible members (canonical node IDs) the region surrounds. */
  readonly memberIds: readonly string[];
}

/**
 * Regions to draw: maps that are expanded and have visible members, in title order, at most
 * `limit` (many overlapping outlines would be unreadable). `onlyMapIds`, when not empty, limits
 * regions to those maps (e.g. the maps selected in the filter).
 */
export function regionSpecs(
  state: GraphState,
  colors: ReadonlyMap<string, string>,
  collapsed: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  onlyMapIds: readonly string[],
  limit: number,
): { regions: RegionSpec[]; omitted: number } {
  const members = new Map<string, string[]>();
  for (const node of state.nodes.values()) {
    if (hidden.has(node.id)) continue;
    for (const mapId of node.mapIds) members.set(mapId, [...(members.get(mapId) ?? []), node.id]);
  }
  const candidates = state.maps.filter(
    (map) =>
      !collapsed.has(map.id) &&
      (members.get(map.id)?.length ?? 0) > 0 &&
      (onlyMapIds.length === 0 || onlyMapIds.includes(map.id)),
  );
  return {
    regions: candidates.slice(0, limit).map((map) => ({
      mapId: map.id,
      title: map.title,
      color: colors.get(map.id) ?? '#94a3b8',
      memberIds: members.get(map.id) ?? [],
    })),
    omitted: Math.max(0, candidates.length - limit),
  };
}
