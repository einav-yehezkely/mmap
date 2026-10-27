/**
 * Stable graph placement (PRD §5.7): saved positions never move, new nodes are placed near their
 * neighbors without overlapping, disconnected groups go to free space, and results are
 * deterministic.
 */

import { describe, expect, it } from 'vitest';

import { NODE_SPACING_X, NODE_SPACING_Y, placeNodes, type Point } from './graph-layout';

function distinctCells(positions: ReadonlyMap<string, Point>): boolean {
  const cells = new Set(
    [...positions.values()].map(
      (p) => `${Math.round(p.x / NODE_SPACING_X)}:${Math.round(p.y / NODE_SPACING_Y)}`,
    ),
  );
  return cells.size === positions.size;
}

describe('placeNodes', () => {
  it('handles an empty graph and a single node', () => {
    expect(placeNodes([], [], new Map()).size).toBe(0);
    expect(placeNodes(['a'], [], new Map())).toEqual(new Map([['a', { x: 0, y: 0 }]]));
  });

  it('keeps saved positions exactly and places new neighbors next to them', () => {
    const saved = new Map([['hub', { x: 1000, y: 500 }]]);
    const placed = placeNodes(
      ['hub', 'a', 'b'],
      [
        { source: 'hub', target: 'a' },
        { source: 'b', target: 'hub' },
      ],
      saved,
    );

    expect(placed.get('hub')).toEqual({ x: 1000, y: 500 });
    for (const id of ['a', 'b']) {
      const point = placed.get(id)!;
      expect(Math.abs(point.x - 1000)).toBeLessThanOrEqual(NODE_SPACING_X * 2);
      expect(Math.abs(point.y - 500)).toBeLessThanOrEqual(NODE_SPACING_Y * 2);
    }
    expect(distinctCells(placed)).toBe(true);
  });

  it('places disconnected groups apart without overlaps', () => {
    const ids = ['a1', 'a2', 'a3', 'b1', 'b2', 'lonely'];
    const links = [
      { source: 'a1', target: 'a2' },
      { source: 'a2', target: 'a3' },
      { source: 'b1', target: 'b2' },
    ];
    const placed = placeNodes(ids, links, new Map());

    expect(placed.size).toBe(6);
    expect(distinctCells(placed)).toBe(true);
    // Members of a group sit close together.
    const a1 = placed.get('a1')!;
    const a2 = placed.get('a2')!;
    expect(Math.abs(a1.x - a2.x) + Math.abs(a1.y - a2.y)).toBeLessThanOrEqual(
      NODE_SPACING_X + NODE_SPACING_Y,
    );
  });

  it('puts new loose nodes below the existing drawing', () => {
    const saved = new Map([
      ['x', { x: 0, y: 0 }],
      ['y', { x: 0, y: 600 }],
    ]);
    const placed = placeNodes(['x', 'y', 'new'], [], saved);
    expect(placed.get('new')!.y).toBeGreaterThan(600);
  });

  it('is deterministic and fast for 1,000 nodes', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `n${index}`);
    const links = ids.map((id, index) => ({ source: id, target: `n${(index * 7 + 3) % 1_000}` }));
    const start = performance.now();
    const first = placeNodes(ids, links, new Map());
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(placeNodes(ids, links, new Map())).toEqual(first);
    expect(distinctCells(first)).toBe(true);
  });
});
