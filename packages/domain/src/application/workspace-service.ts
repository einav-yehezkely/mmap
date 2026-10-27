/**
 * Application service for workspace records inside a workspace database.
 *
 * This covers the database side only (the workspace row and its starter relationship types).
 * Folders, manifests and locks are desktop concerns handled by the main process, so a future
 * server adapter can reuse this service unchanged (PRD §7.2).
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { IdGenerator, RelationshipTypeId, WorkspaceId } from '../ids';
import { BUILTIN_RELATIONSHIP_TYPES } from '../knowledge/builtin-relationship-types';
import type {
  RelationshipTypeRepository,
  WorkspaceRecord,
  WorkspaceRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';
import { toNormalizedLabel } from '../text/labels';
import { normalizeWorkspaceName } from '../workspace/workspace-name';

export interface WorkspaceServiceDependencies {
  readonly transactions: TransactionRunner;
  readonly workspaces: WorkspaceRepository;
  readonly relationshipTypes: RelationshipTypeRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface WorkspaceService {
  /**
   * Creates the workspace row and the built-in relationship types in one transaction, using a
   * caller-provided ID so the folder manifest and the database agree on identity.
   */
  initialize(workspaceId: WorkspaceId, rawName: string, timezone: string): Promise<WorkspaceRecord>;
  get(workspaceId: WorkspaceId): Promise<WorkspaceRecord>;
  rename(workspaceId: WorkspaceId, rawName: string): Promise<WorkspaceRecord>;
}

export function createWorkspaceService(
  dependencies: WorkspaceServiceDependencies,
): WorkspaceService {
  const { transactions, workspaces, relationshipTypes, ids, clock } = dependencies;

  async function get(workspaceId: WorkspaceId): Promise<WorkspaceRecord> {
    const workspace = await workspaces.findById(workspaceId);
    if (workspace === null) {
      throw new DomainError('NOT_FOUND', 'This workspace could not be found.');
    }
    return workspace;
  }

  return {
    initialize: (workspaceId, rawName, timezone) =>
      transactions.runInTransaction(async () => {
        const now = clock.now();
        const record: WorkspaceRecord = {
          id: workspaceId,
          name: normalizeWorkspaceName(rawName),
          timezone,
          createdAt: now,
          updatedAt: now,
        };
        await workspaces.insert(record);
        for (const builtin of BUILTIN_RELATIONSHIP_TYPES) {
          await relationshipTypes.insert({
            id: ids.newId() as RelationshipTypeId,
            workspaceId,
            label: builtin.label,
            normalizedLabel: toNormalizedLabel(builtin.label),
            directionality: builtin.directionality,
            isArchived: false,
            isBuiltin: true,
            createdAt: now,
            updatedAt: now,
          });
        }
        return record;
      }),

    get,

    rename: (workspaceId, rawName) =>
      transactions.runInTransaction(async () => {
        const name = normalizeWorkspaceName(rawName);
        const now = clock.now();
        await get(workspaceId);
        await workspaces.rename(workspaceId, name, now);
        return get(workspaceId);
      }),
  };
}
