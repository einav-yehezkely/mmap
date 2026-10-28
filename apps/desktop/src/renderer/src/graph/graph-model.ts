/**
 * Pure model of the knowledge graph view (PRD §5.7): the loaded slice plus any expanded
 * neighborhoods, what the view says about completeness, the elements to draw, emphasis sets for
 * selection, map highlighting and Focus mode, and the accessible list that presents the same
 * information without the canvas (PRD §6).
 *
 * Three kinds of connection are kept distinct everywhere: semantic relationships (edges, with an
 * arrow when directed), note references (an optional dashed layer) and mind map membership (shown
 * on the node itself, never as an edge: sharing a map does not connect two nodes, PRD §4.4).
 *
 * Kept free of React and Cytoscape so it can be unit-tested directly.
 */

import type { GraphSliceDto } from '@mmap/contracts';

import { summaryId, summaryPosition, type CollapseResult } from './graph-regions';

export type SliceNode = GraphSliceDto['nodes'][number];
export type SliceEdge = GraphSliceDto['edges'][number];
export type SliceReference = GraphSliceDto['references'][number];
export type SliceConnector = GraphSliceDto['connectors'][number];
export type SliceMap = GraphSliceDto['maps'][number];

export interface Expansion {
  readonly title: string;
  readonly shownNeighbors: number;
  readonly totalNeighbors: number;
}

export interface GraphState {
  /** Nodes in ranking order (best connected first); each canonical node appears once. */
  readonly nodes: ReadonlyMap<string, SliceNode>;
  readonly edges: ReadonlyMap<string, SliceEdge>;
  /** Keyed by "source>target". */
  readonly references: ReadonlyMap<string, SliceReference>;
  /** Mind map connectors, keyed by "source>target". */
  readonly connectors: ReadonlyMap<string, SliceConnector>;
  /** Every mind map of the workspace, by title. */
  readonly maps: readonly SliceMap[];
  /** Nodes matching the filters in the whole workspace, and how many the overview showed. */
  readonly overviewTotal: number;
  readonly overviewShown: number;
  readonly edgesTruncated: boolean;
  readonly referencesTruncated: boolean;
  readonly connectorsTruncated: boolean;
  /** Neighborhoods the user expanded, by node ID, in expansion order. */
  readonly expansions: ReadonlyMap<string, Expansion>;
}

export function stateFromOverview(slice: GraphSliceDto): GraphState {
  return {
    nodes: new Map(slice.nodes.map((node) => [node.id, node])),
    edges: new Map(slice.edges.map((edge) => [edge.id, edge])),
    references: new Map(slice.references.map((reference) => [referenceKey(reference), reference])),
    connectors: new Map(slice.connectors.map((connector) => [referenceKey(connector), connector])),
    maps: slice.maps,
    overviewTotal: slice.totalNodes,
    overviewShown: slice.nodes.length,
    edgesTruncated: slice.edgesTruncated,
    referencesTruncated: slice.referencesTruncated,
    connectorsTruncated: slice.connectorsTruncated,
    expansions: new Map(),
  };
}

export function referenceKey(reference: { sourceNodeId: string; targetNodeId: string }): string {
  return `${reference.sourceNodeId}>${reference.targetNodeId}`;
}

/**
 * Adds a neighborhood to the view. Items already shown are kept; the expansion records how many
 * neighbors exist and how many were loaded, so a partial expansion is reported, not hidden.
 */
