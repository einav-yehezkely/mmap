/**
 * Typed semantic relationship contracts (PRD §4.2, §5.5).
 *
 * Relationships are always created by an explicit user action; no other operation (wikilinks,
 * map structure) creates them (PRD §4.3, §4.4).
 */

import { RELATIONSHIP_DIRECTIONALITIES } from '@mmap/domain';
import { z } from 'zod';

const directionalitySchema = z.enum(RELATIONSHIP_DIRECTIONALITIES);
const labelInput = z.string().max(500);
const descriptionInput = z.string().max(10_000).nullable();

export const relationshipTypeViewSchema = z.strictObject({
  id: z.uuid(),
  label: z.string(),
  directionality: directionalitySchema,
  isArchived: z.boolean(),
  isBuiltin: z.boolean(),
  usageCount: z.number().int().nonnegative(),
});

const nodeReferenceSchema = z.strictObject({ id: z.uuid(), title: z.string() });

export const relationshipViewSchema = z.strictObject({
  id: z.uuid(),
  typeId: z.uuid(),
  typeLabel: z.string(),
  directionality: directionalitySchema,
  description: z.string().nullable(),
  source: nodeReferenceSchema,
  target: nodeReferenceSchema,
  createdAt: z.string(),
});

export type RelationshipTypeViewDto = z.infer<typeof relationshipTypeViewSchema>;
export type RelationshipViewDto = z.infer<typeof relationshipViewSchema>;

const typeListResponse = z.strictObject({
  items: z.array(relationshipTypeViewSchema).readonly(),
});

export const relationshipTypeContracts = {
  list: { request: z.undefined(), response: typeListResponse },
  create: {
    request: z.strictObject({ label: labelInput, directionality: directionalitySchema }),
    response: relationshipTypeViewSchema,
  },
  rename: {
    request: z.strictObject({ typeId: z.uuid(), label: labelInput }),
    response: relationshipTypeViewSchema,
  },
  setArchived: {
    request: z.strictObject({ typeId: z.uuid(), archived: z.boolean() }),
    response: relationshipTypeViewSchema,
  },
  setDirectionality: {
    request: z.strictObject({ typeId: z.uuid(), directionality: directionalitySchema }),
    response: relationshipTypeViewSchema,
  },
} as const;

export const relationshipContracts = {
  listForNode: {
    request: z.strictObject({ nodeId: z.uuid() }),
    response: z.strictObject({ items: z.array(relationshipViewSchema).readonly() }),
  },
  create: {
    request: z.strictObject({
      sourceNodeId: z.uuid(),
      targetNodeId: z.uuid(),
      typeId: z.uuid(),
      description: descriptionInput.optional(),
    }),
    response: relationshipViewSchema,
  },
  update: {
    request: z.strictObject({
      relationshipId: z.uuid(),
      changes: z.strictObject({
        typeId: z.uuid().optional(),
        description: descriptionInput.optional(),
        reverseDirection: z.boolean().optional(),
      }),
    }),
    response: relationshipViewSchema,
  },
  delete: {
    request: z.strictObject({ relationshipId: z.uuid() }),
    response: z.strictObject({ deleted: z.literal(true) }),
  },
} as const;
