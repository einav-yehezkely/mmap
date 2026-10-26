/**
 * An opened workspace: its folder, lock, database connections and the services bound to them.
 * Exactly one exists at a time in the main process; the workspace manager owns its lifecycle.
 */

import {
  createKnowledgeNodeService,
  createWorkspaceService,
  type Clock,
  type KnowledgeNodeService,
  type IdGenerator,
  type WorkspaceId,
  type WorkspaceRecord,
  type WorkspaceService,
} from '@mmap/domain';
import {
  DatabaseConfigurationError,
  MigrationFailedError,
  MigrationHistoryError,
  openWorkspaceDatabase,
  SchemaTooNewError,
  SqliteKnowledgeNodeRepository,
  SqliteRelationshipTypeRepository,
  SqliteTimelineEventRepository,
  SqliteWorkspaceRepository,
  type SqliteConnections,
} from '@mmap/storage-sqlite';

import { WorkspaceError } from './workspace-errors';
import type { WorkspaceManifest, WorkspacePaths } from './workspace-folder';
import type { WorkspaceLock } from './workspace-lock';

export interface WorkspaceServices {
  readonly workspace: WorkspaceService;
  readonly nodes: KnowledgeNodeService;
}

export interface OpenWorkspace {
  readonly id: WorkspaceId;
  readonly paths: WorkspacePaths;
  readonly manifest: WorkspaceManifest;
  readonly schemaVersion: number;
  readonly connections: SqliteConnections;
  readonly services: WorkspaceServices;
  /** Flushes queued writes, closes the database and releases the lock. */
  close(): Promise<void>;
}

export interface ServiceDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Binds application services to an opened database, scoped to one workspace ID. */
export function createWorkspaceServices(
  connections: SqliteConnections,
  workspaceId: WorkspaceId,
  dependencies: ServiceDependencies,
): WorkspaceServices {
  return {
    nodes: createKnowledgeNodeService({
      workspaceId,
      transactions: connections,
      nodes: new SqliteKnowledgeNodeRepository(connections),
      timeline: new SqliteTimelineEventRepository(connections),
      ids: dependencies.ids,
      clock: dependencies.clock,
    }),
    workspace: createWorkspaceService({
      transactions: connections,
      workspaces: new SqliteWorkspaceRepository(connections),
      relationshipTypes: new SqliteRelationshipTypeRepository(connections),
      ids: dependencies.ids,
      clock: dependencies.clock,
    }),
  };
}

/**
 * Opens and migrates the workspace database, translating storage failures into workspace errors
 * the user can act on. The caller must already hold the workspace lock.
 */
export async function openWorkspaceStorage(
  paths: WorkspacePaths,
): Promise<{ connections: SqliteConnections; schemaVersion: number }> {
  try {
    const opened = await openWorkspaceDatabase(paths.database, {
      backupDirectory: paths.recovery,
    });
    return {
      connections: opened.connections,
      schemaVersion: opened.migrationPlan.targetVersion,
    };
  } catch (error) {
    if (error instanceof SchemaTooNewError) {
      throw new WorkspaceError('WORKSPACE_TOO_NEW', error.message, { cause: error });
    }
    if (error instanceof DatabaseConfigurationError) {
      throw new WorkspaceError(
        'WORKSPACE_UNSUPPORTED_LOCATION',
        'mmap cannot use a database in this location. Move the workspace to a local drive.',
        { cause: error },
      );
    }
    if (error instanceof MigrationHistoryError || error instanceof MigrationFailedError) {
      throw new WorkspaceError(
        'WORKSPACE_DAMAGED',
        'The workspace database could not be upgraded. Your data was not changed; a backup is ' +
          'in the workspace recovery folder.',
        { cause: error },
      );
    }
    throw new WorkspaceError('WORKSPACE_DAMAGED', 'The workspace database could not be opened.', {
      cause: error,
    });
  }
}

export function createOpenWorkspace(parts: {
  readonly paths: WorkspacePaths;
  readonly manifest: WorkspaceManifest;
  readonly schemaVersion: number;
  readonly connections: SqliteConnections;
  readonly services: WorkspaceServices;
  readonly lock: WorkspaceLock;
}): OpenWorkspace {
  let closing: Promise<void> | null = null;
  return {
    id: parts.manifest.workspaceId as WorkspaceId,
    paths: parts.paths,
    manifest: parts.manifest,
    schemaVersion: parts.schemaVersion,
    connections: parts.connections,
    services: parts.services,
    close() {
      closing ??= (async () => {
        try {
          await parts.connections.close();
        } finally {
          await parts.lock.release();
        }
      })();
      return closing;
    },
  };
}

/** Reads the workspace row, treating a missing row as a damaged workspace. */
export async function loadWorkspaceRecord(
  services: WorkspaceServices,
  workspaceId: WorkspaceId,
): Promise<WorkspaceRecord> {
  try {
    return await services.workspace.get(workspaceId);
  } catch (error) {
    throw new WorkspaceError(
      'WORKSPACE_DAMAGED',
      'The workspace manifest does not match its database.',
      { cause: error },
    );
  }
}
