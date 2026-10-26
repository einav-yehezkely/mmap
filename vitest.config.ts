/**
 * Root Vitest configuration. Each workspace package is a separate test project so that, for
 * example, renderer tests can use a DOM environment while storage tests run on plain Node.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/domain',
      'packages/contracts',
      'packages/storage-sqlite',
      'apps/desktop',
      {
        test: {
          name: 'architecture',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
