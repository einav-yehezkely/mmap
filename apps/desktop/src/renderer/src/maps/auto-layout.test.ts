/**
 * Automatic layout with ELK (`auto-layout.ts`): layers in the chosen direction, no overlapping
 * items, routes attached to the facing sides, and graceful handling of cycles, several parents,
 * two-way and cross links, disconnected items and locked items.
 */

import { describe, expect, it } from 'vitest';

import {
  computeAutoLayout,
  type AutoLayoutResult,
  type LayoutItem,
  type LayoutLine,
} from './auto-layout';

const WIDTH = 140;
const HEIGHT = 40;

function item(id: string, x = 0, y = 0, pinned = false): LayoutItem {
  return { id, x, y, width: WIDTH, height: HEIGHT, pinned };
}

function line(source: string, target: string): LayoutLine {
  return { id: `${source}->${target}`, source, target };
}

function position(result: AutoLayoutResult, id: string) {
  const point = result.positions.get(id);
  if (point === undefined) throw new Error(`${id} was not placed`);
  return point;
}

/** No two boxes overlap (locked items are checked at their own positions). */
function expectNoOverlaps(result: AutoLayoutResult, items: readonly LayoutItem[]) {
  const boxes = items.map((entry) => {
    const point = result.positions.get(entry.id) ?? { x: entry.x, y: entry.y };
    return { id: entry.id, ...point };
  });
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.id >= b.id) continue;
      const apart =
        a.x + WIDTH <= b.x || b.x + WIDTH <= a.x || a.y + HEIGHT <= b.y || b.y + HEIGHT <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
  }
}

describe('computeAutoLayout', () => {
  it('lays a chain out in layers from left to right, with routes between facing sides', async () => {
    const items = [item('a'), item('b', 10, 10), item('c', 20, 20)];
    const result = await computeAutoLayout(items, [line('a', 'b'), line('b', 'c')], 'right');

    expect(position(result, 'a').x).toBeLessThan(position(result, 'b').x);
    expect(position(result, 'b').x).toBeLessThan(position(result, 'c').x);
    expectNoOverlaps(result, items);
    const route = result.routes.get('a->b')!;
    expect(route).toMatchObject({ sourceSide: 'right', targetSide: 'left' });
    // The route starts at the middle of a's right side and ends at the middle of b's left side.
    expect(route.points[0]).toEqual({
      x: position(result, 'a').x + WIDTH,
      y: position(result, 'a').y + HEIGHT / 2,
    });
    expect(route.points.at(-1)).toEqual({
      x: position(result, 'b').x,
      y: position(result, 'b').y + HEIGHT / 2,
    });
  });

  it('goes top to bottom and right to left on request', async () => {
    const items = [item('a'), item('b'), item('c')];
    const lines = [line('a', 'b'), line('b', 'c')];

    const down = await computeAutoLayout(items, lines, 'down');
    expect(position(down, 'a').y).toBeLessThan(position(down, 'b').y);
    expect(position(down, 'b').y).toBeLessThan(position(down, 'c').y);
    expect(down.routes.get('a->b')).toMatchObject({ sourceSide: 'bottom', targetSide: 'top' });

    const left = await computeAutoLayout(items, lines, 'left');
    expect(position(left, 'a').x).toBeGreaterThan(position(left, 'b').x);
    expect(position(left, 'b').x).toBeGreaterThan(position(left, 'c').x);
  });

  it('handles cycles, two-way links and several parents', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
    const lines = [
      line('a', 'b'),
      line('b', 'c'),
      line('c', 'a'), // cycle
      line('d', 'b'),
      line('b', 'd'), // two-way
      line('e', 'c'), // c has several parents
    ];
    const result = await computeAutoLayout(items, lines, 'right');

    expect(result.positions.size).toBe(5);
    expectNoOverlaps(result, items);
    for (const entry of lines) expect(result.routes.has(entry.id), entry.id).toBe(true);
    // Every route is orthogonal: each segment is horizontal or vertical.
    for (const route of result.routes.values()) {
      for (let index = 1; index < route.points.length; index += 1) {
        const [from, to] = [route.points[index - 1]!, route.points[index]!];
        expect(from.x === to.x || from.y === to.y).toBe(true);
      }
    }
  });

  it('places disconnected groups and lone items without overlaps, and keeps the map in place', async () => {
    const items = [
      item('a', 500, 300),
      item('b', 520, 320),
      item('c', 540, 340),
      item('lone', 900, 900),
    ];
    const result = await computeAutoLayout(items, [line('a', 'b'), line('c', 'c')], 'right');

    expect(result.positions.size).toBe(4);
    expectNoOverlaps(result, items);
    // A line from an item to itself is not routed.
    expect(result.routes.has('c->c')).toBe(false);
    // The arranged block starts where the items started (top-left corner kept).
    const xs = [...result.positions.values()].map((point) => point.x);
    const ys = [...result.positions.values()].map((point) => point.y);
    expect(Math.min(...xs)).toBe(500);
    expect(Math.min(...ys)).toBe(300);
  });

  it('keeps locked items in place and arranges the others next to them', async () => {
    const items = [item('locked', 0, 0, true), item('a', 5, 5), item('b', 10, 10)];
    const result = await computeAutoLayout(items, [line('a', 'b'), line('locked', 'a')], 'right');

    expect(result.positions.has('locked')).toBe(false);
    expect(position(result, 'a').x).toBeGreaterThanOrEqual(WIDTH + 100);
    expectNoOverlaps(result, items);
    // Lines touching a locked item are not routed; they keep the canvas's normal curve.
    expect(result.routes.has('locked->a')).toBe(false);
    expect(result.routes.has('a->b')).toBe(true);
  });

  it('is stable: the same map gives the same layout', async () => {
    const items = ['a', 'b', 'c', 'd'].map((id, index) => item(id, index * 10, index * 7));
    const lines = [line('a', 'b'), line('a', 'c'), line('c', 'd'), line('b', 'd')];
    const first = await computeAutoLayout(items, lines, 'right');
    const second = await computeAutoLayout([...items].reverse(), [...lines].reverse(), 'right');

    expect([...second.positions].sort()).toEqual([...first.positions].sort());
  });

  it('does nothing when every item is locked', async () => {
    const result = await computeAutoLayout([item('a', 0, 0, true)], [], 'right');
    expect(result.positions.size).toBe(0);
  });
});

