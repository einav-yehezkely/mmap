/** Positions for nodes added to a map without a chosen spot. */

import { describe, expect, it } from 'vitest';

import { findFreePosition } from './free-position';

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < 210 && Math.abs(a.y - b.y) < 70;

describe('findFreePosition', () => {
  it('starts an empty map at the origin', () => {
    expect(findFreePosition([])).toEqual({ x: 0, y: 0 });
  });

  it('never overlaps existing items and stays near them', () => {
    const items = [
      { x: 0, y: 0 },
      { x: 220, y: 0 },
      { x: 440, y: 0 },
      { x: 220, y: 90 },
    ];
    const spot = findFreePosition(items);
    expect(items.some((item) => overlaps(item, spot))).toBe(false);
    expect(Math.abs(spot.x - 220)).toBeLessThanOrEqual(440);
    expect(Math.abs(spot.y)).toBeLessThanOrEqual(180);
  });

  it('finds room in a crowded map', () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      x: (index % 10) * 220,
      y: Math.floor(index / 10) * 90,
    }));
    const spot = findFreePosition(items);
    expect(items.some((item) => overlaps(item, spot))).toBe(false);
  });
});