export function mergeNeighborhood(
  state: GraphState,
  nodeId: string,
  slice: GraphSliceDto,
): GraphState {
  const nodes = new Map(state.nodes);
  for (const node of slice.nodes) nodes.set(node.id, node);
  const edges = new Map(state.edges);
  for (const edge of slice.edges) edges.set(edge.id, edge);
  const references = new Map(state.references);
  for (const reference of slice.references) references.set(referenceKey(reference), reference);
  const connectors = new Map(state.connectors);
  for (const connector of slice.connectors) connectors.set(referenceKey(connector), connector);
  const center = slice.nodes.find((node) => node.id === nodeId);
  const expansions = new Map(state.expansions);
  expansions.set(nodeId, {
    title: center?.title ?? 'Unknown node',
    // The slice starts with the expanded node itself.
    shownNeighbors: Math.max(0, slice.nodes.length - 1),
    totalNeighbors: slice.totalNodes,
  });
  return {
    ...state,
    nodes,
    edges,
    references,
    connectors,
    maps: slice.maps,
    edgesTruncated: state.edgesTruncated || slice.edgesTruncated,
    referencesTruncated: state.referencesTruncated || slice.referencesTruncated,
    connectorsTruncated: state.connectorsTruncated || slice.connectorsTruncated,
    expansions,
  };
}

/** True when anything matching the filters is not shown. */
export function isPartial(state: GraphState): boolean {
  return (
    state.overviewShown < state.overviewTotal ||
    state.edgesTruncated ||
    state.referencesTruncated ||
    state.connectorsTruncated ||
    [...state.expansions.values()].some((item) => item.shownNeighbors < item.totalNeighbors)
  );
}

const count = new Intl.NumberFormat();

/**
 * Sentences describing what the view contains (PRD §5.7: "never silently imply that a partial
 * view contains all nodes"). The first sentence is always present.
 */
export function describeCompleteness(state: GraphState): string[] {
  const lines: string[] = [];
  if (state.overviewTotal === 0) {
    lines.push('No nodes match the current filters.');
  } else if (state.overviewShown < state.overviewTotal) {
    lines.push(
      `Partial view: showing ${count.format(state.overviewShown)} of ${count.format(state.overviewTotal)} matching nodes, the most connected first. Narrow the filters or expand a node to see more.`,
    );
  } else {
    lines.push(`Showing all ${count.format(state.overviewTotal)} matching nodes.`);
  }
  if (state.edgesTruncated) {
    lines.push('Some relationships between the shown nodes are not drawn (limit reached).');
  }
  if (state.referencesTruncated) {
    lines.push('Some note links between the shown nodes are not drawn (limit reached).');
  }
  if (state.connectorsTruncated) {
    lines.push('Some map connectors between the shown nodes are not drawn (limit reached).');
  }
  for (const expansion of state.expansions.values()) {
    if (expansion.shownNeighbors < expansion.totalNeighbors) {
      lines.push(
        `Neighbors of “${expansion.title}”: showing ${count.format(expansion.shownNeighbors)} of ${count.format(expansion.totalNeighbors)}.`,
      );
    }
  }
  return lines;
}

/**
 * Restrained palette for map membership badges; readable on light and dark canvases. Colors only
 * decorate: every membership is also named in the tooltip, the side panel and the list.
 */
export const MAP_COLORS = [
  '#60a5fa',
  '#34d399',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#2dd4bf',
  '#fb923c',
  '#a3e635',
] as const;

/** Badge slices drawn per node; further memberships are summarized as one neutral slice. */
const MAX_BADGE_SLICES = 6;
const OTHER_MAPS_COLOR = '#94a3b8';

/** Stable color per map: by the map's position in the title-ordered list of all maps. */
export function mapColors(maps: readonly SliceMap[]): Map<string, string> {
  return new Map(
    maps.map((map, index) => [map.id, MAP_COLORS[index % MAP_COLORS.length] ?? MAP_COLORS[0]]),
  );
}

/** Titles of a node's maps, in title order. */
export function membershipTitles(node: SliceNode, maps: readonly SliceMap[]): string[] {
  const members = new Set(node.mapIds);
  return maps.filter((map) => members.has(map.id)).map((map) => map.title);
}

export interface CytoscapeElement {
  readonly group: 'nodes' | 'edges';
  readonly data: Readonly<Record<string, string | number>>;
  readonly position?: { readonly x: number; readonly y: number };
  readonly classes?: string;
}

