/**
 * Application service for mind maps (PRD §4.4, §5.6).
 *
 * Invariants enforced here (the schema repeats the structural ones):
 * - A map shows canonical nodes through placements; a node appears at most once per map, and its
 *   content is never copied into the map (PRD §13 criterion 6).
 * - Hierarchy is organizational only: no operation here creates or changes semantic
 *   relationships. A connector may reference an existing relationship only when the user chooses
 *   one, and only if it connects the same two nodes.
 * - Hierarchy changes never create cycles; removing a placement promotes its children instead of
 *   removing a branch.
 * - Switching to hierarchical mode applies a parent assignment the user reviewed; freeform
 *   positions are never overwritten, so switching back restores them.
 * - Every structural change requires the map revision the caller saw (PRD §14 "Require revision
 *   checks for both nodes and map structure"); the viewport is visual state without revisions.
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type {
  IdGenerator,
  MapConnectionId,
  MapId,
  NodeId,
  PlacementId,
  RelationshipId,
  WorkspaceId,
} from '../ids';
import { assertNoCycle, compareIds, orderedChildren, planMove } from '../maps/hierarchy';
import {
  proposeHierarchy,
  validateHierarchyAssignment,
  type ParentProposal,
} from '../maps/hierarchy-proposal';
import { findFreePosition } from '../maps/free-position';
import type {
  MapConnectionRecord,
  MapConnectionWithRelationship,
  MapOfNode,
  MapRelationship,
  MapMode,
  MapRepository,
  MapViewport,
  MindMapRecord,
  MindMapSummary,
  PlacementStyle,
  PlacementWithNode,
} from '../ports/map-repository';
import { PLACEMENT_COLORS } from '../ports/map-repository';
import type {
  KnowledgeNodeRepository,
  RelationshipRepository,
  Revision,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';

export const MAX_MAP_TITLE_LENGTH = 200;
export const MAX_CONNECTOR_LABEL_LENGTH = 200;

export interface MapServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly maps: MapRepository;
  readonly nodes: KnowledgeNodeRepository;
  readonly relationships: RelationshipRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /**
   * Creates a canonical node (with its usual timeline event and search entry). Supplied by the
   * composition root from the knowledge node service so node rules are not duplicated here; it
   * joins the map's transaction, so a rejected placement also discards the new node.
   */
  readonly createNode: (title: string) => Promise<{ readonly id: NodeId }>;
}

/** Everything the editor needs to show one map. */
export interface MapView {
  readonly map: MindMapRecord;
  readonly placements: readonly PlacementWithNode[];
  readonly connections: readonly MapConnectionWithRelationship[];
  /** Semantic relationships between nodes on the map (derived, see `MapRelationship`). */
  readonly relationships: readonly MapRelationship[];
}

/**
 * A placement of an existing node (`nodeId`) or of a node created explicitly for it
 * (`newNodeTitle`, PRD §5.6 "add existing nodes or explicitly create new ones").
 */
export type NewPlacement = (
  | { readonly nodeId: NodeId; readonly newNodeTitle?: undefined }
  | { readonly nodeId?: undefined; readonly newNodeTitle: string }
) & {
  readonly x: number;
  readonly y: number;
  readonly parentPlacementId?: PlacementId | null;
};

export interface PositionChange {
  readonly placementId: PlacementId;
  readonly x: number;
  readonly y: number;
}

