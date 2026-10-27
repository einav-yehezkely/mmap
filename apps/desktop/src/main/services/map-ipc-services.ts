/**
 * IPC-facing mind map operations (PRD §5.6). Every call runs against the workspace open at that
 * moment.
 *
 * Domain records are mapped to explicit DTOs here: the strict response schemas reject unknown
 * fields, and mapping field by field keeps internal data (workspace IDs, timestamps that the
 * renderer does not use) out of the renderer.
 */

import type {
  MapConnectionId,
  MapId,
  MapService,
  MapView,
  NodeId,
  PlacementId,
  RelationshipId,
} from '@mmap/domain';
import type { MapViewDto } from '@mmap/contracts';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

type MapChannel = Extract<keyof IpcServices, `maps:${string}`>;

export function toMapViewDto(view: MapView): MapViewDto {
  const { map } = view;
  return {
    map: {
      id: map.id,
      title: map.title,
      mode: map.mode,
      viewport: { x: map.viewport.x, y: map.viewport.y, zoom: map.viewport.zoom },
      revision: map.revision,
      updatedAt: map.updatedAt,
    },
    placements: view.placements.map((placement) => ({
      id: placement.id,
      nodeId: placement.nodeId,
      nodeTitle: placement.nodeTitle,
      x: placement.x,
      y: placement.y,
      parentPlacementId: placement.parentPlacementId,
      siblingOrder: placement.siblingOrder,
      isCollapsed: placement.isCollapsed,
      color: placement.style.color,
    })),
    connections: view.connections.map((connection) => ({
      id: connection.id,
      sourcePlacementId: connection.sourcePlacementId,
      targetPlacementId: connection.targetPlacementId,
      label: connection.label,
      relationshipId: connection.relationshipId,
      relationshipTypeLabel: connection.relationshipTypeLabel,
    })),
    relationships: view.relationships.map((relationship) => ({
      id: relationship.id,
      sourceNodeId: relationship.sourceNodeId,
      targetNodeId: relationship.targetNodeId,
      typeLabel: relationship.typeLabel,
      directionality: relationship.directionality,
    })),
  };
}

export function createMapIpcServices(manager: WorkspaceManager): Pick<IpcServices, MapChannel> {
  const workspace = () => {
    const current = manager.current;
    if (current === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return current;
  };
  const maps = (): MapService => workspace().services.maps;
  const mapsOfNode = async (nodeId: string) => ({
    items: (await maps().mapsForNode(nodeId as NodeId)).map(({ id, title, mode }) => ({
      id,
      title,
      mode,
    })),
  });

  return {
    'maps:list-for-node': ({ nodeId }) => mapsOfNode(nodeId),
    'maps:add-node': async ({ nodeId, targets }) => {
      const open = workspace();
      const unique = [...new Map(targets.map((target) => [target.mapId, target])).values()];
      // All or nothing: a rejected placement (for example a parent that was removed meanwhile)
      // leaves every map unchanged.
      await open.connections.runInTransaction(async () => {
        for (const target of unique) {
          await open.services.maps.placeNode(
            target.mapId as MapId,
            nodeId as NodeId,
            target.parentPlacementId as PlacementId | null,
          );
        }
      });
      return mapsOfNode(nodeId);
    },
    'maps:list': async () => ({
      items: (await maps().listMaps()).map(
        ({ id, title, mode, revision, placementCount, updatedAt }) => ({
          id,
          title,
          mode,
          revision,
          placementCount,
          updatedAt,
        }),
      ),
    }),
    'maps:create': async ({ title, mode }) => toMapViewDto(await maps().createMap(title, mode)),
    'maps:get': async ({ mapId }) => toMapViewDto(await maps().getMap(mapId as MapId)),
    'maps:rename': async ({ mapId, expectedRevision, title }) =>
      toMapViewDto(await maps().renameMap(mapId as MapId, expectedRevision, title)),
    'maps:duplicate': async ({ mapId }) => toMapViewDto(await maps().duplicateMap(mapId as MapId)),
    'maps:delete': async ({ mapId }) => {
      await maps().deleteMap(mapId as MapId);
      return { deleted: true as const };
    },
    'maps:set-viewport': async ({ mapId, viewport }) => {
      await maps().setViewport(mapId as MapId, viewport);
      return { saved: true as const };
    },
    'maps:add-placement': async (request) => {
      const position = {
        x: request.x,
        y: request.y,
        parentPlacementId: (request.parentPlacementId ?? null) as PlacementId | null,
      };
      const input =
        'nodeId' in request
          ? { ...position, nodeId: request.nodeId as NodeId }
          : { ...position, newNodeTitle: request.newNodeTitle };
      return toMapViewDto(
        await maps().addPlacement(request.mapId as MapId, request.expectedRevision, input),
      );
    },
    'maps:remove-placement': async ({ mapId, expectedRevision, placementId }) =>
      toMapViewDto(
        await maps().removePlacement(mapId as MapId, expectedRevision, placementId as PlacementId),
      ),
    'maps:move-placements': async ({ mapId, expectedRevision, changes }) =>
      toMapViewDto(
        await maps().movePlacements(
          mapId as MapId,
          expectedRevision,
          changes.map((change) => ({ ...change, placementId: change.placementId as PlacementId })),
        ),
      ),
    'maps:reparent': async ({ mapId, expectedRevision, placementId, parentPlacementId, index }) =>
      toMapViewDto(
        await maps().reparent(
          mapId as MapId,
          expectedRevision,
          placementId as PlacementId,
          parentPlacementId as PlacementId | null,
          index,
        ),
      ),
    'maps:set-collapsed': async ({ mapId, expectedRevision, placementId, collapsed }) =>
      toMapViewDto(
        await maps().setCollapsed(
          mapId as MapId,
          expectedRevision,
          placementId as PlacementId,
          collapsed,
        ),
      ),
    'maps:set-placement-color': async ({ mapId, expectedRevision, placementId, color }) =>
      toMapViewDto(
        await maps().setPlacementStyle(
          mapId as MapId,
          expectedRevision,
          placementId as PlacementId,
          {
            color,
          },
        ),
      ),
    'maps:add-connection': async (request) =>
      toMapViewDto(
        await maps().addConnection(request.mapId as MapId, request.expectedRevision, {
          sourcePlacementId: request.sourcePlacementId as PlacementId,
          targetPlacementId: request.targetPlacementId as PlacementId,
          label: request.label ?? null,
          relationshipId: (request.relationshipId ?? null) as RelationshipId | null,
        }),
      ),
    'maps:remove-connection': async ({ mapId, expectedRevision, connectionId }) =>
      toMapViewDto(
        await maps().removeConnection(
          mapId as MapId,
          expectedRevision,
          connectionId as MapConnectionId,
        ),
      ),
    'maps:propose-hierarchy': async ({ mapId }) => {
      const proposal = await maps().proposeHierarchy(mapId as MapId);
      return {
        source: proposal.source,
        parents: [...proposal.parents].map(([placementId, parentPlacementId]) => ({
          placementId,
          parentPlacementId,
        })),
        ambiguous: proposal.ambiguous.map(({ id, candidates }) => ({
          placementId: id,
          candidates,
        })),
      };
    },
    'maps:switch-mode': async ({ mapId, expectedRevision, mode, parents }) =>
      toMapViewDto(
        await maps().switchMode(
          mapId as MapId,
          expectedRevision,
          mode,
          parents === undefined
            ? undefined
            : new Map(
                parents.map(({ placementId, parentPlacementId }) => [
                  placementId as PlacementId,
                  parentPlacementId as PlacementId | null,
                ]),
              ),
        ),
      ),
  };
}