describe('tree layout for strict hierarchies', () => {
  const sized = (id: string, width: number, height = HEIGHT): LayoutItem => ({
    id,
    x: 0,
    y: 0,
    width,
    height,
    pinned: false,
  });
  const centerX = (result: AutoLayoutResult, item: LayoutItem) =>
    position(result, item.id).x + item.width / 2;
  const centerY = (result: AutoLayoutResult, item: LayoutItem) =>
    position(result, item.id).y + item.height / 2;

  it('centers a parent above children of different widths, in one evenly spaced row', async () => {
    const board = sized('motherboard', 160);
    const kids = [sized('cpu', 80), sized('ram', 120), sized('gpu', 200), sized('ssd', 100)];
    const result = await computeAutoLayout(
      [board, ...kids],
      kids.map((kid) => line('motherboard', kid.id)),
      'down',
    );

    expect(result.strategy).toBe('tree');
    const ys = kids.map((kid) => position(result, kid.id).y);
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeGreaterThan(position(result, 'motherboard').y + HEIGHT);
    // Even gaps between neighboring boxes, whatever their widths (read in their row order).
    const row = [...kids].sort((a, b) => position(result, a.id).x - position(result, b.id).x);
    const gaps = row
      .slice(1)
      .map(
        (kid, index) =>
          position(result, kid.id).x - (position(result, row[index]!.id).x + row[index]!.width),
      );
    expect(new Set(gaps).size).toBe(1);
    // The parent's center is the middle of the children's row.
    const left = position(result, row[0]!.id).x;
    const right = position(result, row.at(-1)!.id).x + row.at(-1)!.width;
    expect(Math.abs(centerX(result, board) - (left + right) / 2)).toBeLessThanOrEqual(1);
  });

  it('centers every parent at every level without overlapping subtrees', async () => {
    const items = ['root', 'a', 'b', 'a1', 'a2', 'a3', 'b1'].map((id) => sized(id, 120));
    const lines = [
      line('root', 'a'),
      line('root', 'b'),
      line('a', 'a1'),
      line('a', 'a2'),
      line('a', 'a3'),
      line('b', 'b1'),
    ];
    const result = await computeAutoLayout(items, lines, 'down');
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    const centeredOver = (parent: string, kids: string[]) => {
      const left = position(result, kids[0]!).x;
      const right = position(result, kids.at(-1)!).x + 120;
      expect(Math.abs(centerX(result, byId.get(parent)!) - (left + right) / 2)).toBeLessThanOrEqual(
        1,
      );
    };
    centeredOver('a', ['a1', 'a2', 'a3']);
    centeredOver('b', ['b1']);
    centeredOver('root', ['a', 'b']);
    expectNoOverlaps(
      result,
      items.map((entry) => ({ ...entry, width: 120 })),
    );
    // Levels are evenly spaced.
    const levels = [...new Set(['root', 'a', 'a1'].map((id) => position(result, id).y))];
    expect(levels[1]! - levels[0]!).toBe(levels[2]! - levels[1]!);
  });

  it('routes children through a shared branching line below the parent', async () => {
    const items = ['p', 'c1', 'c2', 'c3'].map((id) => sized(id, 100));
    const result = await computeAutoLayout(
      items,
      [line('p', 'c1'), line('p', 'c2'), line('p', 'c3')],
      'down',
    );
    const branches = ['p->c1', 'p->c3'].map((id) => result.routes.get(id)!.points[1]!.y);
    expect(branches[0]).toBe(branches[1]);
    for (const route of result.routes.values()) {
      expect(route).toMatchObject({ sourceSide: 'bottom', targetSide: 'top' });
      for (let index = 1; index < route.points.length; index += 1) {
        const [from, to] = [route.points[index - 1]!, route.points[index]!];
        expect(from.x === to.x || from.y === to.y).toBe(true);
      }
    }
  });

  it('mirrors for bottom to top, and centers vertically from left to right and right to left', async () => {
    const parent = sized('p', 100);
    const kids = ['k1', 'k2', 'k3'].map((id) => sized(id, 100));
    const lines = kids.map((kid) => line('p', kid.id));

    const up = await computeAutoLayout([parent, ...kids], lines, 'up');
    expect(position(up, 'p').y).toBeGreaterThan(position(up, 'k1').y);
    expect(up.routes.get('p->k2')).toMatchObject({ sourceSide: 'top', targetSide: 'bottom' });

    for (const direction of ['right', 'left'] as const) {
      const result = await computeAutoLayout([parent, ...kids], lines, direction);
      const top = position(result, 'k1').y;
      const bottom = position(result, 'k3').y + HEIGHT;
      expect(Math.abs(centerY(result, parent) - (top + bottom) / 2)).toBeLessThanOrEqual(1);
      const parentX = position(result, 'p').x;
      expect(
        direction === 'right'
          ? parentX < position(result, 'k1').x
          : parentX > position(result, 'k1').x,
      ).toBe(true);
    }
  });

  it('uses ELK for cross-links, several parents and cycles', async () => {
    const items = ['a', 'b', 'c'].map((id) => item(id));
    expect(
      (await computeAutoLayout(items, [line('a', 'c'), line('b', 'c')], 'down')).strategy,
    ).toBe('layered');
    expect(
      (await computeAutoLayout(items, [line('a', 'b'), line('b', 'a')], 'down')).strategy,
    ).toBe('layered');
    expect(
      (await computeAutoLayout(items, [line('a', 'b'), line('a', 'c')], 'down')).strategy,
    ).toBe('tree');
    // Several separate trees and lone items are still a hierarchy.
    expect((await computeAutoLayout(items, [line('a', 'b')], 'down')).strategy).toBe('tree');
  });
});
