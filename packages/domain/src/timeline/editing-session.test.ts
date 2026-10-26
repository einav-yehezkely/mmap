import { describe, expect, it } from 'vitest';

import { continuesEditingSession } from './editing-session';

const at = (minutes: number, seconds = 0) =>
  new Date(Date.UTC(2026, 9, 26, 12, minutes, seconds)).toISOString();

describe('continuesEditingSession', () => {
  it.each([
    ['immediately', at(0), at(0), true],
    ['29:59 later', at(0), at(29, 59), true],
    ['exactly 30 minutes later', at(0), at(30), false],
    ['an hour later', at(0), at(60), false],
    ['clock moved backwards', at(10), at(5), false],
  ])('%s → %s', (_label, last, now, expected) => {
    expect(continuesEditingSession(last, now)).toBe(expected);
  });
});