export interface MapService {
  listMaps(): Promise<readonly MindMapSummary[]>;
  createMap(rawTitle: string, mode?: MapMode): Promise<MapView>;
  getMap(mapId: MapId): Promise<MapView>;
  renameMap(mapId: MapId, expectedRevision: Revision, rawTitle: string): Promise<MapView>;
  duplicateMap(mapId: MapId): Promise<MapView>;
  deleteMap(mapId: MapId): Promise<void>;
  setViewport(mapId: MapId, viewport: MapViewport): Promise<void>;
  addPlacement(mapId: MapId, expectedRevision: Revision, input: NewPlacement): Promise<MapView>;
  /**
   * Adds an existing node to a map at a free spot near the other items (no chosen position),
   * optionally under a parent placement. A node already on the map is left where it is. Used
   * when a node is created with "Add to Mind Maps"; it joins the caller's transaction.
   */
  placeNode(mapId: MapId, nodeId: NodeId, parentPlacementId: PlacementId | null): Promise<MapView>;
  /** Maps the node is placed on. */
  mapsForNode(nodeId: NodeId): Promise<readonly MapOfNode[]>;
  removePlacement(
    mapId: MapId,
    expectedRevision: Revision,
    placementId: PlacementId,
  ): Promise<MapView>;
  movePlacements(
    mapId: MapId,
    expectedRevision: Revision,
    changes: readonly PositionChange[],
  ): Promise<MapView>;
  /** Moves a placement under `newParentId` (null = root) at `index` among its siblings. */
  reparent(
    mapId: MapId,
    expectedRevision: Revision,
    placementId: PlacementId,
    newParentId: PlacementId | null,
    index: number,
  ): Promise<MapView>;
  setCollapsed(
    mapId: MapId,
    expectedRevision: Revision,
    placementId: PlacementId,
    collapsed: boolean,
  ): Promise<MapView>;
  setPlacementStyle(
    mapId: MapId,
    expectedRevision: Revision,
    placementId: PlacementId,
    style: PlacementStyle,
  ): Promise<MapView>;
  addConnection(
    mapId: MapId,
    expectedRevision: Revision,
    input: {
      readonly sourcePlacementId: PlacementId;
      readonly targetPlacementId: PlacementId;
      readonly label?: string | null;
      readonly relationshipId?: RelationshipId | null;
    },
  ): Promise<MapView>;
  removeConnection(
    mapId: MapId,
    expectedRevision: Revision,
    connectionId: MapConnectionId,
  ): Promise<MapView>;
  /** Writes, changes or (with null or blank text) removes the note on a connector. */
  setConnectionLabel(
    mapId: MapId,
    expectedRevision: Revision,
    connectionId: MapConnectionId,
    label: string | null,
  ): Promise<MapView>;
  /** Parent suggestions for the user to review before switching to hierarchical mode. */
  proposeHierarchy(mapId: MapId): Promise<MapHierarchyProposal>;
  /**
   * Switches the map's mode. Switching to hierarchical mode requires `parents` (the reviewed
   * assignment for every placement); switching to freeform keeps the hierarchy for later.
   */
  switchMode(
    mapId: MapId,
    expectedRevision: Revision,
    mode: MapMode,
    parents?: ReadonlyMap<PlacementId, PlacementId | null>,
  ): Promise<MapView>;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the intent.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** Collapses whitespace and rejects control characters and over-long text. */
function normalizeMapText(raw: string, maxLength: number, what: string): string {
  const text = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (text.length > maxLength) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${what} can be at most ${maxLength} characters long.`,
    );
  }
  if (CONTROL_CHARACTER.test(text)) {
    throw new DomainError('VALIDATION_FAILED', `${what} cannot contain control characters.`);
  }
  return text;
}

/**
 * Parents suggested when switching to hierarchical mode:
 * - `previous-hierarchy`: the map was hierarchical before; the parents kept while it was in
 *   freeform mode are proposed again, so switching back restores the tree;
 * - `connectors`: no hierarchy yet; parents are suggested from freeform connectors.
 */
export interface MapHierarchyProposal extends ParentProposal {
  readonly source: 'previous-hierarchy' | 'connectors';
}

/** Highest sibling order under `parentId` plus one (0 for the first child). */
function nextSiblingOrder(
  placements: readonly { parentPlacementId: string | null; siblingOrder: number }[],
  parentId: string | null,
): number {
  let highest = -1;
  for (const placement of placements) {
    if (placement.parentPlacementId === parentId && placement.siblingOrder > highest) {
      highest = placement.siblingOrder;
    }
  }
  return highest + 1;
}

/** Validates a map title: required, single line, at most 200 characters. */
export function normalizeMapTitle(raw: string): string {
  const title = normalizeMapText(raw, MAX_MAP_TITLE_LENGTH, 'Map titles');
  if (title.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'A map needs a title.');
  }
  return title;
}

/** Validates an optional connector label; empty means "no label". */
export function normalizeConnectorLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const label = normalizeMapText(raw, MAX_CONNECTOR_LABEL_LENGTH, 'Connector labels');
  return label.length === 0 ? null : label;
}

/** Rejects non-finite or absurd coordinates (e.g. from a corrupted drag event). */
function validateCoordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new DomainError('VALIDATION_FAILED', 'The position is outside the map.');
  }
  return value;
}

function validateViewport(viewport: MapViewport): MapViewport {
  if (!Number.isFinite(viewport.zoom) || viewport.zoom < 0.05 || viewport.zoom > 8) {
    throw new DomainError('VALIDATION_FAILED', 'The zoom level is not supported.');
  }
  return {
    x: validateCoordinate(viewport.x),
    y: validateCoordinate(viewport.y),
    zoom: viewport.zoom,
  };
}

function validateStyle(style: PlacementStyle): PlacementStyle {
  if (style.color !== null && !PLACEMENT_COLORS.includes(style.color)) {
    throw new DomainError('VALIDATION_FAILED', 'This color is not available.');
  }
  return { color: style.color };
}

export function createMapService(dependencies: MapServiceDependencies): MapService {
  const { workspaceId, transactions, maps, nodes, relationships, ids, clock, createNode } =
    dependencies;

  async function requireMap(mapId: MapId): Promise<MindMapRecord> {
    const map = await maps.findMap(workspaceId, mapId);
    if (map === null) {
      throw new DomainError('NOT_FOUND', 'This map no longer exists.');
    }
    return map;
  }

  async function viewOf(map: MindMapRecord): Promise<MapView> {
    const [placements, connections, relationships] = await Promise.all([
      maps.listPlacements(workspaceId, map.id),
      maps.listConnections(workspaceId, map.id),
      maps.listRelationships(workspaceId, map.id),
    ]);
    return { map, placements, connections, relationships };
  }

  /**
   * Runs a structural change: checks the revision, lets `change` write, then stores the next
   * revision. All inside one transaction, so a failed rule leaves the map untouched.
   */
  function structuralChange(
    mapId: MapId,
    expectedRevision: Revision,
    change: (
      map: MindMapRecord,
      placements: readonly PlacementWithNode[],
    ) => Promise<Partial<MindMapRecord> | void>,
  ): Promise<MapView> {
    return transactions.runInTransaction(async () => {
      const map = await requireMap(mapId);
      if (map.revision !== expectedRevision) {
        throw new DomainError(
          'REVISION_CONFLICT',
          'This map was changed in another window. It has been reloaded; try again.',
        );
      }
      const placements = await maps.listPlacements(workspaceId, mapId);
      const mapChanges = (await change(map, placements)) ?? {};
      const next: MindMapRecord = {
        ...map,
        ...mapChanges,
        revision: map.revision + 1,
        updatedAt: clock.now(),
      };
      if (!(await maps.updateMap(next, expectedRevision))) {
        throw new DomainError('REVISION_CONFLICT', 'This map was changed in another window.');
      }
      return viewOf(next);
    });
  }

  function requirePlacement(
    placements: readonly PlacementWithNode[],
    placementId: PlacementId,
  ): PlacementWithNode {
    const placement = placements.find((item) => item.id === placementId);
    if (placement === undefined) {
      throw new DomainError('NOT_FOUND', 'This item is no longer on the map.');
    }
    return placement;
  }

  function hierarchyItems(placements: readonly PlacementWithNode[]) {
    return placements.map((placement) => ({
      id: placement.id,
      parentId: placement.parentPlacementId,
      siblingOrder: placement.siblingOrder,
    }));
  }

  /** Applies (parentId, siblingOrder) changes produced by the hierarchy algorithms. */
  async function applyHierarchyChanges(
    placements: readonly PlacementWithNode[],
    changes: readonly { id: string; parentId: string | null; siblingOrder: number }[],
  ): Promise<void> {
    const now = clock.now();
    await maps.updatePlacements(
      changes.map((change) => ({
        ...requirePlacement(placements, change.id as PlacementId),
        parentPlacementId: change.parentId as PlacementId | null,
        siblingOrder: change.siblingOrder,
        updatedAt: now,
      })),
    );
  }

  const service: MapService = {
    listMaps: () => maps.listMaps(workspaceId),

    createMap: (rawTitle, mode = 'freeform') =>
      transactions.runInTransaction(async () => {
        const now = clock.now();
        const map: MindMapRecord = {
          id: ids.newId() as MapId,
          workspaceId,
          title: normalizeMapTitle(rawTitle),
          mode,
          viewport: { x: 0, y: 0, zoom: 1 },
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        await maps.insertMap(map);
        return viewOf(map);
      }),

    getMap: async (mapId) => viewOf(await requireMap(mapId)),

    renameMap: (mapId, expectedRevision, rawTitle) => {
      const title = normalizeMapTitle(rawTitle);
      return structuralChange(mapId, expectedRevision, () => Promise.resolve({ title }));
    },

    duplicateMap: (mapId) =>
      transactions.runInTransaction(async () => {
        const source = await viewOf(await requireMap(mapId));
        const now = clock.now();
        const copy: MindMapRecord = {
          ...source.map,
          id: ids.newId() as MapId,
          title: normalizeMapTitle(`${source.map.title} (copy)`.slice(0, MAX_MAP_TITLE_LENGTH)),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        await maps.insertMap(copy);
        // The copy places the same canonical nodes (never copies of them) with new placement IDs.
        // Placements are inserted breadth-first from the roots so every parent exists before its
        // children (the same-map parent reference is checked on insert).
        const newIds = new Map(
          source.placements.map((placement) => [placement.id, ids.newId() as PlacementId]),
        );
        const byId = new Map(source.placements.map((placement) => [placement.id, placement]));
        const items = hierarchyItems(source.placements);
        const queue = orderedChildren(items, null).map((item) => item.id);
        for (let index = 0; index < queue.length; index += 1) {
          const placement = byId.get(queue[index] as PlacementId);
          if (placement === undefined) continue;
          await maps.insertPlacement({
            ...placement,
            id: newIds.get(placement.id) as PlacementId,
            mapId: copy.id,
            parentPlacementId:
              placement.parentPlacementId === null
                ? null
                : (newIds.get(placement.parentPlacementId) ?? null),
            createdAt: now,
            updatedAt: now,
          });
          queue.push(...orderedChildren(items, placement.id).map((item) => item.id));
        }
        for (const connection of source.connections) {
          await maps.insertConnection({
            id: ids.newId() as MapConnectionId,
            workspaceId,
            mapId: copy.id,
            sourcePlacementId: newIds.get(connection.sourcePlacementId) as PlacementId,
            targetPlacementId: newIds.get(connection.targetPlacementId) as PlacementId,
            relationshipId: connection.relationshipId,
            label: connection.label,
            createdAt: now,
            updatedAt: now,
          });
        }
        return viewOf(copy);
      }),

    deleteMap: (mapId) =>
      transactions.runInTransaction(async () => {
        await requireMap(mapId);
        await maps.deleteMap(workspaceId, mapId);
      }),

    setViewport: (mapId, viewport) =>
      transactions.runInTransaction(async () => {
        await requireMap(mapId);
        await maps.updateViewport(workspaceId, mapId, validateViewport(viewport));
      }),

    addPlacement: (mapId, expectedRevision, input) =>
      structuralChange(mapId, expectedRevision, async (map, placements) => {
        const parentId = input.parentPlacementId ?? null;
        if (parentId !== null) requirePlacement(placements, parentId);
        let nodeId: NodeId;
        if (input.nodeId === undefined) {
          nodeId = (await createNode(input.newNodeTitle)).id;
        } else {
          nodeId = input.nodeId;
          if ((await nodes.findById(workspaceId, nodeId)) === null) {
            throw new DomainError('NOT_FOUND', 'This node no longer exists.');
          }
          if (placements.some((placement) => placement.nodeId === nodeId)) {
            throw new DomainError('DUPLICATE', 'This node is already on the map.');
          }
        }
        const now = clock.now();
        await maps.insertPlacement({
          id: ids.newId() as PlacementId,
          workspaceId,
          mapId: map.id,
          nodeId,
          x: validateCoordinate(input.x),
          y: validateCoordinate(input.y),
          parentPlacementId: parentId,
          // Appended after existing siblings.
          // After the last sibling. Orders may have gaps (for example after a node was deleted
          // elsewhere), so "last" is the highest order plus one, not the number of siblings.
          siblingOrder: nextSiblingOrder(placements, parentId),
          isCollapsed: false,
          style: { color: null },
          createdAt: now,
          updatedAt: now,
        });
      }),

    mapsForNode: (nodeId) => maps.listMapsForNode(workspaceId, nodeId),

    placeNode: (mapId, nodeId, parentPlacementId) =>
      transactions.runInTransaction(async () => {
        const map = await requireMap(mapId);
        const placements = await maps.listPlacements(workspaceId, mapId);
        if (placements.some((placement) => placement.nodeId === nodeId)) return viewOf(map);
        const position = findFreePosition(placements);
        return service.addPlacement(mapId, map.revision, {
          nodeId,
          x: position.x,
          y: position.y,
          parentPlacementId,
        });
      }),

    removePlacement: (mapId, expectedRevision, placementId) =>
      structuralChange(mapId, expectedRevision, async (_map, placements) => {
        const removed = requirePlacement(placements, placementId);
        // The removed item's children take its place among its siblings, in their own order, so
        // no branch disappears. Only the placement goes; the node itself is never deleted.
        const items = hierarchyItems(placements);
        const parentId = removed.parentPlacementId;
        const regrouped = orderedChildren(items, parentId).flatMap((sibling) =>
          sibling.id === placementId ? orderedChildren(items, placementId) : [sibling],
        );
        await applyHierarchyChanges(
          placements,
          regrouped.map((item, siblingOrder) => ({ id: item.id, parentId, siblingOrder })),
        );
        await maps.deletePlacement(workspaceId, placementId);
      }),

    movePlacements: (mapId, expectedRevision, changes) =>
      structuralChange(mapId, expectedRevision, async (_map, placements) => {
        const now = clock.now();
        await maps.updatePlacements(
          changes.map((change) => ({
            ...requirePlacement(placements, change.placementId),
            x: validateCoordinate(change.x),
            y: validateCoordinate(change.y),
            updatedAt: now,
          })),
        );
      }),

    reparent: (mapId, expectedRevision, placementId, newParentId, index) =>
      structuralChange(mapId, expectedRevision, async (_map, placements) => {
        requirePlacement(placements, placementId);
        if (newParentId !== null) requirePlacement(placements, newParentId);
        const items = hierarchyItems(placements);
        assertNoCycle(items, placementId, newParentId);
        await applyHierarchyChanges(placements, planMove(items, placementId, newParentId, index));
      }),

    setCollapsed: (mapId, expectedRevision, placementId, collapsed) =>
      structuralChange(mapId, expectedRevision, async (_map, placements) => {
        await maps.updatePlacements([
          {
            ...requirePlacement(placements, placementId),
            isCollapsed: collapsed,
            updatedAt: clock.now(),
          },
        ]);
      }),

    setPlacementStyle: (mapId, expectedRevision, placementId, style) =>
      structuralChange(mapId, expectedRevision, async (_map, placements) => {
        await maps.updatePlacements([
          {
            ...requirePlacement(placements, placementId),
            style: validateStyle(style),
            updatedAt: clock.now(),
          },
        ]);
      }),

    addConnection: (mapId, expectedRevision, input) =>
      structuralChange(mapId, expectedRevision, async (map, placements) => {
        const source = requirePlacement(placements, input.sourcePlacementId);
        const target = requirePlacement(placements, input.targetPlacementId);
        if (source.id === target.id) {
          throw new DomainError('INVARIANT_VIOLATION', 'A connector needs two different items.');
        }
        const relationshipId = input.relationshipId ?? null;
        if (relationshipId !== null) {
          // Only an existing relationship between exactly these two nodes may be referenced.
          const relationship = await relationships.findById(workspaceId, relationshipId);
          const endpoints = new Set([source.nodeId, target.nodeId]);
          if (
            relationship === null ||
            !endpoints.has(relationship.sourceNodeId) ||
            !endpoints.has(relationship.targetNodeId)
          ) {
            throw new DomainError(
              'VALIDATION_FAILED',
              'The chosen relationship does not connect these two nodes.',
            );
          }
        }
        const label = normalizeConnectorLabel(input.label);
        const now = clock.now();
        const connection: MapConnectionRecord = {
          id: ids.newId() as MapConnectionId,
          workspaceId,
          mapId: map.id,
          sourcePlacementId: source.id,
          targetPlacementId: target.id,
          relationshipId,
          label,
          createdAt: now,
          updatedAt: now,
        };
        await maps.insertConnection(connection);
      }),

    removeConnection: (mapId, expectedRevision, connectionId) =>
      structuralChange(mapId, expectedRevision, async (map) => {
        const connections = await maps.listConnections(workspaceId, map.id);
        if (!connections.some((connection) => connection.id === connectionId)) {
          throw new DomainError('NOT_FOUND', 'This connector no longer exists.');
        }
        await maps.deleteConnection(workspaceId, connectionId);
      }),

    setConnectionLabel: (mapId, expectedRevision, connectionId, label) =>
      structuralChange(mapId, expectedRevision, async (map) => {
        const connections = await maps.listConnections(workspaceId, map.id);
        if (!connections.some((connection) => connection.id === connectionId)) {
          throw new DomainError('NOT_FOUND', 'This connector no longer exists.');
        }
        await maps.updateConnectionLabel(
          workspaceId,
          connectionId,
          normalizeConnectorLabel(label),
          clock.now(),
        );
      }),

    proposeHierarchy: async (mapId) => {
      const view = await viewOf(await requireMap(mapId));
      // Parents kept from an earlier hierarchical period are a complete, acyclic tree (the schema
      // rejects cycles); items added since then are roots. Connectors are not consulted, so the
      // user gets back exactly the tree they left.
      if (view.placements.some((placement) => placement.parentPlacementId !== null)) {
        return {
          source: 'previous-hierarchy',
          parents: new Map(
            view.placements.map((placement) => [placement.id, placement.parentPlacementId]),
          ),
          ambiguous: [],
        };
      }
      const fromConnectors = proposeHierarchy(
        view.placements.map((placement) => placement.id),
        view.connections.map((connection) => ({
          id: connection.id,
          sourceId: connection.sourcePlacementId,
          targetId: connection.targetPlacementId,
        })),
      );
      return { source: 'connectors', ...fromConnectors };
    },

    switchMode: (mapId, expectedRevision, mode, parents) =>
      structuralChange(mapId, expectedRevision, async (map, placements) => {
        if (mode === map.mode) return;
        if (mode === 'hierarchical') {
          if (parents === undefined) {
            throw new DomainError(
              'VALIDATION_FAILED',
              'Review the parent of each item before switching to the hierarchy.',
            );
          }
          validateHierarchyAssignment(
            placements.map((placement) => placement.id),
            parents,
          );
          const now = clock.now();
          // Rows are written one at a time and the schema checks every parent change for cycles
          // against the rows as they are at that moment. Detaching everything first means each
          // later write only ever sees parents from the new, validated (acyclic) assignment.
          await maps.updatePlacements(
            placements
              .filter((placement) => placement.parentPlacementId !== null)
              .map((placement) => ({ ...placement, parentPlacementId: null, updatedAt: now })),
          );
          // Sibling order follows the current order within each new parent group.
          const counters = new Map<string | null, number>();
          await maps.updatePlacements(
            [...placements]
              .sort((a, b) => a.siblingOrder - b.siblingOrder || compareIds(a.id, b.id))
              .map((placement) => {
                const parent = parents.get(placement.id) ?? null;
                const order = counters.get(parent) ?? 0;
                counters.set(parent, order + 1);
                return {
                  ...placement,
                  parentPlacementId: parent,
                  siblingOrder: order,
                  updatedAt: now,
                };
              }),
          );
        }
        // Freeform positions (x, y) are never touched here, so switching back restores them.
        return { mode };
      }),
  };
  return service;
}
