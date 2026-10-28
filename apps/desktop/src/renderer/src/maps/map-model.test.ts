/**
 * Canvas and outline model of a map, and keyboard moves within a hierarchy (PRD §5.6).
 */

import type { MapViewDto, PlacementViewDto } from '@mmap/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildCanvasModel,
  buildOutlineRows,
  connectorLabel,
  facingSides,
  findParentLoops,
  nextFreeformPosition,
  parentChoices,
  planKeyboardMove,
} from './map-model';

/** Placement IDs are readable letters padded into UUID shape. */
const id = (letter: string) => `00000000-0000-4000-8000-${letter.repeat(12)}`;

function placement(
  letter: string,
  parent: string | null,
  siblingOrder: number,
  extra: Partial<PlacementViewDto> = {},
): PlacementViewDto {
  return {
    id: id(letter),
    nodeId: id(letter.toUpperCase() === letter ? letter.toLowerCase() : letter.toUpperCase()),
    nodeTitle: `Item ${letter}`,
    x: siblingOrder * 10,
    y: 5,
    parentPlacementId: parent === null ? null : id(parent),
    siblingOrder,
    isCollapsed: false,
    color: null,
    ...extra,
  };
}

function mapView(
  mode: 'freeform' | 'hierarchical',
  placements: PlacementViewDto[],
  connections: MapViewDto['connections'] = [],
  relationships: MapViewDto['relationships'] = [],
): MapViewDto {
  return {
    map: {
      id: id('f'),
      title: 'Map',
      mode,
      viewport: { x: 0, y: 0, zoom: 1 },
      revision: 1,
      updatedAt: '2026-10-27T12:00:00.000Z',
    },
    placements,
    connections,
    relationships,
  };
}

// a ─┬─ b ── d
//    └─ c
const TREE = [
  placement('a', null, 0),
  placement('b', 'a', 0),
  placement('c', 'a', 1),
  placement('d', 'b', 0),
];

describe('buildCanvasModel', () => {
  it('uses stored coordinates and connectors only in freeform mode', () => {
    const view = mapView('freeform', TREE, [
      {
        id: id('e'),
        sourcePlacementId: id('d'),
        targetPlacementId: id('a'),
        label: null,
        relationshipId: null,
        relationshipTypeLabel: null,
      },
    ]);
    const model = buildCanvasModel(view);

    expect(model.items.find((item) => item.placement.id === id('c'))?.position).toEqual({
      x: 10,
      y: 5,
    });
    expect(model.lines).toEqual([
      {
        id: `connector:${id('e')}`,
        kind: 'connector',
        source: id('d'),
        target: id('a'),
        label: null,
        connection: view.connections[0],
      },
    ]);
  });

  it('lays out the tree in hierarchical mode without changing stored coordinates', () => {
    const view = mapView('hierarchical', TREE);
    const model = buildCanvasModel(view);

    const x = (letter: string) =>
      model.items.find((item) => item.placement.id === id(letter))?.position.x;
    expect([x('a'), x('b'), x('d')]).toEqual([0, 260, 520]);
    expect(model.lines.map((line) => [line.kind, line.target])).toEqual([
      ['hierarchy', id('b')],
      ['hierarchy', id('c')],
      ['hierarchy', id('d')],
    ]);
    expect(view.placements[1]?.x).toBe(0);
  });

  it('hides collapsed subtrees with their lines', () => {
    const view = mapView('hierarchical', [
      placement('a', null, 0),
      placement('b', 'a', 0, { isCollapsed: true }),
      placement('c', 'a', 1),
      placement('d', 'b', 0),
    ]);
    const model = buildCanvasModel(view);

    expect(model.items.map((item) => item.placement.id)).not.toContain(id('d'));
    expect(model.lines.map((line) => line.target)).not.toContain(id('d'));
    expect(model.hiddenCount).toBe(1);
    expect(model.items.find((item) => item.placement.id === id('b'))?.childCount).toBe(1);
  });
});

