import { describe, expect, it } from 'vitest';

import { clampPageSize, MAX_PAGE_SIZE } from './pagination';

describe('clampPageSize', () => {
  it.each([
    [50, 50],
    [0, 1],
    [-10, 1],
    [10_000, MAX_PAGE_SIZE],
    [12.9, 12],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('clamps %s to %s', (requested, expected) => {
    expect(clampPageSize(requested)).toBe(expected);
  });
});
