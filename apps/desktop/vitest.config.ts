import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Many of these tests create, copy, back up and import real workspaces on disk. On a busy
    // Windows CI runner one took 10 s; Vitest's default of 5 s made them fail on time alone.
    testTimeout: 30_000,
  },
});
