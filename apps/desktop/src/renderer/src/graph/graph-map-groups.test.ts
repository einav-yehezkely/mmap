/**
 * "Maps as drawn" in the knowledge graph: maps as groups, copies of shared nodes, map lines, and
 * notes on no map below the groups.
 */

import type { MapViewDto, PlacementViewDto } from '@mmap/contracts';
import { describe, expect, it } from 'vitest';

import type { CytoscapeElement } from './graph-model';
import { estimatedItemWidth, groupId, nodeKeyOf, withMapGroups } from './graph-map-groups';

/** IDs are readable words padded into UUID shape. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NODE = { motherboard: uuid(1), cpu: uuid(2), ram: uuid(3), loose: uuid(4), other: uuid(5) };

function placement(
  id: number,
  nodeId: string,
  title: string,
  x: number,
  y: number,
  parent: number | null = null,
): PlacementViewDto {
  return {
    id: uuid(100 + id),
    nodeId,
    nodeTitle: title,
    x,
    y,
    parentPlacementId: parent === null ? null : uuid(100 + parent),
    siblingOrder: id,
    isCollapsed: false,
    color: null,
    pinned: false,
  };
}

function map(
  n: number,
  title: string,
  mode: 'freeform' | 'hierarchical',
  placements: PlacementViewDto[],
  connections: [number, number][] = [],
  arrangement: MapViewDto['map']['arrangement'] = null,
): MapViewDto {
  return {
    map: {
      id: uuid(200 + n),
      title,
      mode,
      viewport: { x: 0, y: 0, zoom: 1 },
      arrangement,
      revision: 1,
      updatedAt: '2026-10-29T12:00:00.000Z',
    },
    placements,
    connections: connections.map(([from, to], index) => ({
      id: uuid(300 + n * 10 + index),
      sourcePlacementId: uuid(100 + from),
      targetPlacementId: uuid(100 + to),
      label: null,
      relationshipId: null,
      relationshipTypeLabel: null,
    })),
    relationships: [],
    regions: [],
  };
}

const node = (id: string, label: string, x = 0, y = 0): CytoscapeElement => ({
  group: 'nodes',
  data: { id, label, degree: 1, mapCount: 1, mapsText: 'PC' },
  position: { x, y },
  classes: '',
});

const BASE: CytoscapeElement[] = [
  node(NODE.motherboard, 'Motherboard', 900, 900),
  node(NODE.cpu, 'CPU', 950, 950),
  node(NODE.ram, 'RAM'),
  node(NODE.loose, 'Loose', 500, 40),
  node(NODE.other, 'Other', 560, 100),
  {
    group: 'edges',
    data: { id: 'relationship:r1', source: NODE.loose, target: NODE.cpu, label: 'uses' },
    classes: 'directed',
  },
  {
    group: 'edges',
    data: {
      id: `connector:${NODE.motherboard}>${NODE.cpu}`,
      source: NODE.motherboard,
      target: NODE.cpu,
      label: '',
    },
    classes: 'connector',
  },
];

const PC = map(
  1,
  'PC',
  'freeform',
  [
    placement(1, NODE.motherboard, 'Motherboard', 100, 0),
    placement(2, NODE.cpu, 'CPU', 0, 120),
    placement(3, NODE.ram, 'RAM', 200, 120),
  ],
  [
    [1, 2],
    [1, 3],
  ],
  { direction: 'down', placed: [], routes: [] },
);
const STUDY = map(2, 'Study', 'hierarchical', [
  placement(11, NODE.cpu, 'CPU', 0, 0),
  placement(12, NODE.ram, 'RAM', 0, 0, 11),
]);

const options = { colors: new Map<string, string>(), showConnectors: true };
const byId = (elements: CytoscapeElement[]) =>
  new Map(elements.map((element) => [String(element.data.id), element]));

describe('withMapGroups', () => {
  it('draws each map as a group with its items where they are on the map', () => {
    const { elements, groupCount } = withMapGroups(BASE, [PC], options);
    const all = byId(elements);

    expect(groupCount).toBe(1);
    expect(all.get(groupId(PC.map.id))).toMatchObject({
      data: { label: 'PC' },
      classes: 'map-group',
    });
    // Items keep the map's relative layout (centers of the estimated boxes).
    const motherboard = all.get(NODE.motherboard)!;
    const cpu = all.get(NODE.cpu)!;
    expect(motherboard.data.parent).toBe(groupId(PC.map.id));
    expect(cpu.position!.y - motherboard.position!.y).toBe(120);
    expect(
      Math.abs(
        cpu.position!.x -
          motherboard.position!.x -
          (-100 + (estimatedItemWidth('CPU') - estimatedItemWidth('Motherboard')) / 2),
      ),
    ).toBeLessThanOrEqual(1);
    // The node keeps its graph data (badges, tooltip) and becomes a map item.
    expect(motherboard).toMatchObject({ data: { mapsText: 'PC' }, classes: 'map-item' });
    // The map's connectors are drawn in the group, branching downward like the arranged map; the
    // graph's combined connector line is not drawn again.
    expect(elements.filter((element) => (element.classes ?? '').includes('map-line'))).toHaveLength(
      2,
    );
    expect(all.get(`map:connector:${PC.connections[0]!.id}`)?.classes).toBe(
      'map-line connector taxi-downward',
    );
    expect(all.has(`connector:${NODE.motherboard}>${NODE.cpu}`)).toBe(false);
    // Relationships stay between the nodes.
    expect(all.get('relationship:r1')).toMatchObject({
      data: { source: NODE.loose, target: NODE.cpu },
    });
  });

  it('draws a node on several maps once, with linked copies in the other groups', () => {
    const { elements } = withMapGroups(BASE, [PC, STUDY], options);
    const all = byId(elements);
    const copy = all.get(`copy:${uuid(111)}`)!;

    expect(all.get(NODE.cpu)!.data.parent).toBe(groupId(PC.map.id));
    expect(copy).toMatchObject({
      data: { nodeId: NODE.cpu, label: 'CPU', parent: groupId(STUDY.map.id) },
      classes: 'map-item copy',
    });
    expect(nodeKeyOf(copy.data)).toBe(NODE.cpu);
    expect(all.get(`same:${uuid(111)}`)).toMatchObject({
      data: { source: `copy:${uuid(111)}`, target: NODE.cpu },
      classes: 'same-node',
    });
    // Hierarchy lines join the copies inside the hierarchy map's group.
    expect(all.get(`map:hierarchy:${uuid(112)}`)).toMatchObject({
      data: { source: `copy:${uuid(111)}`, target: `copy:${uuid(112)}` },
      classes: 'map-line tree taxi-rightward',
    });
    // Groups are side by side without overlapping.
    const pcRight = Math.max(
      ...[NODE.motherboard, NODE.cpu, NODE.ram].map((id) => all.get(id)!.position!.x),
    );
    expect(copy.position!.x).toBeGreaterThan(pcRight + 100);
  });

  it('keeps notes on no map in their arrangement, below the groups', () => {
    const { elements } = withMapGroups(BASE, [PC], options);
    const all = byId(elements);
    const loose = all.get(NODE.loose)!;
    const other = all.get(NODE.other)!;
    const groupBottom = Math.max(...[NODE.cpu, NODE.ram].map((id) => all.get(id)!.position!.y));

    expect(loose.data.parent).toBeUndefined();
    expect(loose.position!.y).toBeGreaterThan(groupBottom + 100);
    expect({
      dx: other.position!.x - loose.position!.x,
      dy: other.position!.y - loose.position!.y,
    }).toEqual({
      dx: 60,
      dy: 60,
    });
  });

  it('leaves out connectors when hidden, empty maps, and groups first for Cytoscape', () => {
    const empty = map(3, 'Empty', 'freeform', []);
    const { elements, groupCount } = withMapGroups(BASE, [empty, PC], {
      ...options,
      showConnectors: false,
    });

    expect(groupCount).toBe(1);
    expect(elements[0]!.classes).toBe('map-group');
    expect(elements.some((element) => (element.classes ?? '').includes('map-line'))).toBe(false);
  });

  it('nests regions in their map, around the items inside them on the map', () => {
    const withRegions: MapViewDto = {
      ...PC,
      regions: [
        {
          id: uuid(401),
          title: 'Processing',
          color: 'blue',
          x: -20,
          y: 100,
          width: 140,
          height: 80,
        },
        { id: uuid(402), title: 'Empty', color: null, x: 5_000, y: 5_000, width: 100, height: 100 },
      ],
    };
    const { elements, groupCount } = withMapGroups(BASE, [withRegions], options);
    const all = byId(elements);
    const processing = `region:${uuid(401)}`;

    expect(groupCount).toBe(1);
    expect(all.get(processing)).toMatchObject({
      data: { label: 'Processing', parent: groupId(PC.map.id), color: '#3b82f6' },
      classes: 'map-region',
    });
    // CPU is inside the region; the motherboard and RAM are not.
    expect(all.get(NODE.cpu)!.data.parent).toBe(processing);
    expect(all.get(NODE.motherboard)!.data.parent).toBe(groupId(PC.map.id));
    expect(all.get(NODE.ram)!.data.parent).toBe(groupId(PC.map.id));
    // A region with no items is not drawn.
    expect(all.has(`region:${uuid(402)}`)).toBe(false);
    // Frames come before the items they contain.
    const order = elements.map((element) => String(element.data.id));
    expect(order.indexOf(processing)).toBeLessThan(order.indexOf(NODE.cpu));
  });

  it('changes nothing without maps', () => {
    expect(withMapGroups(BASE, [], options).elements).toEqual(BASE);
  });
});
