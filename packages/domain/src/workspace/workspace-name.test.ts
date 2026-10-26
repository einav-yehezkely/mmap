import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';
import { normalizeWorkspaceName, toWorkspaceFolderName } from './workspace-name';

describe('normalizeWorkspaceName', () => {
  it('trims whitespace and keeps Unicode', () => {
    expect(normalizeWorkspaceName('  פיזיקה 🧪  ')).toBe('פיזיקה 🧪');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'x'.repeat(81)],
    ['control character', 'bad\u0007name'],
  ])('rejects %s names', (_label, name) => {
    expect(() => normalizeWorkspaceName(name)).toThrow(DomainError);
  });
});

describe('toWorkspaceFolderName', () => {
  it.each([
    ['Research Notes', 'Research Notes'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j'],
    ['trailing dots...', 'trailing dots'],
    ['..', 'Workspace'],
    ['???', 'Workspace'],
    ['CON', 'CON-workspace'],
    ['nul.txt', 'nul.txt-workspace'],
    ['קורס', 'קורס'],
  ])('%j → %j', (input, expected) => {
    expect(toWorkspaceFolderName(input)).toBe(expected);
  });
});
