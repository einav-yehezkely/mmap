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

/** A region of a freeform map: a named rectangle; items are in it when their center is inside. */
export const mapRegionViewSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  color: colorSchema,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const regionSize = z.number().finite().min(40).max(1_000_000);
const regionChangesSchema = z.strictObject({
  title: titleInput.optional(),
  color: colorSchema.optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: regionSize.optional(),
  height: regionSize.optional(),
});
const positionChangeSchema = z.strictObject({
  placementId: z.uuid(),
  x: coordinate,
  y: coordinate,
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
  /** Locked: automatic layout leaves the item where it is. */
  pinned: z.boolean(),
});

export const mapConnectionViewSchema = z.strictObject({
  id: z.uuid(),
  sourcePlacementId: z.uuid(),
  targetPlacementId: z.uuid(),
  label: z.string().nullable(),
  relationshipId: z.uuid().nullable(),
  relationshipTypeLabel: z.string().nullable(),
});

const itemSideSchema = z.enum(['left', 'right', 'top', 'bottom']);
const pointSchema = z.strictObject({ x: z.number(), y: z.number() });

/** The last automatic layout of a freeform map: where items were put and each line's route. */
export const arrangementSchema = z.strictObject({
  direction: z.enum(['right', 'down', 'left', 'up']),
  placed: z
    .array(z.strictObject({ placementId: z.uuid(), x: z.number(), y: z.number() }))
    .min(1)
    .max(MAX_PLACEMENTS_PER_REQUEST)
    .readonly(),
  routes: z
    .array(
      z.strictObject({
        lineId: z.string().max(120),
        sourceSide: itemSideSchema,
        targetSide: itemSideSchema,
        points: z.array(pointSchema).min(2).max(200).readonly(),
      }),
    )
    .max(20_000)
    .readonly(),
});

export const mapViewSchema = z.strictObject({
  map: z.strictObject({
    id: z.uuid(),
    title: z.string(),
    mode: mapModeSchema,
    viewport: z.strictObject({ x: z.number(), y: z.number(), zoom: z.number() }),
    /** The last automatic layout (freeform maps), or null. */
    arrangement: arrangementSchema.nullable(),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
  }),
  placements: z.array(placementViewSchema).readonly(),
  connections: z.array(mapConnectionViewSchema).readonly(),
  /** Regions (freeform maps), oldest first. */
  regions: z.array(mapRegionViewSchema).readonly(),
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
  /** Locks or unlocks an item's position for automatic layout. */
  /** Saves an automatic layout: moves the arranged items and stores the routes, as one change. */
  saveArrangement: {
    request: z.strictObject({
      ...structural,
      arrangement: arrangementSchema,
      /** New bounds of the regions the layout arranged. */
      regions: z
        .array(
          z.strictObject({
            regionId: z.uuid(),
            x: coordinate,
            y: coordinate,
            width: regionSize,
            height: regionSize,
          }),
        )
        .max(200)
        .readonly()
        .optional(),
    }),
    response: mapViewSchema,
  },
  addRegion: {
    request: z.strictObject({
      ...structural,
      title: titleInput,
      color: colorSchema.optional(),
      x: coordinate,
      y: coordinate,
      width: regionSize,
      height: regionSize,
    }),
    response: mapViewSchema,
  },
  /** Changes a region; `moves` are items moved with it (one change, one Undo step). */
  updateRegion: {
    request: z.strictObject({
      ...structural,
      regionId: z.uuid(),
      changes: regionChangesSchema,
      moves: z.array(positionChangeSchema).max(MAX_PLACEMENTS_PER_REQUEST).readonly().optional(),
    }),
    response: mapViewSchema,
  },
  removeRegion: {
    request: z.strictObject({ ...structural, regionId: z.uuid() }),
    response: mapViewSchema,
  },
  setPlacementPinned: {
    request: z.strictObject({ ...structural, placementId: z.uuid(), pinned: z.boolean() }),
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
  /**
   * Links a connector to a relationship between the same two nodes (PRD §4.4); null removes the
   * link. Never creates or changes a relationship.
   */
  setConnectionRelationship: {
    request: z.strictObject({
      ...structural,
      connectionId: z.uuid(),
      relationshipId: z.uuid().nullable(),
    }),
    response: mapViewSchema,
  },
  /** Note on a connector; null or blank text removes it. */
  setConnectionLabel: {
    request: z.strictObject({
      ...structural,
      connectionId: z.uuid(),
      label: z.string().max(1_000).nullable(),
    }),
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
