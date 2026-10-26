import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'storage-sqlite', environment: 'node' },
});
