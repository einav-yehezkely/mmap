/**
 * Pure helpers that turn a map view (from the main process) into what the canvas and the outline
 * show, and that compute keyboard moves within a hierarchy (PRD §5.6). Kept free of React and
 * React Flow so they can be unit-tested directly.
 *
 * Three kinds of lines are kept visually distinct (PRD §14 "confusion between visual structure
 * and meaning"):
 * - hierarchy lines (parent → child, hierarchical mode only): map structure;
 * - map connectors: visual links drawn on this map only;
 * - semantic relationships between two nodes that are both on the map. They belong to the nodes,
 *   so every map showing both nodes shows them, with the relationship's type and direction. They
 *   are derived from the relationships, never stored on the map, and never move items or change
 *   the hierarchy. A relationship already shown by a connector linked to it is not drawn again.
 */

import type { MapConnectionViewDto, MapViewDto, PlacementViewDto } from '@mmap/contracts';
import { childrenIndex, layoutTree, orderedChildren, type HierarchyItem } from '@mmap/domain';

export interface CanvasItem {
  readonly placement: PlacementViewDto;
  readonly position: { readonly x: number; readonly y: number };
  readonly childCount: number;
}

export interface CanvasLine {
  readonly id: string;
  readonly kind: 'hierarchy' | 'connector' | 'relationship';
  readonly source: string;
  readonly target: string;
  /** Text shown on the line: the connector label and/or the referenced relationship type. */
  readonly label: string | null;
  /** Relationship lines: false for undirected relationships, which have no arrow. */
  readonly directed?: boolean;
  /** Connector lines: the connector itself (its own note and linked relationship). */
  readonly connection?: MapConnectionViewDto;
}

export interface CanvasModel {
  readonly items: readonly CanvasItem[];
  readonly lines: readonly CanvasLine[];
  /** Placements hidden because an ancestor is collapsed (hierarchical mode only). */
  readonly hiddenCount: number;
}

export function hierarchyItemsOf(view: MapViewDto): HierarchyItem[] {
  return view.placements.map((placement) => ({
    id: placement.id,
    parentId: placement.parentPlacementId,
    siblingOrder: placement.siblingOrder,
  }));
}

export function connectorLabel(connection: MapConnectionViewDto): string | null {
  const parts = [connection.label, connection.relationshipTypeLabel].filter(
    (part): part is string => part !== null,
  );
  if (connection.relationshipTypeLabel !== null && parts.length === 2) {
    return `${parts[0]} (${parts[1]})`;
  }
  return parts[0] ?? null;
}

/**
 * Freeform mode shows stored coordinates. Hierarchical mode computes a deterministic tree layout
 * and never writes it back, so the freeform coordinates stay available for switching back.
 */
export function buildCanvasModel(view: MapViewDto): CanvasModel {
  const childCounts = new Map<string, number>();
  for (const placement of view.placements) {
    if (placement.parentPlacementId !== null) {
      childCounts.set(
        placement.parentPlacementId,
        (childCounts.get(placement.parentPlacementId) ?? 0) + 1,
      );
    }
  }

  if (view.map.mode === 'freeform') {
    return {
      items: view.placements.map((placement) => ({
        placement,
        position: { x: placement.x, y: placement.y },
        childCount: childCounts.get(placement.id) ?? 0,
      })),
      lines: [
        ...connectorLines(view.connections, () => true),
        ...relationshipLines(view, () => true),
      ],
      hiddenCount: 0,
    };
  }

  const layout = layoutTree(
    view.placements.map((placement) => ({
      id: placement.id,
      parentId: placement.parentPlacementId,
      siblingOrder: placement.siblingOrder,
      collapsed: placement.isCollapsed,
    })),
  );
  const visible = (id: string) => layout.positions.has(id);
  const items: CanvasItem[] = [];
  for (const placement of view.placements) {
    const position = layout.positions.get(placement.id);
    if (position !== undefined) {
      items.push({ placement, position, childCount: childCounts.get(placement.id) ?? 0 });
    }
  }
  const hierarchyLines: CanvasLine[] = view.placements
    .filter(
      (placement) =>
        placement.parentPlacementId !== null &&
        visible(placement.id) &&
        visible(placement.parentPlacementId),
    )
    .map((placement) => ({
      id: `hierarchy:${placement.id}`,
      kind: 'hierarchy',
      source: placement.parentPlacementId ?? '',
      target: placement.id,
      label: null,
    }));
  return {
    items,
    lines: [
      ...hierarchyLines,
      ...connectorLines(
        view.connections,
        (c) => visible(c.sourcePlacementId) && visible(c.targetPlacementId),
      ),
      ...relationshipLines(view, visible),
    ],
    hiddenCount: layout.hidden.size,
  };
}

/**
 * Lines for the semantic relationships between nodes on the map. Relationships shown by a linked
 * connector are skipped (no duplicates); the placement of each node gives the line's ends.
 */
