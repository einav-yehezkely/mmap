import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';
import type { HierarchyItem } from './hierarchy';
import {
  assertNoCycle,
  descendantsOf,
  orderedChildren,
  planMove,
  wouldCreateCycle,
} from './hierarchy';

function item(id: string, parentId: string | null, siblingOrder = 0): HierarchyItem {
  return { id, parentId, siblingOrder };
}

/**
 * root
 * ├── a
 * │   ├── a1
 * │   │   └── a1x
 * │   └── a2
 * └── b
 * other (second root)
 */
const tree: HierarchyItem[] = [
  item('root', null, 0),
  item('other', null, 1),
  item('a', 'root', 0),
  item('b', 'root', 1),
  item('a1', 'a', 0),
  item('a2', 'a', 1),
  item('a1x', 'a1', 0),
];

describe('wouldCreateCycle', () => {
  it('detects making an item its own parent', () => {
    expect(wouldCreateCycle(tree, 'a', 'a')).toBe(true);
  });

  it('detects moving an item under its direct child', () => {
    expect(wouldCreateCycle(tree, 'a', 'a1')).toBe(true);
  });

  it('detects moving an item under a deep descendant', () => {
    expect(wouldCreateCycle(tree, 'root', 'a1x')).toBe(true);
  });

  it('allows moving to an unrelated branch or to the root level', () => {
    expect(wouldCreateCycle(tree, 'a1', 'b')).toBe(false);
    expect(wouldCreateCycle(tree, 'a1x', null)).toBe(false);
    expect(wouldCreateCycle(tree, 'b', 'a1x')).toBe(false);
  });

  it('rejects an unknown new parent', () => {
    const attempt = () => wouldCreateCycle(tree, 'a', 'missing');

    expect(attempt).toThrow(DomainError);
    expect(attempt).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('terminates on corrupt input that already contains a cycle', () => {
    const corrupt = [item('x', 'y'), item('y', 'z'), item('z', 'x'), item('free', null)];

    expect(wouldCreateCycle(corrupt, 'free', 'x')).toBe(false);
    expect(wouldCreateCycle(corrupt, 'x', 'z')).toBe(true);
  });
});

describe('assertNoCycle', () => {
  it('throws an invariant violation with a user-facing message', () => {
    const attempt = () => assertNoCycle(tree, 'a', 'a1x');

    expect(attempt).toThrow(expect.objectContaining({ code: 'INVARIANT_VIOLATION' }));
    expect(attempt).toThrow('This would put an item inside its own branch.');
  });

  it('accepts a valid move', () => {
    expect(() => assertNoCycle(tree, 'a1', 'b')).not.toThrow();
  });
});

describe('orderedChildren', () => {
  it('orders by sibling order, then by id', () => {
    const items = [item('c', 'p', 1), item('b', 'p', 1), item('a', 'p', 2), item('z', 'p', 0)];

    expect(orderedChildren(items, 'p').map((child) => child.id)).toEqual(['z', 'b', 'c', 'a']);
  });

  it('returns roots for a null parent', () => {
    expect(orderedChildren(tree, null).map((child) => child.id)).toEqual(['root', 'other']);
  });
});

describe('planMove', () => {
  const siblings = [item('p', null), item('a', 'p', 0), item('b', 'p', 1), item('c', 'p', 2)];

  it('reorders within the same sibling group', () => {
    expect(planMove(siblings, 'a', 'p', 2)).toEqual([
      { id: 'b', parentId: 'p', siblingOrder: 0 },
      { id: 'c', parentId: 'p', siblingOrder: 1 },
      { id: 'a', parentId: 'p', siblingOrder: 2 },
    ]);
    expect(planMove(siblings, 'c', 'p', 0)).toEqual([
      { id: 'c', parentId: 'p', siblingOrder: 0 },
      { id: 'a', parentId: 'p', siblingOrder: 1 },
      { id: 'b', parentId: 'p', siblingOrder: 2 },
    ]);
  });

  it('moves to another parent and renumbers both groups densely', () => {
    const items = [
      item('p', null, 0),
      item('q', null, 1),
      item('a', 'p', 0),
      item('b', 'p', 5),
      item('c', 'p', 9),
      item('x', 'q', 3),
      item('y', 'q', 7),
    ];

    expect(planMove(items, 'b', 'q', 1)).toEqual([
      { id: 'x', parentId: 'q', siblingOrder: 0 },
      { id: 'b', parentId: 'q', siblingOrder: 1 },
      { id: 'y', parentId: 'q', siblingOrder: 2 },
      { id: 'c', parentId: 'p', siblingOrder: 1 },
    ]);
  });

  it('clamps the index into the valid range', () => {
    expect(planMove(siblings, 'a', 'p', 99)).toEqual(planMove(siblings, 'a', 'p', 2));
    expect(planMove(siblings, 'c', 'p', -5)).toEqual(planMove(siblings, 'c', 'p', 0));
  });

  it('moves an item to the root level', () => {
    expect(planMove(tree, 'a1', null, 1)).toEqual([
      { id: 'a1', parentId: null, siblingOrder: 1 },
      { id: 'other', parentId: null, siblingOrder: 2 },
      { id: 'a2', parentId: 'a', siblingOrder: 0 },
    ]);
  });

  it('rejects a move that would create a cycle', () => {
    const attempt = () => planMove(tree, 'a', 'a1x', 0);

    expect(attempt).toThrow(expect.objectContaining({ code: 'INVARIANT_VIOLATION' }));
  });

  it('rejects an unknown item', () => {
    expect(() => planMove(tree, 'missing', null, 0)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('returns no changes for a no-op move, even with sparse sibling orders', () => {
    expect(planMove(siblings, 'b', 'p', 1)).toEqual([]);
    const sparse = [item('p', null), item('a', 'p', 10), item('b', 'p', 20)];
    expect(planMove(sparse, 'b', 'p', 1)).toEqual([]);
  });
});

describe('descendantsOf', () => {
  it('lists descendants depth-first in display order', () => {
    expect(descendantsOf(tree, 'root')).toEqual(['a', 'a1', 'a1x', 'a2', 'b']);
    expect(descendantsOf(tree, 'a1x')).toEqual([]);
  });

  it('terminates on corrupt cyclic input', () => {
    const corrupt = [item('x', 'z'), item('y', 'x'), item('z', 'y')];

    expect(descendantsOf(corrupt, 'x')).toEqual(['y', 'z']);
  });

  it('handles a 10,000-deep chain without recursion', () => {
    const chain = Array.from({ length: 10_000 }, (_, i) =>
      item(`n${i}`, i === 0 ? null : `n${i - 1}`),
    );

    expect(descendantsOf(chain, 'n0')).toHaveLength(9_999);
    expect(wouldCreateCycle(chain, 'n0', 'n9999')).toBe(true);
  });
});
