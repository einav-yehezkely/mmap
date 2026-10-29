/**
 * Automatic layout of a freeform mind map ("Auto layout", ADR-0012). Pure: it takes the items'
 * boxes and the lines between them and returns new positions plus a route for each line; it
 * renders nothing and stores nothing.
 *
 * Two strategies, chosen from the lines:
 * - **Tree** (`layoutTree`), when the lines form a strict hierarchy: every item has at most one
 *   incoming line and there are no cycles. Siblings sit in one row (or column) with even gaps
 *   between their boxes, every parent is centered over its children at every level, subtrees
 *   never overlap, and each line runs from the parent down to a shared branching line and then
 *   to its child. ELK's layered placement does not guarantee centered parents, so trees get this
 *   dedicated, deterministic layout.
 * - **ELK layered** for everything else (cross-links, several parents, two-way links, cycles):
 *   items in layers, crossings minimized, orthogonal routes around items; ELK reverses a few
 *   lines internally to break cycles.
 *
 * Shared rules:
 * - **Directions**: left to right, top to bottom, right to left and bottom to top. Lines leave
 *   from the middle of the item side facing the layout direction and enter the middle of the
 *   opposite side, the same points as the canvas's handles, so routes meet the items exactly.
 * - **Stable**: items are taken in their current reading order, so arranging an arranged map
 *   changes little, and the arranged block keeps the top-left corner of the items it moved.
 * - **Locked items** keep their place; the others are arranged as a block next to them (after
 *   them in the layout direction). Lines to or from locked items are not routed.
 */

import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint } from 'elkjs/lib/elk.bundled.js';

import { regionOwners, type ItemSide } from './map-model';

export type LayoutDirection = 'right' | 'down' | 'left' | 'up';

export interface LayoutItem {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Locked items keep their position. */
  readonly pinned: boolean;
}

export interface LayoutLine {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface LineRoute {
  readonly sourceSide: ItemSide;
  readonly targetSide: ItemSide;
  /** From the middle of the source side to the middle of the target side, bends included. */
  readonly points: readonly ElkPoint[];
}

export interface AutoLayoutResult {
  /** New top-left positions of the items that move (locked items are absent). */
  readonly positions: ReadonlyMap<string, ElkPoint>;
  readonly routes: ReadonlyMap<string, LineRoute>;
  /** Which strategy arranged the map. */
  readonly strategy: 'tree' | 'layered' | 'none';
}

/** Gap between the locked items and the arranged block. */
const PINNED_GAP = 120;
/** Tree spacing: between sibling boxes, between separate trees, and between levels. */
const SIBLING_GAP = 40;
const TREE_GAP = 80;
const LEVEL_GAP = 80;

const DIRECTIONS: Record<
  LayoutDirection,
  { readonly elk: string; readonly out: ItemSide; readonly in: ItemSide }
> = {
  right: { elk: 'RIGHT', out: 'right', in: 'left' },
  down: { elk: 'DOWN', out: 'bottom', in: 'top' },
  left: { elk: 'LEFT', out: 'left', in: 'right' },
  up: { elk: 'UP', out: 'top', in: 'bottom' },
};

const PORT_SIDE: Record<ItemSide, string> = {
  right: 'EAST',
  left: 'WEST',
  top: 'NORTH',
  bottom: 'SOUTH',
};

/** ELK options: layered, orthogonal routes, even spacing, crossings minimized, order kept. */
const LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '90',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '14',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.spacing.componentComponent': '70',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  // Balanced alignment centers items between their neighbors as far as the graph allows.
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
};

const elk = new ELK();

