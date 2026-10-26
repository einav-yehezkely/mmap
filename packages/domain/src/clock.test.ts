import { describe, expect, it } from 'vitest';

import { isUtcTimestamp, toUtcTimestamp } from './clock';

describe('UTC timestamps', () => {
  it('formats dates as fixed-width UTC with milliseconds', () => {
    expect(toUtcTimestamp(new Date(Date.UTC(2026, 9, 26, 14, 3, 0, 7)))).toBe(
      '2026-10-26T14:03:00.007Z',
    );
  });

  it.each([
    ['offset instead of Z', '2026-10-26T14:03:00.000+02:00'],
    ['missing milliseconds', '2026-10-26T14:03:00Z'],
    ['impossible date', '2026-13-40T14:03:00.000Z'],
    ['date only', '2026-10-26'],
  ])('rejects %s', (_label, value) => {
    expect(isUtcTimestamp(value)).toBe(false);
  });

  it('accepts its own output', () => {
    expect(isUtcTimestamp(toUtcTimestamp(new Date()))).toBe(true);
  });
});
