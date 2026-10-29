/**
 * "Maps as drawn" in the knowledge graph: every mind map is a framed group (a Cytoscape compound
 * node) that shows the map as it is, with its items where they are on the map and its lines
 * (hierarchy lines and connectors) as on the map. Groups are packed in rows; notes on no shown map
 * keep their own arrangement, below the groups.
 *
 * A node can be on several maps, but the graph has one element per node. So the node's first
 * appearance (in group order) is the node itself, with its relationships and note links, and each
 * further appearance is a copy (`copy:<placementId>`) that carries the node's ID in `nodeId` and is
 * joined to the node by a faint `same-node` line. Selecting, opening or finding a copy acts on
 * its node.
 *
 * Regions of a freeform map are frames nested in its group (`region:<id>`), around the items whose
 * center is inside them on the map; a region with no items is not drawn.
 *
 * Pure and unit-tested; the view loads the map views and the canvas draws the result.
 */

import type { MapViewDto } from '@mmap/contracts';

import { buildCanvasModel, regionOwners } from '../maps/map-model';
import type { CytoscapeElement } from './graph-model';

export const GROUP_PREFIX = 'group:';
export const COPY_PREFIX = 'copy:';
export const REGION_PREFIX = 'region:';

/** Region colors on the graph canvas (Cytoscape needs plain color values). */
const REGION_COLORS: Record<string, string> = {
  gray: '#a1a1aa',
  blue: '#3b82f6',
  green: '#16a34a',
  amber: '#f59e0b',
  red: '#ef4444',
  violet: '#8b5cf6',
};

/** Size of a map item, estimated from its title (the map editor measures the real box). */
const ITEM_HEIGHT = 40;
/** Space between groups, and the width after which the next group starts a new row. */
const GROUP_GAP = 160;
const ROW_WIDTH = 2_400;
/** Space between the groups and the notes on no map. */
const LOOSE_GAP = 220;

const TAXI_DIRECTIONS = {
  right: 'rightward',
  down: 'downward',
  left: 'leftward',
  up: 'upward',
} as const;

export function estimatedItemWidth(title: string): number {
  return Math.min(240, Math.max(60, Math.round(title.length * 7.5) + 28));
}

export function groupId(mapId: string): string {
  return `${GROUP_PREFIX}${mapId}`;
}

/** The knowledge node an element stands for: a copy's node, or the element itself. */
export function nodeKeyOf(data: { readonly id?: unknown; readonly nodeId?: unknown }): string {
  return typeof data.nodeId === 'string' ? data.nodeId : String(data.id);
}

export interface MapGroupsResult {
  readonly elements: CytoscapeElement[];
  /** Maps drawn as groups (maps without items are left out); regions are not counted. */
  readonly groupCount: number;
}

/**
 * Elements with the maps drawn as groups. `base` is the graph as usual (`toCytoscapeElements`,
 * without collapsed maps); `views` are the maps to draw, in the order they should appear.
 */
