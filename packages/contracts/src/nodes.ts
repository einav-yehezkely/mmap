/**
 * Knowledge node contracts (PRD §5.2).
 *
 * Note documents cross the boundary as plain JSON. The request schema deliberately accepts any
 * JSON value for `note`: the authoritative validation is `parseNoteDocument` in the domain, which
 * the main process runs before anything is stored. Duplicating that recursive schema here would
 * create two rule sets that could drift apart (PRD §10.1: no duplicated business rules).
 */

import type { NoteDocument } from '@mmap/domain';
import { NODE_SORT_ORDERS } from '@mmap/domain';
import { z } from 'zod';

const nodeIdSchema = z.uuid();
const revisionSchema = z.number().int().positive();

/** Generous transport limits; the domain applies the real (smaller) limits with clear messages. */
const titleInput = z.string().max(1_000);
const summaryInput = z.string().max(10_000).nullable();

export const tagSummarySchema = z.strictObject({ id: z.uuid(), label: z.string() });
export type TagSummaryView = z.infer<typeof tagSummarySchema>;
const tagListSchema = z.array(tagSummarySchema).readonly();

const noteDocumentOutput = z.custom<NoteDocument>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);

export const nodeViewSchema = z.strictObject({
  id: nodeIdSchema,
  title: z.string(),
  summary: z.string().nullable(),
  note: noteDocumentOutput,
  revision: revisionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: tagListSchema,
});

export const nodeSummarySchema = z.strictObject({
  id: nodeIdSchema,
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tags: tagListSchema,
});

export const nodeDependentsSchema = z.strictObject({
  relationships: z.number().int().nonnegative(),
  referencingNotes: z.number().int().nonnegative(),
  mapPlacements: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
});

export type NodeView = z.infer<typeof nodeViewSchema>;
export type NodeSummary = z.infer<typeof nodeSummarySchema>;
export type NodeDependentsView = z.infer<typeof nodeDependentsSchema>;

export const nodeContracts = {
  list: {
    request: z.strictObject({
      sort: z.enum(NODE_SORT_ORDERS),
      limit: z.number().int().min(1).max(200),
      cursor: z.string().max(1_000).optional(),
      /** Only nodes carrying all of these tags. */
      tagIds: z.array(z.uuid()).max(20).optional(),
    }),
    response: z.strictObject({
      items: z.array(nodeSummarySchema).readonly(),
      nextCursor: z.string().nullable(),
      totalCount: z.number().int().nonnegative(),
    }),
  },
  get: {
    request: z.strictObject({ nodeId: nodeIdSchema }),
    response: nodeViewSchema,
  },
  create: {
    request: z.strictObject({
      title: titleInput,
      summary: summaryInput.optional(),
      /**
       * Mind maps to add the new node to ("Add to Mind Maps"), each optionally under a parent
       * placement (hierarchical maps). The node and all placements are created together.
       */
      addToMaps: z
        .array(z.strictObject({ mapId: z.uuid(), parentPlacementId: z.uuid().nullable() }))
        .max(50)
        .optional(),
    }),
    response: nodeViewSchema,
  },
  update: {
    request: z.strictObject({
      nodeId: nodeIdSchema,
      expectedRevision: revisionSchema,
      changes: z.strictObject({
        title: titleInput.optional(),
        summary: summaryInput.optional(),
        note: z.unknown().optional(),
      }),
    }),
    response: nodeViewSchema,
  },
  duplicate: {
    request: z.strictObject({ nodeId: nodeIdSchema }),
    response: nodeViewSchema,
  },
  previewDelete: {
    request: z.strictObject({ nodeId: nodeIdSchema }),
    response: nodeDependentsSchema,
  },
  delete: {
    request: z.strictObject({ nodeId: nodeIdSchema, expectedRevision: revisionSchema }),
    response: z.strictObject({ deleted: z.literal(true) }),
  },
  /** Deterministic title lookup for node pickers (PRD §5.8). */
  lookup: {
    request: z.strictObject({
      text: z.string().max(200),
      limit: z.number().int().min(1).max(50).optional(),
      excludeNodeIds: z.array(nodeIdSchema).max(50).optional(),
    }),
    response: z.strictObject({
      items: z.array(z.strictObject({ id: nodeIdSchema, title: z.string() })).readonly(),
    }),
  },
  backlinks: {
    request: z.strictObject({ nodeId: nodeIdSchema }),
    response: z.strictObject({
      items: z
        .array(
          z.strictObject({
            sourceNodeId: nodeIdSchema,
            sourceTitle: z.string(),
            label: z.string(),
            excerpt: z.string(),
            occurrences: z.number().int().positive(),
          }),
        )
        .readonly(),
    }),
  },
  /** Current titles of wikilink targets that still exist (missing ones render as unresolved). */
  resolveLinks: {
    request: z.strictObject({ nodeIds: z.array(nodeIdSchema).max(1_000) }),
    response: z.strictObject({
      items: z.array(z.strictObject({ id: nodeIdSchema, title: z.string() })).readonly(),
    }),
  },
  addTag: {
    request: z.strictObject({ nodeId: nodeIdSchema, label: z.string().max(500) }),
    response: z.strictObject({ tags: tagListSchema }),
  },
  removeTag: {
    request: z.strictObject({ nodeId: nodeIdSchema, tagId: z.uuid() }),
    response: z.strictObject({ tags: tagListSchema }),
  },
} as const;

/** Full-text search (PRD §5.8). Snippets are plain-text segments, never HTML. */
export const searchContracts = {
  query: {
    request: z.strictObject({
      text: z.string().max(1_000),
      tagIds: z.array(z.uuid()).max(20).optional(),
      limit: z.number().int().min(1).max(100),
      cursor: z.string().max(200).optional(),
    }),
    response: z.strictObject({
      items: z
        .array(
          z.strictObject({
            nodeId: nodeIdSchema,
            title: z.string(),
            snippet: z.array(z.strictObject({ text: z.string(), isMatch: z.boolean() })).readonly(),
          }),
        )
        .readonly(),
      nextCursor: z.string().nullable(),
      totalCount: z.number().int().nonnegative(),
    }),
  },
} as const;

/** Workspace tag management (PRD §5.8). */
export const tagContracts = {
  list: {
    request: z.undefined(),
    response: z.strictObject({
      items: z
        .array(
          z.strictObject({
            id: z.uuid(),
            label: z.string(),
            nodeCount: z.number().int().nonnegative(),
          }),
        )
        .readonly(),
    }),
  },
  create: {
    request: z.strictObject({ label: z.string().max(500) }),
    response: tagSummarySchema,
  },
  rename: {
    request: z.strictObject({ tagId: z.uuid(), label: z.string().max(500) }),
    response: tagSummarySchema,
  },
  delete: {
    request: z.strictObject({ tagId: z.uuid() }),
    response: z.strictObject({ deleted: z.literal(true) }),
  },
} as const;