function relationshipLines(
  view: MapViewDto,
  visible: (placementId: string) => boolean,
): CanvasLine[] {
  const placementOfNode = new Map(
    view.placements.map((placement) => [placement.nodeId, placement.id]),
  );
  const shownByConnector = new Set(
    view.connections.map((connection) => connection.relationshipId).filter((id) => id !== null),
  );
  const lines: CanvasLine[] = [];
  for (const relationship of view.relationships) {
    if (shownByConnector.has(relationship.id)) continue;
    const source = placementOfNode.get(relationship.sourceNodeId);
    const target = placementOfNode.get(relationship.targetNodeId);
    if (source === undefined || target === undefined || !visible(source) || !visible(target)) {
      continue;
    }
    lines.push({
      id: `relationship:${relationship.id}`,
      kind: 'relationship',
      source,
      target,
      label: relationship.typeLabel,
      directed: relationship.directionality === 'directed',
    });
  }
  return lines;
}

function connectorLines(
  connections: readonly MapConnectionViewDto[],
  include: (connection: MapConnectionViewDto) => boolean,
): CanvasLine[] {
  return connections.filter(include).map((connection) => ({
    id: `connector:${connection.id}`,
    kind: 'connector',
    source: connection.sourcePlacementId,
    target: connection.targetPlacementId,
    label: connectorLabel(connection),
    connection,
  }));
}

export interface OutlineRow {
  readonly placement: PlacementViewDto;
  /** 1-based depth, as used by `aria-level`. */
  readonly level: number;
  readonly hasChildren: boolean;
  /** Position among siblings (1-based) and sibling count, for `aria-posinset`/`aria-setsize`. */
  readonly position: number;
  readonly setSize: number;
}

/**
 * Rows of the outline (the keyboard-accessible list of the map). Hierarchical maps show the tree
 * in display order, skipping children of collapsed items; freeform maps show a flat list sorted
 * by title.
 */
export function buildOutlineRows(view: MapViewDto): OutlineRow[] {
  const byId = new Map(view.placements.map((placement) => [placement.id, placement]));
  if (view.map.mode === 'freeform') {
    const sorted = [...view.placements].sort(
      (a, b) => a.nodeTitle.localeCompare(b.nodeTitle) || (a.id < b.id ? -1 : 1),
    );
    return sorted.map((placement, index) => ({
      placement,
      level: 1,
      hasChildren: false,
      position: index + 1,
      setSize: sorted.length,
    }));
  }

  const childrenOf = childrenIndex(hierarchyItemsOf(view));
  const rows: OutlineRow[] = [];
  // Iterative depth-first walk; the stack holds items in reverse display order.
  const roots = childrenOf.get(null) ?? [];
  const stack = roots
    .map((item, index) => ({ id: item.id, level: 1, position: index + 1, setSize: roots.length }))
    .reverse();
  const visited = new Set<string>();
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined || visited.has(entry.id)) continue;
    visited.add(entry.id);
    const placement = byId.get(entry.id);
    if (placement === undefined) continue;
    const children = childrenOf.get(entry.id) ?? [];
    rows.push({
      placement,
      level: entry.level,
      hasChildren: children.length > 0,
      position: entry.position,
      setSize: entry.setSize,
    });
    if (!placement.isCollapsed) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child === undefined) continue;
        stack.push({
          id: child.id,
          level: entry.level + 1,
          position: index + 1,
          setSize: children.length,
        });
      }
    }
  }
  return rows;
}

export type HierarchyMove = 'up' | 'down' | 'indent' | 'outdent';

export interface ReparentTarget {
  readonly placementId: string;
  readonly parentPlacementId: string | null;
  readonly index: number;
}

/**
 * Where a keyboard move puts an item (PRD §5.6 keyboard alternatives), or null when the move is
 * not possible (first item cannot move up, a root cannot be outdented, and so on).
 * - up/down: swap with the previous/next sibling;
 * - indent: become the last child of the previous sibling;
 * - outdent: become the next sibling of the current parent.
 */
export function planKeyboardMove(
  view: MapViewDto,
  placementId: string,
  move: HierarchyMove,
): ReparentTarget | null {
  const items = hierarchyItemsOf(view);
  const item = items.find((candidate) => candidate.id === placementId);
  if (item === undefined) return null;
  const siblings = orderedChildren(items, item.parentId);
  const index = siblings.findIndex((sibling) => sibling.id === placementId);

  switch (move) {
    case 'up':
      return index > 0 ? { placementId, parentPlacementId: item.parentId, index: index - 1 } : null;
    case 'down':
      return index < siblings.length - 1
        ? { placementId, parentPlacementId: item.parentId, index: index + 1 }
        : null;
    case 'indent': {
      const previous = siblings[index - 1];
      if (previous === undefined) return null;
      return {
        placementId,
        parentPlacementId: previous.id,
        index: orderedChildren(items, previous.id).length,
      };
    }
    case 'outdent': {
      if (item.parentId === null) return null;
      const parent = items.find((candidate) => candidate.id === item.parentId);
      if (parent === undefined) return null;
      const parentIndex = orderedChildren(items, parent.parentId).findIndex(
        (sibling) => sibling.id === parent.id,
      );
      return { placementId, parentPlacementId: parent.parentId, index: parentIndex + 1 };
    }
  }
}