describe('connectorLabel', () => {
  it('names the referenced relationship type next to the label', () => {
    const base = {
      id: id('e'),
      sourcePlacementId: id('a'),
      targetPlacementId: id('b'),
      relationshipId: null,
    };
    expect(connectorLabel({ ...base, label: 'see', relationshipTypeLabel: null })).toBe('see');
    expect(connectorLabel({ ...base, label: null, relationshipTypeLabel: 'depends on' })).toBe(
      'depends on',
    );
    expect(connectorLabel({ ...base, label: 'see', relationshipTypeLabel: 'depends on' })).toBe(
      'see (depends on)',
    );
  });
});

describe('buildOutlineRows', () => {
  it('lists the tree depth-first with ARIA positions, skipping collapsed children', () => {
    const rows = buildOutlineRows(mapView('hierarchical', TREE));
    expect(
      rows.map((row) => [row.placement.nodeTitle, row.level, row.position, row.setSize]),
    ).toEqual([
      ['Item a', 1, 1, 1],
      ['Item b', 2, 1, 2],
      ['Item d', 3, 1, 1],
      ['Item c', 2, 2, 2],
    ]);

    const collapsed = buildOutlineRows(
      mapView(
        'hierarchical',
        TREE.map((item) => (item.id === id('b') ? { ...item, isCollapsed: true } : item)),
      ),
    );
    expect(collapsed.map((row) => row.placement.nodeTitle)).toEqual(['Item a', 'Item b', 'Item c']);
  });

  it('lists freeform items by title', () => {
    const rows = buildOutlineRows(mapView('freeform', [...TREE].reverse()));
    expect(rows.map((row) => row.placement.nodeTitle)).toEqual([
      'Item a',
      'Item b',
      'Item c',
      'Item d',
    ]);
    expect(rows.every((row) => row.level === 1 && !row.hasChildren)).toBe(true);
  });
});

describe('planKeyboardMove', () => {
  const view = mapView('hierarchical', TREE);

  it('moves among siblings', () => {
    expect(planKeyboardMove(view, id('c'), 'up')).toEqual({
      placementId: id('c'),
      parentPlacementId: id('a'),
      index: 0,
    });
    expect(planKeyboardMove(view, id('b'), 'down')).toEqual({
      placementId: id('b'),
      parentPlacementId: id('a'),
      index: 1,
    });
    expect(planKeyboardMove(view, id('b'), 'up')).toBeNull();
    expect(planKeyboardMove(view, id('c'), 'down')).toBeNull();
  });

  it('indents under the previous sibling, after its children', () => {
    expect(planKeyboardMove(view, id('c'), 'indent')).toEqual({
      placementId: id('c'),
      parentPlacementId: id('b'),
      index: 1,
    });
    expect(planKeyboardMove(view, id('b'), 'indent')).toBeNull();
  });

  it('outdents to just after the parent', () => {
    expect(planKeyboardMove(view, id('d'), 'outdent')).toEqual({
      placementId: id('d'),
      parentPlacementId: id('a'),
      index: 1,
    });
    expect(planKeyboardMove(view, id('b'), 'outdent')).toEqual({
      placementId: id('b'),
      parentPlacementId: null,
      index: 1,
    });
    expect(planKeyboardMove(view, id('a'), 'outdent')).toBeNull();
  });
});

describe('nextFreeformPosition', () => {
  it('places new items to the right of existing ones', () => {
    expect(nextFreeformPosition(mapView('freeform', []))).toEqual({ x: 0, y: 0 });
    expect(nextFreeformPosition(mapView('freeform', TREE))).toEqual({ x: 250, y: 5 });
  });
});