/**
 * Elements for Cytoscape. Nodes carry their full title (the canvas truncates it and shows it in
 * full on hover) and, with `showMaps`, pie-slice data for their map badges. Relationship edges
 * carry their type label; whether it is drawn is decided by the canvas (on hover or selection,
 * or always when the user asks). Directed edges get the `directed` class (arrow), undirected ones
 * `undirected`; note links get `reference` (dashed) and map connectors `connector` (dotted, with
 * an arrow), so neither is ever mistaken for a relationship.
 *
 * With collapsed maps (`collapse`), hidden members and their lines are left out; each collapsed
 * map becomes a summary node (`summary` class, its name and node count) and the aggregated
 * connections are drawn with their counts (`aggregate` class).
 */
export function toCytoscapeElements(
  state: GraphState,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  options: { readonly showMaps: boolean; readonly collapse?: CollapseResult },
): CytoscapeElement[] {
  const colors = mapColors(state.maps);
  const hidden = options.collapse?.hidden ?? new Set<string>();
  const drawn = (nodeId: string) => state.nodes.has(nodeId) && !hidden.has(nodeId);
  const elements: CytoscapeElement[] = [];
  for (const node of state.nodes.values()) {
    if (hidden.has(node.id)) continue;
    const data: Record<string, string | number> = {
      id: node.id,
      label: node.title,
      degree: node.degree,
      mapCount: node.mapIds.length,
      // Named in the hover tooltip, so membership never depends on badge colors alone.
      mapsText: membershipTitles(node, state.maps).join(', '),
    };
    const classes: string[] = [];
    if (state.expansions.has(node.id)) classes.push('expanded');
    if (options.showMaps && node.mapIds.length > 0) {
      classes.push('in-maps');
      const ordered = state.maps.filter((map) => node.mapIds.includes(map.id));
      const shown = ordered.slice(0, MAX_BADGE_SLICES);
      const slices = ordered.length > MAX_BADGE_SLICES ? shown.length + 1 : shown.length;
      const size = 100 / slices;
      shown.forEach((map, index) => {
        data[`pie${index + 1}Color`] = colors.get(map.id) ?? OTHER_MAPS_COLOR;
        data[`pie${index + 1}Size`] = size;
      });
      if (ordered.length > MAX_BADGE_SLICES) {
        data[`pie${slices}Color`] = OTHER_MAPS_COLOR;
        data[`pie${slices}Size`] = size;
      }
      for (let index = slices + 1; index <= MAX_BADGE_SLICES + 1; index += 1) {
        data[`pie${index}Color`] = OTHER_MAPS_COLOR;
        data[`pie${index}Size`] = 0;
      }
    }
    const position = positions.get(node.id);
    elements.push({
      group: 'nodes',
      data,
      ...(position === undefined ? {} : { position }),
      classes: classes.join(' '),
    });
  }
  for (const edge of state.edges.values()) {
    if (!drawn(edge.sourceNodeId) || !drawn(edge.targetNodeId)) continue;
    elements.push({
      group: 'edges',
      data: {
        id: `relationship:${edge.id}`,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        label: edge.typeLabel,
      },
      classes: edge.directionality,
    });
  }
  for (const reference of state.references.values()) {
    if (!drawn(reference.sourceNodeId) || !drawn(reference.targetNodeId)) {
      continue;
    }
    elements.push({
      group: 'edges',
      data: {
        id: `reference:${referenceKey(reference)}`,
        source: reference.sourceNodeId,
        target: reference.targetNodeId,
        label: reference.occurrences === 1 ? 'note link' : `${reference.occurrences} note links`,
      },
      classes: 'reference',
    });
  }
  for (const connector of state.connectors.values()) {
    if (!drawn(connector.sourceNodeId) || !drawn(connector.targetNodeId)) continue;
    elements.push({
      group: 'edges',
      data: {
        id: `connector:${referenceKey(connector)}`,
        source: connector.sourceNodeId,
        target: connector.targetNodeId,
        label: connectorText(connector, state.maps),
      },
      classes: 'connector',
    });
  }
  for (const summary of options.collapse?.summaries ?? []) {
    const count = summary.memberCount === 1 ? '1 node' : `${summary.memberCount} nodes`;
    elements.push({
      group: 'nodes',
      data: {
        id: summaryId(summary.mapId),
        label: `${summary.title} · ${count}`,
        degree: 6,
        mapCount: 1,
        mapsText: 'Collapsed mind map. Click to expand it.',
        color: colors.get(summary.mapId) ?? OTHER_MAPS_COLOR,
      },
      position: summaryPosition(summary, positions),
      classes: 'summary',
    });
  }
  for (const connection of options.collapse?.connections ?? []) {
    elements.push({
      group: 'edges',
      data: {
        id: connection.id,
        source: connection.source,
        target: connection.target,
        label: connection.count === 1 ? '1 connection' : `${connection.count} connections`,
      },
      classes: 'aggregate',
    });
  }
  return elements;
}

