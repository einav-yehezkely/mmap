import { describe, expect, it } from 'vitest';

import { isCanonicalUuid } from './ids';

describe('isCanonicalUuid', () => {
  it('accepts lowercase UUIDs', () => {
    expect(isCanonicalUuid('3f2c9a4e-1b7d-4c2e-9f00-0123456789ab')).toBe(true);
  });

  it.each([
    ['uppercase', '3F2C9A4E-1B7D-4C2E-9F00-0123456789AB'],
    ['missing dashes', '3f2c9a4e1b7d4c2e9f000123456789ab'],
    ['surrounding whitespace', ' 3f2c9a4e-1b7d-4c2e-9f00-0123456789ab'],
    ['empty', ''],
    ['path-like', '../3f2c9a4e-1b7d-4c2e-9f00-0123456789ab'],
  ])('rejects %s', (_label, value) => {
    expect(isCanonicalUuid(value)).toBe(false);
  });
});
