/**
 * IPC-facing knowledge graph (PRD §5.7) and learning timeline (PRD §5.9) operations. Every call
 * runs against the workspace open at that moment.
 *
 * Domain records are mapped field by field to the DTOs of the strict response schemas, so
 * internal fields (workspace IDs, import origins) never reach the renderer.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import type {
  GraphFilterInput,
  GraphSlice,
  MapId,
  NodeId,
  RelationshipTypeId,
  TagId,
  TimelineEntryRecord,
  TimelineEventId,
} from '@mmap/domain';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { WorkspaceServices } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

type GraphTimelineChannel = Extract<keyof IpcServices, `graph:${string}` | `timeline:${string}`>;

interface FilterFields {
  readonly tagIds?: readonly string[] | undefined;
  readonly relationshipTypeIds?: readonly string[] | undefined;
  readonly mapIds?: readonly string[] | undefined;
  readonly text?: string | null | undefined;
  readonly includeReferences?: boolean | undefined;
  readonly includeConnectors?: boolean | undefined;
}

function toFilters(request: FilterFields): GraphFilterInput {
  return {
    tagIds: (request.tagIds ?? []) as TagId[],
    relationshipTypeIds: (request.relationshipTypeIds ?? []) as RelationshipTypeId[],
    mapIds: (request.mapIds ?? []) as MapId[],
    text: request.text ?? null,
    includeReferences: request.includeReferences ?? false,
    includeConnectors: request.includeConnectors ?? false,
  };
}

function toSliceDto(slice: GraphSlice) {
  return {
    nodes: slice.nodes.map(({ id, title, degree, mapIds }) => ({ id, title, degree, mapIds })),
    maps: slice.maps.map(({ id, title, nodeCount }) => ({ id, title, nodeCount })),
    edges: slice.edges.map(
      ({ id, sourceNodeId, targetNodeId, typeId, typeLabel, directionality }) => ({
        id,
        sourceNodeId,
        targetNodeId,
        typeId,
        typeLabel,
        directionality,
      }),
    ),
    references: slice.references.map(({ sourceNodeId, targetNodeId, occurrences }) => ({
      sourceNodeId,
      targetNodeId,
      occurrences,
    })),
    connectors: slice.connectors.map(({ sourceNodeId, targetNodeId, mapIds }) => ({
      sourceNodeId,
      targetNodeId,
      mapIds,
    })),
    totalNodes: slice.totalNodes,
    edgesTruncated: slice.edgesTruncated,
    referencesTruncated: slice.referencesTruncated,
    connectorsTruncated: slice.connectorsTruncated,
  };
}

export function toTimelineEntryDto(entry: TimelineEntryRecord): TimelineEntryDto {
  return {
    id: entry.id,
    eventType: entry.eventType,
    occurredAt: entry.occurredAt,
    lastActivityAt: entry.lastActivityAt,
    learnedAt: entry.learnedAt,
    title: entry.title,
    nodeId: entry.nodeId,
    nodeTitle: entry.currentNodeTitle ?? entry.nodeTitleSnapshot,
    reflection: entry.reflection,
    isImported: entry.isImported,
  };
}

export function createGraphTimelineIpcServices(
  manager: WorkspaceManager,
): Pick<IpcServices, GraphTimelineChannel> {
  const services = (): WorkspaceServices => {
    const workspace = manager.current;
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace.services;
  };

  return {
    'graph:overview': async (request) =>
      toSliceDto(await services().graph.overview(toFilters(request), request.maxNodes)),
    'graph:neighborhood': async (request) =>
      toSliceDto(await services().graph.neighborhood(request.nodeId as NodeId, toFilters(request))),
    'graph:get-positions': async ({ nodeIds }) => ({
      positions: (await services().graph.positions(nodeIds as NodeId[])).map(
        ({ nodeId, x, y }) => ({ nodeId, x, y }),
      ),
    }),
    'graph:save-positions': async ({ positions }) => {
      await services().graph.savePositions(
        positions.map(({ nodeId, x, y }) => ({ nodeId: nodeId as NodeId, x, y })),
      );
      return { saved: true as const };
    },
    'timeline:list': async (request) => {
      const page = await services().timeline.list({
        fromDate: request.fromDate ?? null,
        toDate: request.toDate ?? null,
        eventTypes: request.eventTypes ?? [],
        tagIds: (request.tagIds ?? []) as TagId[],
        nodeId: (request.nodeId ?? null) as NodeId | null,
        page: { limit: request.limit, cursor: request.cursor },
      });
      return { items: page.items.map(toTimelineEntryDto), nextCursor: page.nextCursor };
    },
    'timeline:window': async (request) => {
      const window = await services().timeline.window({
        fromUtc: request.fromUtc,
        toUtcExclusive: request.toUtcExclusive,
        eventTypes: request.eventTypes ?? [],
        tagIds: (request.tagIds ?? []) as TagId[],
        nodeId: (request.nodeId ?? null) as NodeId | null,
      });
      return { items: window.items.map(toTimelineEntryDto), total: window.total };
    },
    'timeline:mark-reviewed': async ({ nodeId, reflection, learnedAt }) =>
      toTimelineEntryDto(
        await services().timeline.markReviewed(
          nodeId as NodeId,
          reflection ?? null,
          learnedAt ?? null,
        ),
      ),
    'timeline:add-milestone': async ({ title, details, nodeId, learnedAt }) =>
      toTimelineEntryDto(
        await services().timeline.addMilestone({
          title,
          details: details ?? null,
          nodeId: (nodeId ?? null) as NodeId | null,
          learnedAt: learnedAt ?? null,
        }),
      ),
    'timeline:update-entry': async ({ eventId, title, reflection, learnedAt }) =>
      toTimelineEntryDto(
        await services().timeline.updateEntry(eventId as TimelineEventId, {
          ...(title === undefined ? {} : { title }),
          ...(reflection === undefined ? {} : { reflection }),
          ...(learnedAt === undefined ? {} : { learnedAt }),
        }),
      ),
    'timeline:delete-entry': async ({ eventId }) => {
      await services().timeline.deleteEntry(eventId as TimelineEventId);
      return { deleted: true as const };
    },
  };
}