/** IDs of edges (as drawn: "relationship:<id>" / "reference:<key>") touching `nodeId`. */
function edgesTouching(
  state: GraphState,
  nodeId: string,
): { edges: string[]; neighbors: string[] } {
  const edges: string[] = [];
  const neighbors: string[] = [];
  for (const edge of state.edges.values()) {
    if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) {
      edges.push(`relationship:${edge.id}`);
      neighbors.push(edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId);
    }
  }
  for (const reference of state.references.values()) {
    if (reference.sourceNodeId === nodeId || reference.targetNodeId === nodeId) {
      edges.push(`reference:${referenceKey(reference)}`);
      neighbors.push(
        reference.sourceNodeId === nodeId ? reference.targetNodeId : reference.sourceNodeId,
      );
    }
  }
  for (const connector of state.connectors.values()) {
    if (connector.sourceNodeId === nodeId || connector.targetNodeId === nodeId) {
      edges.push(`connector:${referenceKey(connector)}`);
      neighbors.push(
        connector.sourceNodeId === nodeId ? connector.targetNodeId : connector.sourceNodeId,
      );
    }
  }
  return { edges, neighbors: neighbors.filter((id) => state.nodes.has(id) && id !== nodeId) };
}

export interface Emphasis {
  /** Nodes drawn at full strength; everything else is dimmed. Null means nothing is dimmed. */
  readonly nodes: ReadonlySet<string> | null;
  readonly edges: ReadonlySet<string> | null;
}

/**
 * What to emphasize: a selected node with its immediate neighbors and connecting edges, or else
 * the members of a highlighted map (with the edges among them). Nothing else is dimmed.
 */
export function computeEmphasis(
  state: GraphState,
  selectedNodeId: string | null,
  highlightedMapId: string | null,
): Emphasis {
  if (selectedNodeId !== null && state.nodes.has(selectedNodeId)) {
    const { edges, neighbors } = edgesTouching(state, selectedNodeId);
    return { nodes: new Set([selectedNodeId, ...neighbors]), edges: new Set(edges) };
  }
  if (highlightedMapId !== null) {
    const members = new Set(
      [...state.nodes.values()]
        .filter((node) => node.mapIds.includes(highlightedMapId))
        .map((node) => node.id),
    );
    const edges = new Set<string>();
    for (const edge of state.edges.values()) {
      if (members.has(edge.sourceNodeId) && members.has(edge.targetNodeId)) {
        edges.add(`relationship:${edge.id}`);
      }
    }
    return { nodes: members, edges };
  }
  return { nodes: null, edges: null };
}

/**
 * Focus mode: the focused node, its immediate neighbors, and nodes the user explicitly added by
 * expanding inside Focus mode. Everything else is hidden until Focus mode ends.
 */
