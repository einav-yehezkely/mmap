/**
 * IPC-facing relationship and relationship-type operations (PRD §5.5). Every call runs against
 * the workspace open at that moment.
 */

import type { NodeId, RelationshipId, RelationshipTypeId } from '@mmap/domain';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { WorkspaceServices } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

type RelationshipChannel = Extract<
  keyof IpcServices,
  `relationships:${string}` | `relationship-types:${string}`
>;

export function createRelationshipIpcServices(
  manager: WorkspaceManager,
): Pick<IpcServices, RelationshipChannel> {
  const services = (): WorkspaceServices => {
    const workspace = manager.current;
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace.services;
  };

  return {
    'relationship-types:list': async () => ({
      items: await services().relationships.listTypes(),
    }),
    'relationship-types:create': ({ label, directionality }) =>
      services().relationships.createType(label, directionality),
    'relationship-types:rename': ({ typeId, label }) =>
      services().relationships.renameType(typeId as RelationshipTypeId, label),
    'relationship-types:set-archived': ({ typeId, archived }) =>
      services().relationships.setTypeArchived(typeId as RelationshipTypeId, archived),
    'relationship-types:set-directionality': ({ typeId, directionality }) =>
      services().relationships.changeTypeDirectionality(
        typeId as RelationshipTypeId,
        directionality,
      ),
    'relationships:list-for-node': async ({ nodeId }) => ({
      items: await services().relationships.listForNode(nodeId as NodeId),
    }),
    'relationships:create': ({ sourceNodeId, targetNodeId, typeId, description }) =>
      services().relationships.create({
        sourceNodeId: sourceNodeId as NodeId,
        targetNodeId: targetNodeId as NodeId,
        typeId: typeId as RelationshipTypeId,
        description: description ?? null,
      }),
    'relationships:update': ({ relationshipId, changes }) =>
      services().relationships.update(relationshipId as RelationshipId, {
        ...(changes.typeId === undefined ? {} : { typeId: changes.typeId as RelationshipTypeId }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.reverseDirection === undefined
          ? {}
          : { reverseDirection: changes.reverseDirection }),
      }),
    'relationships:delete': async ({ relationshipId }) => {
      await services().relationships.delete(relationshipId as RelationshipId);
      return { deleted: true as const };
    },
  };
}
