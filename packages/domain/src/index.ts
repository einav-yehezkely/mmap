/**
 * Public surface of the mmap domain package.
 *
 * Architecture rule (PRD §7.2): nothing under `packages/domain` may import Electron, React,
 * SQLite drivers, Prisma, Node built-ins or HTTP frameworks. This is enforced by ESLint and by
 * `architecture.test.ts`.
 */

export * from './clock';
export * from './errors';
export * from './ids';
export * from './knowledge/relationship-rules';
export * from './ports/attachment-store';
export * from './ports/pagination';
export * from './ports/repositories';
export * from './ports/search';
export * from './ports/transaction';
