/**
 * ESLint flat config for the whole monorepo.
 *
 * - Type-aware typescript-eslint rules for all source code (catches floating promises, unsafe
 *   `any` flows and similar bugs that matter for IPC and database code).
 * - Explicit return types on exported functions in packages and the main process (PRD §10.1:
 *   "explicit types at module boundaries").
 * - Module boundary rules generated from `tooling/architecture-rules.mjs`.
 * - Formatting is left to Prettier (`eslint-config-prettier` turns off conflicting rules).
 */

import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { ARCHITECTURE_RULES } from './tooling/architecture-rules.mjs';

const TYPE_CHECKED_PROJECTS = [
  './tsconfig.json',
  './packages/domain/tsconfig.json',
  './packages/domain/tsconfig.test.json',
  './packages/contracts/tsconfig.json',
  './packages/contracts/tsconfig.test.json',
  './packages/storage-sqlite/tsconfig.json',
  './apps/desktop/tsconfig.node.json',
  './apps/desktop/tsconfig.web.json',
];

/** Converts one architecture rule into a `no-restricted-imports` config block. */
function boundaryConfig(rule) {
  return {
    files: [`${rule.directory}/**/*.{ts,tsx}`],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: rule.forbidden.flatMap((pattern) =>
                pattern.endsWith('*') ? [pattern] : [pattern, `${pattern}/*`],
              ),
              message: rule.reason,
            },
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/release/**', '**/coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: TYPE_CHECKED_PROJECTS,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'apps/desktop/src/main/**/*.ts'],
    ignores: ['**/*.test.ts', '**/test-support/**'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/scripts/**/*.mjs', 'tooling/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Repositories and queries implement async ports over the synchronous node:sqlite driver.
    // Declaring the methods `async` (even without `await`) guarantees that a thrown error
    // becomes a rejected promise, which callers of the port contract rely on.
    files: [
      'packages/storage-sqlite/src/repositories/**/*.ts',
      'packages/storage-sqlite/src/graph/**/*.ts',
    ],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Async mocks without `await` are idiomatic in tests.
    files: ['**/*.test.ts', '**/test-support/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // The smoke test prints its JSON report to stdout for CI logs.
    files: ['apps/desktop/src/main/smoke-test.ts', 'apps/desktop/scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    // Plain JavaScript and config files are not part of a TypeScript project.
    files: ['**/*.{js,mjs,cjs}', '**/vitest.config.ts', '**/electron.vite.config.ts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  ...ARCHITECTURE_RULES.map(boundaryConfig),
  prettier,
);
