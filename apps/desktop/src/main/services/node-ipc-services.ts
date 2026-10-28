/**
 * IPC-facing knowledge node and tag operations. Each call runs against the workspace that is open at the
 * moment the request is handled; requests while no workspace is open fail with a clear error.
 */

import type { MapId, NodeId, PlacementId, RelationshipTypeId, TagId } from '@mmap/domain';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { OpenWorkspace, WorkspaceServices } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

type NodeChannel = Extract<
  keyof IpcServices,
  `nodes:${string}` | `tags:${string}` | `search:${string}`
>;

export function createNodeIpcServices(manager: WorkspaceManager): Pick<IpcServices, NodeChannel> {
  const requireWorkspace = (): OpenWorkspace => {
    const workspace = manager.current;
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace;
  };
  const services = (): WorkspaceServices => requireWorkspace().services;

  return {
    'nodes:list': ({ sort, limit, cursor, tagIds = [] }) =>
      services().nodes.list({ sort, page: { limit, cursor }, tagIds: tagIds as TagId[] }),
    'nodes:get': ({ nodeId }) => services().nodes.get(nodeId as NodeId),
    'nodes:lookup': async ({ text, limit = 8, excludeNodeIds = [], excludeOnMapId }) => ({
      items: (
        await services().search.lookupTitles(
          requireWorkspace().id,
          text,
          limit,
          excludeNodeIds as NodeId[],
          excludeOnMapId as MapId | undefined,
        )
      ).map((match) => ({ id: match.nodeId, title: match.title })),
    }),
    'nodes:backlinks': async ({ nodeId }) => ({
      items: await services().nodes.backlinks(nodeId as NodeId),
    }),
    'nodes:resolve-links': async ({ nodeIds }) => ({
      items: await services().nodes.resolveLinkTargets(nodeIds as NodeId[]),
    }),
    'search:query': ({ text, tagIds = [], relationshipTypeIds = [], limit, cursor }) =>
      services().search.search({
        workspaceId: requireWorkspace().id,
        text,
        tagIds: tagIds as TagId[],
        relationshipTypeIds: relationshipTypeIds as RelationshipTypeId[],
        page: { limit, cursor },
      }),
    'nodes:create': ({ title, summary, addToMaps }) => {
      const targets = [
        ...new Map((addToMaps ?? []).map((target) => [target.mapId, target])).values(),
      ];
      if (targets.length === 0) return services().nodes.create({ title, summary: summary ?? null });
      // One canonical node, placed on every chosen map, all in one transaction: if any map
      // rejects the placement (for example a parent that no longer exists), nothing is created.
      const workspace = requireWorkspace();
      return workspace.connections.runInTransaction(async () => {
        const node = await workspace.services.nodes.create({ title, summary: summary ?? null });
        for (const target of targets) {
          await workspace.services.maps.placeNode(
            target.mapId as MapId,
            node.id,
            target.parentPlacementId as PlacementId | null,
          );
        }
        return node;
      });
    },
    'nodes:update': ({ nodeId, expectedRevision, changes }) =>
      services().nodes.update(nodeId as NodeId, expectedRevision, changes),
    'nodes:duplicate': ({ nodeId }) => services().nodes.duplicate(nodeId as NodeId),
    'nodes:preview-delete': ({ nodeId }) => services().nodes.previewDelete(nodeId as NodeId),
    'nodes:delete': async ({ nodeId, expectedRevision }) => {
      const workspace = requireWorkspace();
      // Remember the node's files, delete the node (which removes their rows), then delete the
      // files. A crash in between leaves orphans that the next workspace open cleans up.
      const attachments = await workspace.services.attachments.listForNode(nodeId as NodeId);
      const files = await Promise.all(
        attachments.map((attachment) =>
          workspace.services.attachments.getStoredFile(attachment.id),
        ),
      );
      await workspace.services.nodes.delete(nodeId as NodeId, expectedRevision);
      for (const file of files) {
        await workspace.attachmentStore.remove(file.relativePath).catch(() => undefined);
      }
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