describe('findParentLoops', () => {
  it('names every item on a loop and nothing else', () => {
    const parents = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['d', 'a'],
      ['e', null],
      ['f', 'f'],
    ]);
    expect(findParentLoops(parents)).toEqual(['a', 'b', 'c', 'f']);
  });

  it('accepts a forest', () => {
    expect(
      findParentLoops(
        new Map([
          ['a', null],
          ['b', 'a'],
          ['c', 'b'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('semantic relationships on the map', () => {
  const relationship = (
    key: string,
    source: string,
    target: string,
    directionality: 'directed' | 'undirected' = 'directed',
  ) => ({
    id: id(key),
    sourceNodeId: placement(source, null, 0).nodeId,
    targetNodeId: placement(target, null, 0).nodeId,
    typeLabel: directionality === 'directed' ? 'explains' : 'related to',
    directionality,
  });

  it('draws relationships between items with their type and direction', () => {
    const view = mapView(
      'freeform',
      [placement('a', null, 0), placement('b', null, 1)],
      [],
      [relationship('r', 'a', 'b'), relationship('s', 'b', 'a', 'undirected')],
    );
    const lines = buildCanvasModel(view).lines.filter((line) => line.kind === 'relationship');
    expect(lines).toEqual([
      {
        id: `relationship:${id('r')}`,
        kind: 'relationship',
        source: id('a'),
        target: id('b'),
        label: 'explains',
        directed: true,
      },
      {
        id: `relationship:${id('s')}`,
        kind: 'relationship',
        source: id('b'),
        target: id('a'),
        label: 'related to',
        directed: false,
      },
    ]);
  });

  it('does not draw a relationship twice when a connector already shows it', () => {
    const view = mapView(
      'freeform',
      [placement('a', null, 0), placement('b', null, 1)],
      [
        {
          id: id('c'),
          sourcePlacementId: id('a'),
          targetPlacementId: id('b'),
          label: null,
          relationshipId: id('r'),
          relationshipTypeLabel: 'explains',
        },
      ],
      [relationship('r', 'a', 'b')],
    );
    const kinds = buildCanvasModel(view).lines.map((line) => line.kind);
    expect(kinds).toEqual(['connector']);
  });

  it('leaves the hierarchy and positions unchanged, and hides lines to collapsed items', () => {
    const placements = [
      placement('a', null, 0, { isCollapsed: true }),
      placement('b', 'a', 0),
      placement('c', null, 1),
    ];
    const without = buildCanvasModel(mapView('hierarchical', placements));
    const withRelationships = buildCanvasModel(
      mapView(
        'hierarchical',
        placements,
        [],
        [relationship('r', 'a', 'c'), relationship('s', 'b', 'c')],
      ),
    );
    expect(withRelationships.items).toEqual(without.items);
    expect(withRelationships.lines.filter((line) => line.kind === 'hierarchy')).toEqual(
      without.lines.filter((line) => line.kind === 'hierarchy'),
    );
    // b is hidden under the collapsed a, so only a–c is drawn.
    expect(
      withRelationships.lines.filter((line) => line.kind === 'relationship').map((line) => line.id),
    ).toEqual([`relationship:${id('r')}`]);
  });
});

describe('parentChoices', () => {
  it('lists every item in tree order with its depth, including collapsed branches', () => {
    const view = mapView('hierarchical', [
      placement('a', null, 0, { isCollapsed: true }),
      placement('b', 'a', 0),
      placement('c', null, 1),
    ]);
    expect(parentChoices(view).map((choice) => [choice.title, choice.depth])).toEqual([
      ['Item a', 0],
      ['Item b', 1],
      ['Item c', 0],
    ]);
  });
});

describe('facingSides', () => {
  const box = (x: number, y: number) => ({ x, y, width: 160, height: 40 });

  it('joins items side by side at their facing left and right sides', () => {
    expect(facingSides(box(0, 0), box(300, 20))).toEqual({ from: 'right', to: 'left' });
    expect(facingSides(box(300, 20), box(0, 0))).toEqual({ from: 'left', to: 'right' });
  });

  it('joins items one above the other at bottom and top, even when offset sideways', () => {
    // 100 to the right but 150 lower: the gap below is larger than the gap beside.
    expect(facingSides(box(0, 0), box(100, 150))).toEqual({ from: 'bottom', to: 'top' });
    expect(facingSides(box(100, 150), box(0, 0))).toEqual({ from: 'top', to: 'bottom' });
  });

  it('uses left and right for overlapping items', () => {
    expect(facingSides(box(0, 0), box(20, 10))).toEqual({ from: 'right', to: 'left' });
  });
});
