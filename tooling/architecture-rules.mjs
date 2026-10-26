/**
 * Module boundary rules (PRD §7.2, §11 "Architecture: checks preventing Electron/database imports
 * into domain modules"). Single source of truth used by both `eslint.config.mjs` (fast feedback in
 * the editor) and `tests/architecture.test.ts` (an independent check that cannot be silenced by an
 * inline eslint-disable comment).
 *
 * Each rule lists import specifiers that files under `directory` must not use. Patterns match the
 * full specifier or any subpath (`electron` also blocks `electron/main`).
 */

/** Node built-ins, with or without the `node:` prefix. */
const NODE_BUILTINS = [
  'node:*',
  'fs',
  'path',
  'os',
  'child_process',
  'crypto',
  'url',
  'http',
  'https',
  'net',
];
const UI_FRAMEWORKS = ['react', 'react-dom', '@xyflow/*', 'cytoscape', '@tiptap/*'];
const DATABASE_ENGINES = ['node:sqlite', 'better-sqlite3', 'sqlite3', '@prisma/*', 'prisma', 'pg'];
const HTTP_FRAMEWORKS = ['fastify', 'express', 'koa', 'hono'];

export const ARCHITECTURE_RULES = [
  {
    directory: 'packages/domain/src',
    reason: 'Domain modules must stay independent of runtimes, UI, storage and transport.',
    forbidden: [
      'electron',
      ...UI_FRAMEWORKS,
      ...DATABASE_ENGINES,
      ...HTTP_FRAMEWORKS,
      ...NODE_BUILTINS,
      '@mmap/contracts',
      '@mmap/storage-sqlite',
    ],
  },
  {
    directory: 'packages/contracts/src',
    reason: 'Contracts are shared by main, preload and renderer and must not pull in runtimes.',
    forbidden: [
      'electron',
      ...UI_FRAMEWORKS,
      ...DATABASE_ENGINES,
      ...HTTP_FRAMEWORKS,
      ...NODE_BUILTINS,
      '@mmap/storage-sqlite',
    ],
  },
  {
    directory: 'packages/storage-sqlite/src',
    reason: 'The storage adapter must not depend on the desktop shell, UI or IPC contracts.',
    forbidden: ['electron', ...UI_FRAMEWORKS, ...HTTP_FRAMEWORKS, '@mmap/contracts'],
  },
  {
    directory: 'apps/desktop/src/renderer',
    reason: 'The renderer is sandboxed: it may only reach the main process via window.mmap.',
    forbidden: ['electron', ...NODE_BUILTINS, ...DATABASE_ENGINES, '@mmap/storage-sqlite'],
  },
  {
    directory: 'apps/desktop/src/preload',
    reason: 'The preload bridge stays minimal: no storage, filesystem or UI code.',
    forbidden: [...NODE_BUILTINS, ...DATABASE_ENGINES, ...UI_FRAMEWORKS, '@mmap/storage-sqlite'],
  },
];

/** Returns true when `specifier` is matched by `pattern` (exact, subpath, or `prefix*`). */
export function matchesForbiddenPattern(specifier, pattern) {
  if (pattern.endsWith('*')) {
    return specifier.startsWith(pattern.slice(0, -1));
  }
  return specifier === pattern || specifier.startsWith(`${pattern}/`);
}