/** A free spot for a new freeform item: right of the right-most item, or the origin. */
export function nextFreeformPosition(view: MapViewDto): { x: number; y: number } {
  if (view.placements.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...view.placements.map((placement) => placement.x));
  const top = Math.min(...view.placements.map((placement) => placement.y));
  return { x: right + 240, y: top };
}

/**
 * Items whose chosen parents lead back to themselves (a loop), sorted by ID. Used to stop the
 * user before submitting an assignment the main process would reject, and to name the items.
 */
export function findParentLoops(parents: ReadonlyMap<string, string | null>): string[] {
  const inLoop = new Set<string>();
  const settled = new Set<string>();
  for (const start of parents.keys()) {
    if (settled.has(start)) continue;
    // Walks up from `start`; meeting an item of the current walk again closes a loop.
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | null | undefined = start;
    while (current !== null && current !== undefined && !settled.has(current)) {
      if (onPath.has(current)) {
        for (const id of path.slice(path.indexOf(current))) inLoop.add(id);
        break;
      }
      path.push(current);
      onPath.add(current);
      current = parents.get(current);
    }
    for (const id of path) settled.add(id);
  }
  return [...inLoop].sort();
}

export interface ParentChoice {
  readonly placementId: string;
  readonly title: string;
  /** 0 for top-level items. */
  readonly depth: number;
}

/**
 * Every item of a hierarchical map in tree order (collapsed branches included), for choosing the
 * parent of a node being added.
 */
export function parentChoices(view: MapViewDto): ParentChoice[] {
  const items = hierarchyItemsOf(view);
  const byId = new Map(view.placements.map((placement) => [placement.id, placement]));
  const choices: ParentChoice[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const item of orderedChildren(items, parentId)) {
      const placement = byId.get(item.id);
      if (placement === undefined) continue;
      choices.push({ placementId: placement.id, title: placement.nodeTitle, depth });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return choices;
}

/** A side of a map item, where a line can attach. */
export type ItemSide = 'left' | 'right' | 'top' | 'bottom';

/** An item's box on the canvas (its position is the top-left corner). */
export interface ItemBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The sides of two items that face each other, where a line between them attaches: right and
 * left when they are further apart side by side, bottom and top when they are further apart one
 * above the other. Gaps between the boxes are compared, not distances between centers, because
 * items are much wider than tall. Overlapping items use left and right.
 */
export function facingSides(from: ItemBox, to: ItemBox): { from: ItemSide; to: ItemSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const gapX = Math.abs(dx) - (from.width + to.width) / 2;
  const gapY = Math.abs(dy) - (from.height + to.height) / 2;
  if (gapY > gapX && gapY > 0) {
    return dy > 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
  }
  return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
}

/**
 * SVG path through an orthogonal route (from automatic layout), with gently rounded corners, and
 * the point halfway along it for a label.
 */
export function routePath(
  points: readonly { readonly x: number; readonly y: number }[],
): [path: string, labelX: number, labelY: number] {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return ['', 0, 0];
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const towards = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    length: number,
  ) => {
    const total = distance(from, to);
    return total === 0
      ? from
      : {
          x: from.x + ((to.x - from.x) * length) / total,
          y: from.y + ((to.y - from.y) * length) / total,
        };
  };
  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1]!;
    const corner = points[index]!;
    const after = points[index + 1]!;
    const radius = Math.min(8, distance(before, corner) / 2, distance(corner, after) / 2);
    const start = towards(corner, before, radius);
    const end = towards(corner, after, radius);
    path += ` L ${start.x} ${start.y} Q ${corner.x} ${corner.y} ${end.x} ${end.y}`;
  }
  path += ` L ${last.x} ${last.y}`;

  // The label sits halfway along the route.
  const lengths = points.slice(1).map((point, index) => distance(points[index]!, point));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length) {
      const at = towards(points[index]!, points[index + 1]!, remaining);
      return [path, at.x, at.y];
    }
    remaining -= length;
  }
  return [path, last.x, last.y];
}

/**
 * The region each item belongs to: the smallest region that contains the item's center (regions
 * may overlap or nest; the most specific one wins). Items outside every region are absent.
 */
export function regionOwners(
  items: readonly { readonly id: string; x: number; y: number; width: number; height: number }[],
  regions: readonly { readonly id: string; x: number; y: number; width: number; height: number }[],
): Map<string, string> {
  const bySize = [...regions].sort(
    (a, b) => a.width * a.height - b.width * b.height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const owners = new Map<string, string>();
  for (const item of items) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    const region = bySize.find(
      (candidate) =>
        cx >= candidate.x &&
        cx <= candidate.x + candidate.width &&
        cy >= candidate.y &&
        cy <= candidate.y + candidate.height,
    );
    if (region !== undefined) owners.set(item.id, region.id);
  }
  return owners;
}