export function focusNodeIds(
  state: GraphState,
  centerId: string,
  expandedIds: readonly string[],
): Set<string> {
  const ids = new Set<string>([centerId]);
  for (const id of [centerId, ...expandedIds]) {
    if (!state.nodes.has(id)) continue;
    ids.add(id);
    for (const neighbor of edgesTouching(state, id).neighbors) ids.add(neighbor);
  }
  return ids;
}

export interface GraphListItem {
  readonly id: string;
  readonly title: string;
  /** Mind maps that place the node, by title. */
  readonly maps: readonly string[];
  /** Human-readable connections of this node, e.g. "depends on → Beta", "← cites Alpha". */
  readonly connections: readonly string[];
}

/**
 * The accessible list alternative (PRD §6, §13 criterion 14): every shown node, sorted by title,
 * with its map memberships and every shown relationship and note link written out in words,
 * including direction.
 */
export function buildGraphList(state: GraphState): GraphListItem[] {
  const titleOf = (id: string) => state.nodes.get(id)?.title ?? 'Unknown node';
  const connections = new Map<string, string[]>();
  const add = (id: string, text: string) => {
    const list = connections.get(id);
    if (list === undefined) connections.set(id, [text]);
    else list.push(text);
  };
  for (const edge of state.edges.values()) {
    if (!state.nodes.has(edge.sourceNodeId) || !state.nodes.has(edge.targetNodeId)) continue;
    const source = titleOf(edge.sourceNodeId);
    const target = titleOf(edge.targetNodeId);
    if (edge.directionality === 'directed') {
      add(edge.sourceNodeId, `${edge.typeLabel} → ${target}`);
      add(edge.targetNodeId, `← ${edge.typeLabel} ${source}`);
    } else {
      add(edge.sourceNodeId, `${edge.typeLabel} — ${target}`);
      add(edge.targetNodeId, `${edge.typeLabel} — ${source}`);
    }
  }
  for (const reference of state.references.values()) {
    if (!state.nodes.has(reference.sourceNodeId) || !state.nodes.has(reference.targetNodeId)) {
      continue;
    }
    add(reference.sourceNodeId, `note links to ${titleOf(reference.targetNodeId)}`);
    add(reference.targetNodeId, `linked from the note of ${titleOf(reference.sourceNodeId)}`);
  }
  for (const connector of state.connectors.values()) {
    if (!state.nodes.has(connector.sourceNodeId) || !state.nodes.has(connector.targetNodeId)) {
      continue;
    }
    const where = connectorText(connector, state.maps);
    add(connector.sourceNodeId, `map connector to ${titleOf(connector.targetNodeId)} (${where})`);
    add(connector.targetNodeId, `map connector from ${titleOf(connector.sourceNodeId)} (${where})`);
  }
  return [...state.nodes.values()]
    .map((node) => ({
      id: node.id,
      title: node.title,
      maps: membershipTitles(node, state.maps),
      connections: (connections.get(node.id) ?? []).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
}

/** Loaded nodes whose title contains `text` (case-insensitive), best connected first. */
export function findNodes(state: GraphState, text: string, limit: number): SliceNode[] {
  const needle = text.trim().toLocaleLowerCase();
  if (needle === '') return [];
  const matches: SliceNode[] = [];
  for (const node of state.nodes.values()) {
    if (node.title.toLocaleLowerCase().includes(needle)) matches.push(node);
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Where a connector is drawn, e.g. "on Thermodynamics" or "on 3 maps". */
export function connectorText(connector: SliceConnector, maps: readonly SliceMap[]): string {
  if (connector.mapIds.length !== 1) return `on ${connector.mapIds.length} maps`;
  const title = maps.find((map) => map.id === connector.mapIds[0])?.title;
  return title === undefined ? 'on 1 map' : `on ${title}`;
}
