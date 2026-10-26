/**
 * IPC-facing knowledge node and tag operations. Each call runs against the workspace that is open at the
 * moment the request is handled; requests while no workspace is open fail with a clear error.
 */

import type { NodeId, TagId } from '@mmap/domain';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { WorkspaceServices } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

type NodeChannel = Extract<keyof IpcServices, `nodes:${string}` | `tags:${string}`>;

export function createNodeIpcServices(manager: WorkspaceManager): Pick<IpcServices, NodeChannel> {
  const services = (): WorkspaceServices => {
    const workspace = manager.current;
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace.services;
  };

  return {
    'nodes:list': ({ sort, limit, cursor, tagIds = [] }) =>
      services().nodes.list({ sort, page: { limit, cursor }, tagIds: tagIds as TagId[] }),
    'nodes:get': ({ nodeId }) => services().nodes.get(nodeId as NodeId),
    'nodes:create': ({ title, summary }) =>
      services().nodes.create({ title, summary: summary ?? null }),
    'nodes:update': ({ nodeId, expectedRevision, changes }) =>
      services().nodes.update(nodeId as NodeId, expectedRevision, changes),
    'nodes:duplicate': ({ nodeId }) => services().nodes.duplicate(nodeId as NodeId),
    'nodes:preview-delete': ({ nodeId }) => services().nodes.previewDelete(nodeId as NodeId),
    'nodes:delete': async ({ nodeId, expectedRevision }) => {
      await services().nodes.delete(nodeId as NodeId, expectedRevision);
      return { deleted: true as const };
    },
    'nodes:add-tag': async ({ nodeId, label }) => ({
      tags: await services().tags.assignToNode(nodeId as NodeId, label),
    }),
    'nodes:remove-tag': async ({ nodeId, tagId }) => ({
      tags: await services().tags.removeFromNode(nodeId as NodeId, tagId as TagId),
    }),
    'tags:list': async () => ({ items: await services().tags.list() }),
    'tags:create': ({ label }) => services().tags.create(label),
    'tags:rename': ({ tagId, label }) => services().tags.rename(tagId as TagId, label),
    'tags:delete': async ({ tagId }) => {
      await services().tags.delete(tagId as TagId);
      return { deleted: true as const };
    },
  };
}
