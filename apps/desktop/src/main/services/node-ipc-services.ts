/**
 * IPC-facing knowledge node operations. Each call runs against the workspace that is open at the
 * moment the request is handled; requests while no workspace is open fail with a clear error.
 */

import type { NodeId } from '@mmap/domain';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { WorkspaceServices } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

type NodeChannel = Extract<keyof IpcServices, `nodes:${string}`>;

export function createNodeIpcServices(manager: WorkspaceManager): Pick<IpcServices, NodeChannel> {
  const services = (): WorkspaceServices => {
    const workspace = manager.current;
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace.services;
  };

  return {
    'nodes:list': ({ sort, limit, cursor }) =>
      services().nodes.list({ sort, page: { limit, cursor } }),
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
  };
}
