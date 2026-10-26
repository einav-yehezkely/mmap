# ADR-0001: Monorepo and module boundaries

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §7.2 requires a monorepo that separates the desktop main, preload, and renderer code from
shared domain modules, contracts, and storage/transport adapters. Domain modules (knowledge,
maps, references, search, timeline, files, transfers) must not import Electron, React, SQLite,
Prisma, or HTTP frameworks. PRD §3 asks us to keep platform-specific code isolated and to
preserve domain and adapter boundaries for an optional future server/web phase (Fastify,
PostgreSQL/Prisma, S3). PRD §10 (Modularity) and §11 (Architecture tests) require that these
boundaries be checked automatically, and PRD §13 criterion 18 makes it an acceptance criterion.

A boundary that is only described in documentation erodes as soon as one convenient import
crosses it. We therefore need both a layout that makes the boundary obvious and tooling that
fails the build when it is crossed.

## Decision

Use a single repository with npm workspaces and this layout (implementation plan §2):

| Package                   | Responsibility                                                                                                                                                                          | May depend on                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `apps/desktop`            | Electron app built with electron-vite: `src/main` (window, security, IPC handlers, composition root), `src/preload` (minimal typed bridge), `src/renderer` (React, Tailwind, shadcn/ui) | `contracts`, `storage-sqlite`, `domain` |
| `packages/domain`         | Pure TypeScript domain rules and ports (repository, search, attachment-store, transaction, clock, application-service interfaces)                                                       | nothing infrastructural                 |
| `packages/contracts`      | IPC channel catalogue, zod DTO schemas, error codes                                                                                                                                     | `domain`                                |
| `packages/storage-sqlite` | `node:sqlite` adapter: connection setup, migrations, repositories                                                                                                                       | `domain`                                |

Dependency direction is `apps/desktop -> storage-sqlite -> domain` and
`apps/desktop -> contracts -> domain`. Nothing depends on `apps/desktop`.

`packages/domain` must not import `electron`, `react`, `node:sqlite`, `prisma`, `fastify`, or
any other HTTP framework. Two independent checks enforce this:

1. ESLint `no-restricted-imports` rules configured per package.
2. An architecture test (Vitest) that scans the domain package's source files and fails on any
   forbidden import. This catches cases a lint configuration change might silently disable.

Shared toolchain versions are pinned exactly and recorded in a single `package-lock.json`:
TypeScript 6.0.x (typescript-eslint 8.72 supports TypeScript below 6.1, so TypeScript 7 is not
used yet), React 19, Vite 8 via electron-vite 6, Tailwind 4, shadcn/ui, Vitest 5.

## Consequences

- Domain rules can be unit-tested on plain Node without Electron or a database.
- A future server adapter (PostgreSQL/Prisma, Fastify) can be added as a new package that
  implements the same domain ports, without changing domain code (PRD §7.2).
- The renderer depends on `contracts` types only through the preload bridge; it never sees
  storage code. This supports the IPC rules in ADR-0003.
- Adding a package means updating the ESLint boundary rules and, for anything the domain may
  import, the architecture test. Reviewers must check both when a package is added.
- One lockfile means one dependency upgrade affects every package at once; this is intended,
  because it keeps the Electron, Node, and test runtimes consistent.
- npm workspaces need no extra global tool beyond the npm that ships with Node.

## Alternatives considered

- **Single package with folder conventions.** Simplest to set up, but boundaries depend on
  discipline and the future server phase would have to untangle imports first. Rejected.
- **pnpm or Yarn workspaces.** Stricter dependency isolation (pnpm) and faster installs, but
  they add a global tool to the setup instructions. npm workspaces are sufficient for four
  packages. Rejected for now; can be revisited without changing the package layout.
- **Nx or Turborepo.** Build caching and dependency-graph rules are useful at larger scale but
  add configuration and concepts not needed for this repository size. Rejected.
- **Lint rules only, no architecture test.** Rejected because a lint misconfiguration would
  silently remove the only safeguard; PRD §11 explicitly asks for architecture checks.
