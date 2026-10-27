/**
 * Mind map contracts (PRD §4.4, §5.6).
 *
 * Maps place canonical nodes; responses carry the node's current title, never a copy of its
 * content. Every structural request names the map revision the renderer last saw, and the main
 * process rejects stale revisions with `REVISION_CONFLICT` (PRD §14). Coordinates and list
 * sizes are bounded here as a first line of defense; the domain validates them again.
 */

import { MAP_MODES, PLACEMENT_COLORS, RELATIONSHIP_DIRECTIONALITIES } from '@mmap/domain';
import { z } from 'zod';

/** Largest number of placements a single request may touch (PRD §9: up to 500 per map). */
export const MAX_PLACEMENTS_PER_REQUEST = 5_000;

const mapModeSchema = z.enum(MAP_MODES);
const colorSchema = z.enum(PLACEMENT_COLORS).nullable();
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const revision = z.number().int().positive();
const titleInput = z.string().max(1_000);

const viewportSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
  zoom: z.number().finite().positive().max(100),
});

export const mapSummarySchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  mode: mapModeSchema,
  revision: z.number().int().positive(),
  placementCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const placementViewSchema = z.strictObject({
  id: z.uuid(),
  nodeId: z.uuid(),
  nodeTitle: z.string(),
  x: z.number(),
  y: z.number(),
  parentPlacementId: z.uuid().nullable(),
  siblingOrder: z.number().int(),
  isCollapsed: z.boolean(),
  color: colorSchema,
});

export const mapConnectionViewSchema = z.strictObject({
  id: z.uuid(),
  sourcePlacementId: z.uuid(),
  targetPlacementId: z.uuid(),
  label: z.string().nullable(),
  relationshipId: z.uuid().nullable(),
  relationshipTypeLabel: z.string().nullable(),
});

export const mapViewSchema = z.strictObject({
  map: z.strictObject({
    id: z.uuid(),
    title: z.string(),
    mode: mapModeSchema,
    viewport: z.strictObject({ x: z.number(), y: z.number(), zoom: z.number() }),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
  }),
  placements: z.array(placementViewSchema).readonly(),
  connections: z.array(mapConnectionViewSchema).readonly(),
  /** Semantic relationships between nodes on the map; shown, never stored as map data. */
  relationships: z
    .array(
      z.strictObject({
        id: z.uuid(),
        sourceNodeId: z.uuid(),
        targetNodeId: z.uuid(),
        typeLabel: z.string(),
        directionality: z.enum(RELATIONSHIP_DIRECTIONALITIES),
      }),
    )
    .readonly(),
});

const parentAssignmentSchema = z.strictObject({
  placementId: z.uuid(),
  parentPlacementId: z.uuid().nullable(),
});

/** Maps a node is placed on (node panel). */
export const mapsOfNodeSchema = z.strictObject({
  items: z
    .array(z.strictObject({ id: z.uuid(), title: z.string(), mode: mapModeSchema }))
    .readonly(),
});

export type MapSummaryDto = z.infer<typeof mapSummarySchema>;
export type PlacementViewDto = z.infer<typeof placementViewSchema>;
export type MapConnectionViewDto = z.infer<typeof mapConnectionViewSchema>;
export type MapViewDto = z.infer<typeof mapViewSchema>;

/** Request fields shared by every structural change. */
const structural = { mapId: z.uuid(), expectedRevision: revision };

