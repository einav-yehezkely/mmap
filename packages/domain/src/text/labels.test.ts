import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';
import { toDisplayLabel, toNormalizedLabel } from './labels';

describe('labels', () => {
  it('collapses whitespace but keeps the user casing for display', () => {
    expect(toDisplayLabel('  Quantum   Physics ', 'Tag')).toBe('Quantum Physics');
  });

  it.each([
    ['Physics', 'PHYSICS'],
    ['ﬁzzy', 'fizzy'],
    ['Ｍａｔｈ', 'math'],
    ['פיזיקה', 'פיזיקה'],
  ])('%s and %s normalize to the same key', (first, second) => {
    expect(toNormalizedLabel(toDisplayLabel(first, 'Tag'))).toBe(
      toNormalizedLabel(toDisplayLabel(second, 'Tag')),
    );
  });

  it.each(['', '   ', 'x'.repeat(61), 'tab\u0000inside'])('rejects %j', (label) => {
    expect(() => toDisplayLabel(label, 'Tag')).toThrow(DomainError);
  });
});
