/**
 * Architecture test: scans source files and fails if any module imports something its layer
 * forbids (see `tooling/architecture-rules.mjs`). Complements ESLint, which a developer could
 * bypass locally with a disable comment.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ARCHITECTURE_RULES, matchesForbiddenPattern } from '../tooling/architecture-rules.mjs';

const REPOSITORY_ROOT = join(import.meta.dirname, '..');
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;

/** Matches static imports/exports, dynamic `import()` and `require()` specifiers. */
const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? '');
}

describe('import specifier extraction', () => {
  it('finds static, type-only, side-effect, dynamic and require imports', () => {
    const source = [
      "import { a } from 'electron';",
      "import type { B } from 'react';",
      "import 'node:fs';",
      "export * from 'fastify';",
      "const c = await import('node:sqlite');",
      "const d = require('better-sqlite3');",
    ].join('\n');

    expect(importSpecifiers(source)).toEqual([
      'electron',
      'react',
      'node:fs',
      'fastify',
      'node:sqlite',
      'better-sqlite3',
    ]);
  });
});

describe.each(ARCHITECTURE_RULES)('module boundaries: $directory', (rule) => {
  it('does not import forbidden modules', () => {
    const violations = listSourceFiles(join(REPOSITORY_ROOT, rule.directory)).flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) =>
          rule.forbidden.some((pattern) => matchesForbiddenPattern(specifier, pattern)),
        )
        .map((specifier) => `${relative(REPOSITORY_ROOT, file)} imports '${specifier}'`),
    );

    expect(violations, rule.reason).toEqual([]);
  });
});