export const mapContracts = {
  /** Maps the node is placed on. */
  listForNode: {
    request: z.strictObject({ nodeId: z.uuid() }),
    response: mapsOfNodeSchema,
  },
  /**
   * Adds an existing node to maps, each optionally under a parent placement, in one transaction
   * (all or nothing). A map that already shows the node is left as it is. Returns the node's maps.
   */
  addNode: {
    request: z.strictObject({
      nodeId: z.uuid(),
      targets: z
        .array(z.strictObject({ mapId: z.uuid(), parentPlacementId: z.uuid().nullable() }))
        .min(1)
        .max(50),
    }),
    response: mapsOfNodeSchema,
  },
  list: {
    request: z.undefined(),
    response: z.strictObject({ items: z.array(mapSummarySchema).readonly() }),
  },
  create: {
    request: z.strictObject({ title: titleInput, mode: mapModeSchema.optional() }),
    response: mapViewSchema,
  },
  get: { request: z.strictObject({ mapId: z.uuid() }), response: mapViewSchema },
  rename: {
    request: z.strictObject({ ...structural, title: titleInput }),
    response: mapViewSchema,
  },
  duplicate: { request: z.strictObject({ mapId: z.uuid() }), response: mapViewSchema },
  delete: {
    request: z.strictObject({ mapId: z.uuid() }),
    response: z.strictObject({ deleted: z.literal(true) }),
  },
  setViewport: {
    request: z.strictObject({ mapId: z.uuid(), viewport: viewportSchema }),
    response: z.strictObject({ saved: z.literal(true) }),
  },
  addPlacement: {
    // Exactly one of `nodeId` (an existing node) or `newNodeTitle` (explicitly create one).
    request: z.union([
      z.strictObject({
        ...structural,
        nodeId: z.uuid(),
        x: coordinate,
        y: coordinate,
        parentPlacementId: z.uuid().nullable().optional(),
      }),
      z.strictObject({
        ...structural,
        newNodeTitle: titleInput,
        x: coordinate,
        y: coordinate,
        parentPlacementId: z.uuid().nullable().optional(),
      }),
    ]),
    response: mapViewSchema,
  },
  removePlacement: {
    request: z.strictObject({ ...structural, placementId: z.uuid() }),
    response: mapViewSchema,
  },
  movePlacements: {
    request: z.strictObject({
      ...structural,
      changes: z
        .array(z.strictObject({ placementId: z.uuid(), x: coordinate, y: coordinate }))
        .min(1)
        .max(MAX_PLACEMENTS_PER_REQUEST),
    }),
    response: mapViewSchema,
  },
  reparent: {
    request: z.strictObject({
      ...structural,
      placementId: z.uuid(),
      parentPlacementId: z.uuid().nullable(),
      index: z.number().int().min(0).max(MAX_PLACEMENTS_PER_REQUEST),
    }),
    response: mapViewSchema,
  },
  setCollapsed: {
    request: z.strictObject({ ...structural, placementId: z.uuid(), collapsed: z.boolean() }),
    response: mapViewSchema,
  },
  setPlacementColor: {
    request: z.strictObject({ ...structural, placementId: z.uuid(), color: colorSchema }),
    response: mapViewSchema,
  },
  addConnection: {
    request: z.strictObject({
      ...structural,
      sourcePlacementId: z.uuid(),
      targetPlacementId: z.uuid(),
      label: z.string().max(1_000).nullable().optional(),
      relationshipId: z.uuid().nullable().optional(),
    }),
    response: mapViewSchema,
  },
  removeConnection: {
    request: z.strictObject({ ...structural, connectionId: z.uuid() }),
    response: mapViewSchema,
  },
  proposeHierarchy: {
    request: z.strictObject({ mapId: z.uuid() }),
    response: z.strictObject({
      source: z.enum(['previous-hierarchy', 'connectors']),
      parents: z.array(parentAssignmentSchema).readonly(),
      ambiguous: z
        .array(
          z.strictObject({
            placementId: z.uuid(),
            candidates: z.array(z.uuid()).readonly(),
          }),
        )
        .readonly(),
    }),
  },
  switchMode: {
    request: z.strictObject({
      ...structural,
      mode: mapModeSchema,
      /** Required when switching to hierarchical mode: the reviewed parent of every placement. */
      parents: z.array(parentAssignmentSchema).max(MAX_PLACEMENTS_PER_REQUEST).optional(),
    }),
    response: mapViewSchema,
  },
} as const;
