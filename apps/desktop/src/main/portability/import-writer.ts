/**
 * Writes the records of a planned import through a database connection of its own, so the work
 * can run in a worker thread (PRD §9: "Keep the UI responsive with workers").
 *
 * Writing 10,000 nodes with their relationships, references, maps and history takes several
 * seconds. On the main process thread that froze the whole app: `node:sqlite` is synchronous, and
 * the awaits inside the transaction resolve at once, so the event loop never got a turn. In a
 * worker the main process stays free; it holds the workspace's write queue meanwhile
 * (`SqliteConnections.runExclusive`), so the worker's connection is the only writer, and reads
 * keep working (WAL). Either every record is committed or none is, exactly as before: the worker
 * runs the same `ImportService.apply` in one transaction, and a crash before the commit leaves
 * nothing behind.
 *
 * `writeImport` is a plain async function, so tests run it in-process; `workers/import-worker.ts`
 * only passes messages to it.
 */

import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import {
  createImportService,
  DOMAIN_ERROR_CODES,
  DomainError,
  isDomainError,
  toUtcTimestamp,
  type AttachmentId,
  type DomainErrorCode,
  type ImportPlan,
  type WorkspaceId,
} from '@mmap/domain';
import {
  openDatabase,
  SqliteAttachmentRepository,
  SqliteConnections,
  SqliteGraphLayoutRepository,
  SqliteImportHistoryRepository,
  SqliteKnowledgeNodeRepository,
  SqliteMapRepository,
  SqliteNoteReferenceRepository,
  SqliteRelationshipRepository,
  SqliteRelationshipTypeRepository,
  SqliteTagRepository,
  SqliteTimelineEventRepository,
} from '@mmap/storage-sqlite';

import type { OpenWorkspace } from '../workspaces/open-workspace';

/** Everything the worker needs; structured-cloneable (the plan's ID map is a `Map`). */
export interface ImportWriteJob {
  readonly databasePath: string;
  readonly workspaceId: string;
  readonly plan: ImportPlan;
  readonly exportId: string;
  /** Planned attachment ID → storage path of its copied file. */
  readonly storedFiles: readonly (readonly [string, string])[];
}

/** An error as it crosses the thread boundary (class and custom fields do not survive cloning). */
export interface TransferredError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export type ImportWriteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly error: TransferredError };

/** Writes the planned records through a new connection to the workspace database. */
export async function writeImport(job: ImportWriteJob): Promise<void> {
  // The database is already open and migrated by the main process; this only adds a connection.
  const connection = openDatabase(job.databasePath);
  try {
    // Every read and write of `apply` happens inside its transaction, on this one connection.
    const connections = new SqliteConnections(connection, connection);
    const importer = createImportService({
      workspaceId: job.workspaceId as WorkspaceId,
      transactions: connections,
      nodes: new SqliteKnowledgeNodeRepository(connections),
      tags: new SqliteTagRepository(connections),
      relationshipTypes: new SqliteRelationshipTypeRepository(connections),
      relationships: new SqliteRelationshipRepository(connections),
      references: new SqliteNoteReferenceRepository(connections),
      maps: new SqliteMapRepository(connections),
      timeline: new SqliteTimelineEventRepository(connections),
      attachments: new SqliteAttachmentRepository(connections),
      graphLayout: new SqliteGraphLayoutRepository(connections),
      importHistory: new SqliteImportHistoryRepository(connections),
      ids: { newId: () => randomUUID() },
      clock: { now: () => toUtcTimestamp(new Date()) },
    });
    await importer.apply(
      job.plan,
      job.exportId,
      new Map(job.storedFiles.map(([id, path]) => [id as AttachmentId, path])),
    );
  } finally {
    // Closed without a checkpoint: the main process still has the database open and folds the
    // log in when it closes the workspace.
    if (connection.isOpen) connection.close();
  }
}

export function toTransferredError(error: unknown): TransferredError {
  if (isDomainError(error)) {
    return { name: error.name, message: error.message, code: error.code };
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Domain errors come back as `DomainError`, so the renderer gets their code and message. */
export function fromTransferredError(error: TransferredError): Error {
  if (
    error.name === 'DomainError' &&
    (DOMAIN_ERROR_CODES as readonly string[]).includes(error.code ?? '')
  ) {
    return new DomainError(error.code as DomainErrorCode, error.message);
  }
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

/** Writes the planned records of an import into the open workspace. */
export type ImportRecordWriter = (
  workspace: OpenWorkspace,
  plan: ImportPlan,
  exportId: string,
  storedFiles: ReadonlyMap<AttachmentId, string>,
) => Promise<void>;

/** In the main process, through the workspace's own services (tests, and the fallback). */
export const writeImportInProcess: ImportRecordWriter = (workspace, plan, exportId, storedFiles) =>
  workspace.services.importer.apply(plan, exportId, storedFiles);

/**
 * In a worker thread started from `workerUrl` (the bundled `import-worker.js`), while the
 * workspace's write queue is held. One worker per import: imports are rare, and a fresh thread
 * leaves nothing behind.
 */
export function workerImportWriter(workerUrl: URL): ImportRecordWriter {
  return (workspace, plan, exportId, storedFiles) =>
    workspace.connections.runExclusive(() =>
      runImportWorker(workerUrl, {
        databasePath: workspace.paths.database,
        workspaceId: workspace.id,
        plan,
        exportId,
        storedFiles: [...storedFiles],
      }),
    );
}

function runImportWorker(workerUrl: URL, job: ImportWriteJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    let settled = false;
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      if (error === null) resolve();
      else reject(error);
    };
    worker.once('message', (outcome: ImportWriteOutcome) =>
      settle(outcome.ok ? null : fromTransferredError(outcome.error)),
    );
    worker.once('error', (error: Error) => settle(error));
    // Exiting without an answer means the thread died; an open transaction was rolled back.
    worker.once('exit', (code) =>
      settle(new Error(`The import worker stopped before finishing (exit code ${code}).`)),
    );
    worker.postMessage(job);
  });
}