export function withMapGroups(
  base: readonly CytoscapeElement[],
  views: readonly MapViewDto[],
  options: { readonly colors: ReadonlyMap<string, string>; readonly showConnectors: boolean },
): MapGroupsResult {
  const baseNodes = new Map(
    base
      .filter((element) => element.group === 'nodes')
      .map((element) => [String(element.data.id), element]),
  );
  const groups: CytoscapeElement[] = [];
  const items: CytoscapeElement[] = [];
  const lines: CytoscapeElement[] = [];
  /** Nodes already drawn in a group, so their further appearances become copies. */
  const placedNodes = new Set<string>();

  let rowX = 0;
  let rowY = 0;
  let rowHeight = 0;
  let bottom = 0;
  for (const view of views) {
    const model = buildCanvasModel(view);
    if (model.items.length === 0) continue;
    const boxes = model.items.map((item) => ({
      item,
      width: estimatedItemWidth(item.placement.nodeTitle),
    }));
    const minX = Math.min(...boxes.map(({ item }) => item.position.x));
    const minY = Math.min(...boxes.map(({ item }) => item.position.y));
    const width = Math.max(...boxes.map(({ item, width: w }) => item.position.x + w)) - minX;
    const height = Math.max(...boxes.map(({ item }) => item.position.y + ITEM_HEIGHT)) - minY;
    if (rowX > 0 && rowX + width > ROW_WIDTH) {
      rowX = 0;
      rowY += rowHeight + GROUP_GAP;
      rowHeight = 0;
    }
    const offsetX = rowX - minX;
    const offsetY = rowY - minY;
    rowX += width + GROUP_GAP;
    rowHeight = Math.max(rowHeight, height);
    bottom = Math.max(bottom, rowY + height);

    const parent = groupId(view.map.id);
    const color = options.colors.get(view.map.id) ?? '#94a3b8';
    groups.push({
      group: 'nodes',
      data: {
        id: parent,
        label: view.map.title,
        mapId: view.map.id,
        color,
        mapsText: 'Mind map. Double-click to open it.',
      },
      classes: 'map-group',
    });

    // Regions (freeform maps): the frame each item sits in, the smallest one around its center.
    const owners =
      view.map.mode === 'freeform'
        ? regionOwners(
            boxes.map(({ item, width: itemWidth }) => ({
              id: item.placement.id,
              x: item.position.x,
              y: item.position.y,
              width: itemWidth,
              height: ITEM_HEIGHT,
            })),
            view.regions,
          )
        : new Map<string, string>();
    for (const region of view.regions) {
      if (![...owners.values()].includes(region.id)) continue;
      groups.push({
        group: 'nodes',
        data: {
          id: `${REGION_PREFIX}${region.id}`,
          parent,
          label: region.title,
          mapId: view.map.id,
          color: REGION_COLORS[region.color ?? ''] ?? '#94a3b8',
          mapsText: `Region of ${view.map.title}`,
        },
        classes: 'map-region',
      });
    }
    const parentOf = (placementId: string) => {
      const owner = owners.get(placementId);
      return owner === undefined ? parent : `${REGION_PREFIX}${owner}`;
    };

    const elementOf = new Map<string, string>();
    for (const { item, width: itemWidth } of boxes) {
      const { placement } = item;
      const position = {
        x: Math.round(item.position.x + offsetX + itemWidth / 2),
        y: Math.round(item.position.y + offsetY + ITEM_HEIGHT / 2),
      };
      const known = baseNodes.get(placement.nodeId);
      if (!placedNodes.has(placement.nodeId)) {
        placedNodes.add(placement.nodeId);
        elementOf.set(placement.id, placement.nodeId);
        items.push({
          group: 'nodes',
          data: {
            ...(known?.data ?? {
              id: placement.nodeId,
              label: placement.nodeTitle,
              degree: 0,
              mapCount: 1,
              mapsText: view.map.title,
            }),
            parent: parentOf(placement.id),
          },
          position,
          classes: `${known?.classes ?? ''} map-item`.trim(),
        });
      } else {
        const copy = `${COPY_PREFIX}${placement.id}`;
        elementOf.set(placement.id, copy);
        items.push({
          group: 'nodes',
          data: {
            id: copy,
            nodeId: placement.nodeId,
            label: placement.nodeTitle,
            degree: 0,
            mapCount: Number(known?.data.mapCount ?? 1),
            mapsText: String(known?.data.mapsText ?? view.map.title),
            parent: parentOf(placement.id),
          },
          position,
          classes: 'map-item copy',
        });
        lines.push({
          group: 'edges',
          data: { id: `same:${placement.id}`, source: copy, target: placement.nodeId, label: '' },
          classes: 'same-node',
        });
      }
    }

    const taxi =
      view.map.mode === 'hierarchical'
        ? 'rightward'
        : view.map.arrangement === null
          ? null
          : TAXI_DIRECTIONS[view.map.arrangement.direction];
    for (const line of model.lines) {
      if (line.kind === 'relationship') continue;
      if (line.kind === 'connector' && !options.showConnectors) continue;
      const source = elementOf.get(line.source);
      const target = elementOf.get(line.target);
      if (source === undefined || target === undefined) continue;
      const classes = [line.kind === 'hierarchy' ? 'map-line tree' : 'map-line connector'];
      if (taxi !== null) classes.push(`taxi-${taxi}`);
      lines.push({
        group: 'edges',
        data: { id: `map:${line.id}`, source, target, label: line.label ?? '' },
        classes: classes.join(' '),
      });
    }
  }

  // Notes on no shown map keep their arrangement, as a block below the groups.
  const loose = base.filter(
    (element) => element.group === 'nodes' && !placedNodes.has(String(element.data.id)),
  );
  const looseTop = Math.min(...loose.map((element) => element.position?.y ?? 0));
  const looseLeft = Math.min(...loose.map((element) => element.position?.x ?? 0));
  const shiftY = groups.length === 0 ? 0 : bottom + LOOSE_GAP - looseTop;
  const shiftX = groups.length === 0 ? 0 : -looseLeft;
  const looseNodes = loose.map((element) =>
    element.position === undefined
      ? element
      : {
          ...element,
          position: { x: element.position.x + shiftX, y: element.position.y + shiftY },
        },
  );

  // Base edges stay between the nodes themselves. A map connector already drawn in a group is not
  // drawn again as the graph's combined connector line.
  const drawnInGroups = (id: unknown) => placedNodes.has(String(id));
  const baseEdges = base.filter(
    (element) =>
      element.group === 'edges' &&
      !(
        (element.classes ?? '').split(' ').includes('connector') &&
        drawnInGroups(element.data.source) &&
        drawnInGroups(element.data.target)
      ),
  );

  return {
    // Groups first: a compound node must exist before its children are added.
    elements: [...groups, ...items, ...looseNodes, ...lines, ...baseEdges],
    groupCount: groups.filter((element) => element.classes === 'map-group').length,
  };
}
