/**
 * Pins the checksum of every shipped migration. Applied migrations must never change: the runner
 * refuses to open a workspace whose recorded checksums differ from the code (see `migration.ts`).
 * Editing a migration that is already applied anywhere (even a development workspace) therefore
 * locks that workspace out. This test fails on such an edit, so the change is made as a new
 * migration instead.
 *
 * When adding a migration, append its checksum here.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ALL_MIGRATIONS } from './index';

const PINNED_CHECKSUMS: Readonly<Record<number, string>> = {
  1: 'be2642235b616925d0c07eead4e170168e694b77fb25986e102df456c2851877',
  2: '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
  3: '32654b89941d0052fbd3483fe58e71c751a136c69c9898da9f35d313a961664d',
  4: '3b9ddac96a4eb2f288ad582733249aaedd2475073fcaf279152cd59f215670c3',
};

describe('migration checksums', () => {
  it.each(ALL_MIGRATIONS.map((migration) => [migration.version, migration] as const))(
    'migration %i is unchanged',
    (version, migration) => {
      const checksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
      expect(checksum).toBe(PINNED_CHECKSUMS[version]);
    },
  );
});
