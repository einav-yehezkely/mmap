import { describe, expect, it } from 'vitest';

import type { LayoutItem } from './tree-layout';
import { layoutTree } from './tree-layout';

function item(
  id: string,
  parentId: string | null,
  siblingOrder = 0,
  collapsed = false,
): LayoutItem {
  return { id, parentId, siblingOrder, collapsed };
}

const COL = 260;
const ROW = 56;

/** Deterministic Fisher–Yates shuffle with a tiny LCG, so test runs are reproducible. */
function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

describe('layoutTree', () => {
  it('places a single root at the origin', () => {
    const { positions, hidden } = layoutTree([item('r', null)]);

    expect(positions.get('r')).toEqual({ x: 0, y: 0 });
    expect(hidden.size).toBe(0);
  });

  it('stacks multiple roots in display order with one empty row between trees', () => {
    const { positions } = layoutTree([item('b', null, 1), item('a', null, 0), item('c', null, 1)]);

    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')).toEqual({ x: 0, y: 2 * ROW });
    expect(positions.get('c')).toEqual({ x: 0, y: 4 * ROW });
  });

  it('centres a parent on its first and last visible child', () => {
    const { positions } = layoutTree([
      item('p', null),
      item('c1', 'p', 0),
      item('c2', 'p', 1),
      item('c3', 'p', 2),
      item('c1a', 'c1', 0),
      item('c1b', 'c1', 1),
    ]);

    expect(positions.get('c1a')).toEqual({ x: 2 * COL, y: 0 });
    expect(positions.get('c1b')).toEqual({ x: 2 * COL, y: ROW });
    expect(positions.get('c1')).toEqual({ x: COL, y: ROW / 2 });
    expect(positions.get('c2')).toEqual({ x: COL, y: 2 * ROW });
    expect(positions.get('c3')).toEqual({ x: COL, y: 3 * ROW });
    expect(positions.get('p')).toEqual({ x: 0, y: (ROW / 2 + 3 * ROW) / 2 });
  });

  it('lays out a deep chain on one row with increasing depth', () => {
    const { positions } = layoutTree([item('a', null), item('b', 'a'), item('c', 'b')]);

    expect(positions.get('c')).toEqual({ x: 2 * COL, y: 0 });
    expect(positions.get('b')).toEqual({ x: COL, y: 0 });
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
  });

  it('hides descendants of collapsed items and frees their rows', () => {
    const { positions, hidden } = layoutTree([
      item('r', null),
      item('a', 'r', 0, true),
      item('a1', 'a', 0),
      item('a1x', 'a1', 0),
      item('a2', 'a', 1),
      item('b', 'r', 1),
    ]);

    expect([...hidden].sort()).toEqual(['a1', 'a1x', 'a2']);
    expect(positions.has('a1')).toBe(false);
    expect(positions.get('a')).toEqual({ x: COL, y: 0 });
    expect(positions.get('b')).toEqual({ x: COL, y: ROW });
    expect(positions.get('r')).toEqual({ x: 0, y: ROW / 2 });
  });

  it('does not depend on the input array order', () => {
    const items = [
      item('r1', null, 0),
      item('r2', null, 1),
      item('a', 'r1', 0),
      item('b', 'r1', 0),
      item('c', 'r1', 2, true),
      item('c1', 'c', 0),
      item('a1', 'a', 0),
      item('a2', 'a', 1),
      item('x', 'r2', 0),
    ];
    const expected = layoutTree(items);

    for (const seed of [1, 7, 42, 1234]) {
      const actual = layoutTree(shuffled(items, seed));
      expect(new Map([...actual.positions].sort())).toEqual(
        new Map([...expected.positions].sort()),
      );
      expect(actual.hidden).toEqual(expected.hidden);
    }
  });

  it('treats an item with a missing or self parent as a root', () => {
    const { positions } = layoutTree([
      item('a', null, 0),
      item('orphan', 'gone', 1),
      item('s', 's', 2),
    ]);

    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(positions.get('orphan')).toEqual({ x: 0, y: 2 * ROW });
    expect(positions.get('s')).toEqual({ x: 0, y: 4 * ROW });
  });

  it('breaks a corrupt cycle at its smallest id and still lays out every item', () => {
    const { positions } = layoutTree([item('c', 'b'), item('a', 'c'), item('b', 'a')]);

    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')).toEqual({ x: COL, y: 0 });
    expect(positions.get('c')).toEqual({ x: 2 * COL, y: 0 });
  });

  it('applies custom options', () => {
    const { positions } = layoutTree([item('r', null), item('a', 'r', 0), item('b', 'r', 1)], {
      columnWidth: 100,
      rowHeight: 10,
    });

    expect(positions.get('a')).toEqual({ x: 100, y: 0 });
    expect(positions.get('b')).toEqual({ x: 100, y: 10 });
    expect(positions.get('r')).toEqual({ x: 0, y: 5 });
  });

  it('rejects non-positive sizes', () => {
    expect(() => layoutTree([], { rowHeight: 0 })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('handles a 10,000-deep chain and a 10,000-wide tree quickly', () => {
    const chain = Array.from({ length: 10_000 }, (_, i) =>
      item(`n${i}`, i === 0 ? null : `n${i - 1}`),
    );
    const wide = [
      item('root', null),
      ...Array.from({ length: 10_000 }, (_, i) => item(`k${i}`, 'root', i)),
    ];

    const started = performance.now();
    const deep = layoutTree(chain);
    const broad = layoutTree(wide);
    const elapsed = performance.now() - started;

    expect(deep.positions.get('n9999')).toEqual({ x: 9_999 * COL, y: 0 });
    expect(broad.positions.get('k9999')).toEqual({ x: COL, y: 9_999 * ROW });
    expect(broad.positions.get('root')).toEqual({ x: 0, y: (9_999 * ROW) / 2 });
    expect(elapsed).toBeLessThan(2_000);
  });
});
