/**
 * Public surface of the mmap domain package.
 *
 * Architecture rule (PRD §7.2): nothing under `packages/domain` may import Electron, React,
 * SQLite drivers, Prisma, Node built-ins or HTTP frameworks. This is enforced by ESLint and by
 * `tests/architecture.test.ts`.
 */

export * from './application/knowledge-node-service';
export * from './application/workspace-service';
export * from './clock';
export * from './errors';
export * from './files/attachment-policy';
export * from './ids';
export * from './knowledge/builtin-relationship-types';
export * from './knowledge/node-fields';
export * from './knowledge/relationship-rules';
export * from './notes/link-policy';
export * from './notes/note-document';
export * from './notes/plain-text';
export * from './ports/attachment-store';
export * from './ports/pagination';
export * from './ports/repositories';
export * from './ports/search';
export * from './ports/transaction';
export * from './text/labels';
export * from './workspace/workspace-name';