/** A layout before it is placed on the map: coordinates start near (0, 0). */
interface RawLayout {
  readonly positions: Map<string, ElkPoint>;
  readonly routes: Map<string, LineRoute>;
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Middle of an item's side, relative to the item's top-left corner. */
function sideMiddle(side: ItemSide, width: number, height: number): ElkPoint {
  switch (side) {
    case 'right':
      return { x: width, y: height / 2 };
    case 'left':
      return { x: 0, y: height / 2 };
    case 'top':
      return { x: width / 2, y: 0 };
    case 'bottom':
      return { x: width / 2, y: height };
  }
}

function bounds(boxes: readonly { x: number; y: number; width: number; height: number }[]) {
  return {
    minX: Math.min(...boxes.map((box) => box.x)),
    minY: Math.min(...boxes.map((box) => box.y)),
    maxX: Math.max(...boxes.map((box) => box.x + box.width)),
    maxY: Math.max(...boxes.map((box) => box.y + box.height)),
  };
}

/**
 * True when the lines form a strict hierarchy (a forest): no item has two incoming lines and
 * following lines never leads back to an item. Parallel lines between the same two items count
 * once.
 */
export function isStrictHierarchy(
  items: readonly { readonly id: string }[],
  lines: readonly LayoutLine[],
): boolean {
  const parentOf = new Map<string, string>();
  for (const line of lines) {
    const existing = parentOf.get(line.target);
    if (existing !== undefined && existing !== line.source) return false;
    parentOf.set(line.target, line.source);
  }
  for (const item of items) {
    const seen = new Set<string>([item.id]);
    let current = parentOf.get(item.id);
    while (current !== undefined) {
      if (seen.has(current)) return false;
      seen.add(current);
      current = parentOf.get(current);
    }
  }
  return true;
}

/**
 * Tidy tree layout. Computed with a "cross" axis (along which siblings are spread) and a "main"
 * axis (from parent level to child level), then turned into x and y for the direction.
 */
function layoutTree(
  items: readonly LayoutItem[],
  lines: readonly LayoutLine[],
  direction: LayoutDirection,
): RawLayout {
  const vertical = direction === 'down' || direction === 'up';
  const crossSize = (item: LayoutItem) => (vertical ? item.width : item.height);
  const mainSize = (item: LayoutItem) => (vertical ? item.height : item.width);
  const crossOf = (item: LayoutItem) => (vertical ? item.x : item.y);
  const byId = new Map(items.map((item) => [item.id, item]));

  const children = new Map<string, LayoutItem[]>();
  const hasParent = new Set<string>();
  for (const line of lines) {
    if (hasParent.has(line.target)) continue;
    hasParent.add(line.target);
    const child = byId.get(line.target);
    if (child === undefined) continue;
    children.set(line.source, [...(children.get(line.source) ?? []), child]);
  }
  // Siblings keep their current order along the cross axis.
  const order = (a: LayoutItem, b: LayoutItem) => crossOf(a) - crossOf(b) || compareIds(a.id, b.id);
  for (const list of children.values()) list.sort(order);
  const roots = items.filter((item) => !hasParent.has(item.id)).sort(order);

  // Depth of each item, and the main-axis extent of each level (its tallest item).
  const depth = new Map<string, number>();
  const levelSize: number[] = [];
  const visit = (item: LayoutItem, level: number) => {
    depth.set(item.id, level);
    levelSize[level] = Math.max(levelSize[level] ?? 0, mainSize(item));
    for (const child of children.get(item.id) ?? []) visit(child, level + 1);
  };
  for (const root of roots) visit(root, 0);
  const levelStart: number[] = [];
  let main = 0;
  for (const size of levelSize) {
    levelStart.push(main);
    main += size + LEVEL_GAP;
  }

  // Width of each subtree along the cross axis: its children side by side, or the item itself.
  const span = new Map<string, number>();
  const measure = (item: LayoutItem): number => {
    const kids = children.get(item.id) ?? [];
    const kidsSpan =
      kids.reduce((sum, child) => sum + measure(child), 0) +
      SIBLING_GAP * Math.max(0, kids.length - 1);
    const value = Math.max(crossSize(item), kidsSpan);
    span.set(item.id, value);
    return value;
  };
  for (const root of roots) measure(root);

  // Cross positions: children in one row centered in the subtree, the parent centered over the
  // boxes of its children (kept inside its own subtree, so it never overlaps a neighbor).
  const cross = new Map<string, number>();
  const place = (item: LayoutItem, start: number) => {
    const total = span.get(item.id)!;
    const kids = children.get(item.id) ?? [];
    if (kids.length === 0) {
      cross.set(item.id, start + (total - crossSize(item)) / 2);
      return;
    }
    const kidsSpan =
      kids.reduce((sum, child) => sum + span.get(child.id)!, 0) + SIBLING_GAP * (kids.length - 1);
    let offset = start + (total - kidsSpan) / 2;
    for (const child of kids) {
      place(child, offset);
      offset += span.get(child.id)! + SIBLING_GAP;
    }
    const first = kids[0]!;
    const last = kids.at(-1)!;
    const center = (cross.get(first.id)! + cross.get(last.id)! + crossSize(last)) / 2;
    const wanted = center - crossSize(item) / 2;
    cross.set(item.id, Math.min(Math.max(wanted, start), start + total - crossSize(item)));
  };
  let rootStart = 0;
  for (const root of roots) {
    place(root, rootStart);
    rootStart += span.get(root.id)! + TREE_GAP;
  }

  // Into x and y. Bottom-to-top and right-to-left mirror the main axis.
  const totalMain = main - LEVEL_GAP;
  const mainOf = (item: LayoutItem) => {
    const level = depth.get(item.id)!;
    const start = levelStart[level]!;
    // Items smaller than their level are aligned to the parent side of the level.
    return direction === 'down' || direction === 'right'
      ? start
      : totalMain - start - mainSize(item);
  };
  const toPoint = (crossValue: number, mainValue: number): ElkPoint =>
    vertical ? { x: crossValue, y: mainValue } : { x: mainValue, y: crossValue };
  const positions = new Map<string, ElkPoint>();
  for (const item of items) positions.set(item.id, toPoint(cross.get(item.id)!, mainOf(item)));

  // Routes: from the parent's side down to a branching line halfway to the child level, along
  // it, then into the child. Siblings share the branching line.
  const sides = DIRECTIONS[direction];
  const attach = (item: LayoutItem, side: ItemSide): ElkPoint => {
    const at = positions.get(item.id)!;
    const offset = sideMiddle(side, item.width, item.height);
    return { x: at.x + offset.x, y: at.y + offset.y };
  };
  const routes = new Map<string, LineRoute>();
  for (const line of lines) {
    const parent = byId.get(line.source);
    const child = byId.get(line.target);
    if (parent === undefined || child === undefined) continue;
    const from = attach(parent, sides.out);
    const to = attach(child, sides.in);
    const fromMain = vertical ? from.y : from.x;
    const toMain = vertical ? to.y : to.x;
    const branch = (fromMain + toMain) / 2;
    const fromCross = vertical ? from.x : from.y;
    const toCross = vertical ? to.x : to.y;
    const points =
      Math.abs(fromCross - toCross) < 0.5
        ? [from, to]
        : [from, toPoint(fromCross, branch), toPoint(toCross, branch), to];
    routes.set(line.id, { sourceSide: sides.out, targetSide: sides.in, points });
  }
  return { positions, routes };
}

async function layoutLayered(
  items: readonly LayoutItem[],
  lines: readonly LayoutLine[],
  direction: LayoutDirection,
): Promise<RawLayout> {
  const sides = DIRECTIONS[direction];
  const graph: ElkNode = {
    id: 'map',
    layoutOptions: { ...LAYOUT_OPTIONS, 'elk.direction': sides.elk },
    children: items.map((item) => {
      const out = sideMiddle(sides.out, item.width, item.height);
      const into = sideMiddle(sides.in, item.width, item.height);
      return {
        id: item.id,
        width: item.width,
        height: item.height,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [
          {
            id: `${item.id}:out`,
            ...out,
            width: 0,
            height: 0,
            layoutOptions: { 'elk.port.side': PORT_SIDE[sides.out] },
          },
          {
            id: `${item.id}:in`,
            ...into,
            width: 0,
            height: 0,
            layoutOptions: { 'elk.port.side': PORT_SIDE[sides.in] },
          },
        ],
      };
    }),
    edges: lines.map((line): ElkExtendedEdge => ({
      id: line.id,
      sources: [`${line.source}:out`],
      targets: [`${line.target}:in`],
    })),
  };
  const laidOut = await elk.layout(graph);
  const positions = new Map<string, ElkPoint>();
  for (const child of laidOut.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  const routes = new Map<string, LineRoute>();
  for (const edge of laidOut.edges ?? []) {
    const section = edge.sections?.[0];
    if (section === undefined) continue;
    routes.set(edge.id, {
      sourceSide: sides.out,
      targetSide: sides.in,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    });
  }
  return { positions, routes };
}

export async function computeAutoLayout(
  items: readonly LayoutItem[],
  lines: readonly LayoutLine[],
  direction: LayoutDirection,
): Promise<AutoLayoutResult> {
  const movable = items
    .filter((item) => !item.pinned)
    .sort((a, b) => a.y - b.y || a.x - b.x || compareIds(a.id, b.id));
  if (movable.length === 0) return { positions: new Map(), routes: new Map(), strategy: 'none' };
  const movableIds = new Set(movable.map((item) => item.id));
  const routed = lines
    .filter(
      (line) =>
        line.source !== line.target && movableIds.has(line.source) && movableIds.has(line.target),
    )
    .sort((a, b) => compareIds(a.id, b.id));

  const tree = isStrictHierarchy(movable, routed);
  const raw = tree
    ? layoutTree(movable, routed, direction)
    : await layoutLayered(movable, routed, direction);

  // The block is measured from its items (ELK adds padding around the graph).
  const sizes = new Map(movable.map((item) => [item.id, item]));
  const placedBoxes = [...raw.positions].map(([id, point]) => ({
    ...point,
    width: sizes.get(id)!.width,
    height: sizes.get(id)!.height,
  }));
  const block = bounds(placedBoxes);
  const blockWidth = block.maxX - block.minX;
  const blockHeight = block.maxY - block.minY;

  // Where the arranged block goes: after the locked items, or where the moved items were.
  const pinned = items.filter((item) => item.pinned);
  let originX: number;
  let originY: number;
  if (pinned.length > 0) {
    const box = bounds(pinned);
    if (direction === 'right') [originX, originY] = [box.maxX + PINNED_GAP, box.minY];
    else if (direction === 'down') [originX, originY] = [box.minX, box.maxY + PINNED_GAP];
    else if (direction === 'left')
      [originX, originY] = [box.minX - PINNED_GAP - blockWidth, box.minY];
    else [originX, originY] = [box.minX, box.minY - PINNED_GAP - blockHeight];
  } else {
    const box = bounds(movable);
    [originX, originY] = [box.minX, box.minY];
  }
  const shift = (point: ElkPoint): ElkPoint => ({
    x: Math.round(point.x - block.minX + originX),
    y: Math.round(point.y - block.minY + originY),
  });

  const positions = new Map<string, ElkPoint>();
  for (const [id, point] of raw.positions) positions.set(id, shift(point));
  const routes = new Map<string, LineRoute>();
  for (const [id, route] of raw.routes) {
    routes.set(id, { ...route, points: route.points.map(shift) });
  }
  return { positions, routes, strategy: tree ? 'tree' : 'layered' };
}

/** A region of the map (see `regionOwners`): a rectangle that keeps its items together. */
export interface LayoutRegion {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RegionLayoutResult extends AutoLayoutResult {
  /** New bounds of the regions that were arranged (regions left in place are absent). */
  readonly regions: ReadonlyMap<string, RegionBox>;
}

/** Space inside a region around its items, and above them for the region's title. */
const REGION_PADDING = 32;
const REGION_TITLE_SPACE = 40;
const REGION_PREFIX = 'region:';

/**
 * Automatic layout of a map with regions. Each region's items are arranged inside it first (the
 * region then fits them, with room for its title), and the map is then arranged with every region
 * as one block, so subjects stay together. A region with a locked item, or with no items, stays
 * exactly as it is. Lines inside a region keep their routes; lines between regions are not routed
 * (they are drawn as ordinary curves).
 */
export async function computeLayoutWithRegions(
  items: readonly LayoutItem[],
  lines: readonly LayoutLine[],
  regions: readonly LayoutRegion[],
  direction: LayoutDirection,
): Promise<RegionLayoutResult> {
  if (regions.length === 0) {
    return { ...(await computeAutoLayout(items, lines, direction)), regions: new Map() };
  }
  const owners = regionOwners(items, regions);
  const members = new Map<string, LayoutItem[]>();
  for (const item of items) {
    const owner = owners.get(item.id);
    if (owner !== undefined) members.set(owner, [...(members.get(owner) ?? []), item]);
  }

  // Inside each region.
  const blocks: LayoutItem[] = [];
  const inner = new Map<
    string,
    { readonly result: AutoLayoutResult; readonly minX: number; readonly minY: number }
  >();
  for (const region of regions) {
    const inside = members.get(region.id) ?? [];
    const fixed = inside.length === 0 || inside.some((item) => item.pinned);
    const blockId = `${REGION_PREFIX}${region.id}`;
    if (fixed) {
      blocks.push({ ...region, id: blockId, pinned: true });
      continue;
    }
    const ids = new Set(inside.map((item) => item.id));
    const result = await computeAutoLayout(
      inside,
      lines.filter((line) => ids.has(line.source) && ids.has(line.target)),
      direction,
    );
    const placed = inside.map((item) => ({ ...item, ...(result.positions.get(item.id) ?? item) }));
    const box = bounds(placed);
    inner.set(region.id, { result, minX: box.minX, minY: box.minY });
    blocks.push({
      id: blockId,
      x: region.x,
      y: region.y,
      width: box.maxX - box.minX + 2 * REGION_PADDING,
      height: box.maxY - box.minY + REGION_PADDING + REGION_TITLE_SPACE,
      pinned: false,
    });
  }

  // The whole map, with each region as one block.
  const blockOf = (id: string) => {
    const owner = owners.get(id);
    return owner === undefined ? id : `${REGION_PREFIX}${owner}`;
  };
  const topItems = [...blocks, ...items.filter((item) => !owners.has(item.id))];
  const topLines = lines
    .map((line) => ({ ...line, source: blockOf(line.source), target: blockOf(line.target) }))
    .filter((line) => line.source !== line.target);
  const top = await computeAutoLayout(topItems, topLines, direction);

  const positions = new Map<string, ElkPoint>();
  const routes = new Map<string, LineRoute>();
  const regionBoxes = new Map<string, RegionBox>();
  for (const item of items) {
    if (!owners.has(item.id)) {
      const point = top.positions.get(item.id);
      if (point !== undefined) positions.set(item.id, point);
    }
  }
  // Routes between items outside regions are kept as computed.
  for (const line of lines) {
    if (owners.has(line.source) || owners.has(line.target)) continue;
    const route = top.routes.get(line.id);
    if (route !== undefined) routes.set(line.id, route);
  }
  for (const block of blocks) {
    const regionId = block.id.slice(REGION_PREFIX.length);
    const arranged = inner.get(regionId);
    const corner = top.positions.get(block.id);
    if (arranged === undefined || corner === undefined) continue;
    regionBoxes.set(regionId, {
      x: corner.x,
      y: corner.y,
      width: block.width,
      height: block.height,
    });
    const shift = (point: ElkPoint): ElkPoint => ({
      x: Math.round(point.x - arranged.minX + corner.x + REGION_PADDING),
      y: Math.round(point.y - arranged.minY + corner.y + REGION_TITLE_SPACE),
    });
    for (const [id, point] of arranged.result.positions) positions.set(id, shift(point));
    for (const [id, route] of arranged.result.routes) {
      routes.set(id, { ...route, points: route.points.map(shift) });
    }
  }
  return { positions, routes, regions: regionBoxes, strategy: top.strategy };
}
