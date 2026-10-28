/**
 * Knowledge graph (PRD §5.7) and learning timeline (PRD §5.9) contracts.
 *
 * Graph responses always carry totals and truncation flags so the renderer can say when a view
 * is partial. Timeline dates in requests are calendar dates in the workspace timezone; the main
 * process converts them to UTC bounds.
 */

import { RELATIONSHIP_DIRECTIONALITIES, TIMELINE_EVENT_TYPES } from '@mmap/domain';
import { z } from 'zod';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const reflectionInput = z.string().max(10_000).nullable();
/** A UTC instant (ISO 8601); the main process validates range and future dates. */
const instant = z.string().min(10).max(40);
const timelineFilterFields = {
  eventTypes: z.array(z.enum(TIMELINE_EVENT_TYPES)).max(10).optional(),
  tagIds: z.array(z.uuid()).max(20).optional(),
  nodeId: z.uuid().nullable().optional(),
};

const graphFilterFields = {
  tagIds: z.array(z.uuid()).max(20).optional(),
  relationshipTypeIds: z.array(z.uuid()).max(100).optional(),
  mapIds: z.array(z.uuid()).max(200).optional(),
  text: z.string().max(1_000).nullable().optional(),
  includeReferences: z.boolean().optional(),
  /** Also return mind map connectors between the shown nodes. */
  includeConnectors: z.boolean().optional(),
};

export const graphSliceSchema = z.strictObject({
  nodes: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: z.string(),
        degree: z.number().int().nonnegative(),
        /** Mind maps that place the node; membership, not a relationship. */
        mapIds: z.array(z.uuid()).readonly(),
      }),
    )
    .readonly(),
  edges: z
    .array(
      z.strictObject({
        id: z.uuid(),
        sourceNodeId: z.uuid(),
        targetNodeId: z.uuid(),
        typeId: z.uuid(),
        typeLabel: z.string(),
        directionality: z.enum(RELATIONSHIP_DIRECTIONALITIES),
      }),
    )
    .readonly(),
  maps: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: z.string(),
        nodeCount: z.number().int().nonnegative(),
      }),
    )
    .readonly(),
  references: z
    .array(
      z.strictObject({
        sourceNodeId: z.uuid(),
        targetNodeId: z.uuid(),
        occurrences: z.number().int().positive(),
      }),
    )
    .readonly(),
  /** Mind map connectors between shown nodes, one per direction, with the maps they are on. */
  connectors: z
    .array(
      z.strictObject({
        sourceNodeId: z.uuid(),
        targetNodeId: z.uuid(),
        mapIds: z.array(z.uuid()).readonly(),
      }),
    )
    .readonly(),
  totalNodes: z.number().int().nonnegative(),
  edgesTruncated: z.boolean(),
  referencesTruncated: z.boolean(),
  connectorsTruncated: z.boolean(),
});

export const timelineEntrySchema = z.strictObject({
  id: z.uuid(),
  eventType: z.enum(TIMELINE_EVENT_TYPES),
  /** When the action was recorded. */
  occurredAt: z.string(),
  lastActivityAt: z.string(),
  /** When the learning happened, if the user set it; the event is shown at this time. */
  learnedAt: z.string().nullable(),
  /** Title of a learning milestone; null for other events. */
  title: z.string().nullable(),
  /** Null when the node has been deleted. */
  nodeId: z.uuid().nullable(),
  /** The node's current title, or the title recorded with the event if the node is gone. */
  nodeTitle: z.string().nullable(),
  reflection: z.string().nullable(),
  isImported: z.boolean(),
});

/** Graph positions are visual state of the graph view only (PRD §5.7). */
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const graphPositionSchema = z.strictObject({ nodeId: z.uuid(), x: coordinate, y: coordinate });

export type GraphSliceDto = z.infer<typeof graphSliceSchema>;
export type TimelineEntryDto = z.infer<typeof timelineEntrySchema>;

export const graphContracts = {
  overview: {
    request: z.strictObject({
      ...graphFilterFields,
      maxNodes: z.number().int().min(1).max(1_000).optional(),
    }),
    response: graphSliceSchema,
  },
  neighborhood: {
    request: z.strictObject({ nodeId: z.uuid(), ...graphFilterFields }),
    response: graphSliceSchema,
  },
  getPositions: {
    request: z.strictObject({ nodeIds: z.array(z.uuid()).max(5_000) }),
    response: z.strictObject({ positions: z.array(graphPositionSchema).readonly() }),
  },
  savePositions: {
    request: z.strictObject({ positions: z.array(graphPositionSchema).min(1).max(5_000) }),
    response: z.strictObject({ saved: z.literal(true) }),
  },
} as const;

export const timelineContracts = {
  list: {
    request: z.strictObject({
      fromDate: localDate.nullable().optional(),
      toDate: localDate.nullable().optional(),
      ...timelineFilterFields,
      limit: z.number().int().min(1).max(200),
      cursor: z.string().max(1_000).optional(),
    }),
    response: z.strictObject({
      items: z.array(timelineEntrySchema).readonly(),
      nextCursor: z.string().nullable(),
    }),
  },
  /** Events in one window of the visual timeline (spread across it, if many), oldest first, and the total. */
  window: {
    request: z.strictObject({
      fromUtc: instant,
      toUtcExclusive: instant,
      ...timelineFilterFields,
    }),
    response: z.strictObject({
      items: z.array(timelineEntrySchema).readonly(),
      total: z.number().int().nonnegative(),
    }),
  },
  markReviewed: {
    request: z.strictObject({
      nodeId: z.uuid(),
      reflection: reflectionInput.optional(),
      learnedAt: instant.nullable().optional(),
    }),
    response: timelineEntrySchema,
  },
  addMilestone: {
    request: z.strictObject({
      title: z.string().max(1_000),
      details: reflectionInput.optional(),
      nodeId: z.uuid().nullable().optional(),
      learnedAt: instant.nullable().optional(),
    }),
    response: timelineEntrySchema,
  },
  /** Title and reflection on the user's own entries; the learning date on any entry. */
  updateEntry: {
    request: z.strictObject({
      eventId: z.uuid(),
      title: z.string().max(1_000).optional(),
      reflection: reflectionInput.optional(),
      learnedAt: instant.nullable().optional(),
    }),
    response: timelineEntrySchema,
  },
  /** Deletes one of the user's own entries (a review or a milestone). */
  deleteEntry: {
    request: z.strictObject({ eventId: z.uuid() }),
    response: z.strictObject({ deleted: z.literal(true) }),
  },
} as const;
