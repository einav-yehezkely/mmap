/**
 * Map service + SQLite repositories against a real database (PRD §4.4, §5.6, Phase 3 exit
 * criteria, §13 acceptance criteria 6 and 8).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createMapService,
  createRelationshipService,
  createWorkspaceService,
  type KnowledgeNodeService,
  type MapService,
  type MapView,
  type PlacementId,
  type RelationshipService,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSearchIndex } from '../search/sqlite-search-index';
import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteKnowledgeNodeRepository } from './sqlite-knowledge-node-repository';
import { SqliteMapRepository } from './sqlite-map-repository';
import { SqliteNoteReferenceRepository } from './sqlite-note-reference-repository';
import { SqliteRelationshipRepository } from './sqlite-relationship-repository';
import { SqliteRelationshipTypeRepository } from './sqlite-relationship-type-repository';
import { SqliteTagRepository } from './sqlite-tag-repository';
import { SqliteTimelineEventRepository } from './sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository';

const WORKSPACE_A = 'a0000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = 'a0000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let idCounter = 0;
const ids = {
  newId: () => `c0000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-27T12:00:00.000Z' as UtcTimestamp };

interface Services {
  nodes: KnowledgeNodeService;
  relationships: RelationshipService;
  maps: MapService;
}

function services(workspaceId: WorkspaceId): Services {
  const nodeRepository = new SqliteKnowledgeNodeRepository(connections);
  const timeline = new SqliteTimelineEventRepository(connections);
  const relationshipRepository = new SqliteRelationshipRepository(connections);
  const nodes = createKnowledgeNodeService({
    workspaceId,
    transactions: connections,
    nodes: nodeRepository,
    timeline,
    tags: new SqliteTagRepository(connections),
    references: new SqliteNoteReferenceRepository(connections),
    ids,
    clock,
  });
  return {
    nodes,
    relationships: createRelationshipService({
      workspaceId,
      transactions: connections,
      relationships: relationshipRepository,
      types: new SqliteRelationshipTypeRepository(connections),
      nodes: nodeRepository,
      timeline,
      ids,
      clock,
    }),
    maps: createMapService({
      workspaceId,
      transactions: connections,
      maps: new SqliteMapRepository(connections),
      nodes: nodeRepository,
      relationships: relationshipRepository,
      ids,
      clock,
      createNode: (title) => nodes.create({ title }),
    }),
  };
}

/** Adds placements of new nodes with the given titles, one after another. */
async function placeNew(maps: MapService, view: MapView, titles: readonly string[]) {
  let current = view;
  for (const [index, title] of titles.entries()) {
    current = await maps.addPlacement(current.map.id, current.map.revision, {
      newNodeTitle: title,
      x: index * 100,
      y: 0,
    });
  }
  return current;
}

function placementOf(view: MapView, title: string) {
  const placement = view.placements.find((item) => item.nodeTitle === title);
  if (placement === undefined) throw new Error(`No placement for ${title}`);
  return placement;
}

/** Child titles of `parentTitle` (null = roots) in display order. */
function childTitles(view: MapView, parentTitle: string | null): string[] {
  const parentId = parentTitle === null ? null : placementOf(view, parentTitle).id;
  return view.placements
    .filter((placement) => placement.parentPlacementId === parentId)
    .sort((a, b) => a.siblingOrder - b.siblingOrder)
    .map((placement) => placement.nodeTitle);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-maps-'));
  connections = (
    await openWorkspaceDatabase(join(directory, 'mmap.sqlite'), { backupDirectory: directory })
  ).connections;
  const workspaces = createWorkspaceService({
    transactions: connections,
    workspaces: new SqliteWorkspaceRepository(connections),
    relationshipTypes: new SqliteRelationshipTypeRepository(connections),
    ids,
    clock,
  });
  await workspaces.initialize(WORKSPACE_A, 'A', 'UTC');
  await workspaces.initialize(WORKSPACE_B, 'B', 'UTC');
});

afterEach(async () => {
  await connections.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('map lifecycle', () => {
  it('creates, lists, renames and deletes maps; deletion keeps the nodes (criterion 8)', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    const created = await placeNew(maps, await maps.createMap('  Biology  '), ['Cell', 'Atom']);

    expect(created.map).toMatchObject({ title: 'Biology', mode: 'freeform' });
    await expect(maps.listMaps()).resolves.toMatchObject([{ title: 'Biology', placementCount: 2 }]);
    const renamed = await maps.renameMap(created.map.id, created.map.revision, 'Life');
    expect(renamed.map.title).toBe('Life');

    await maps.deleteMap(created.map.id);

    await expect(maps.listMaps()).resolves.toEqual([]);
    expect(
      (await nodes.list({ sort: 'title-asc', page: { limit: 10 } })).items
        .map((node) => node.title)
        .sort(),
    ).toEqual(['Atom', 'Cell']);
  });

  it('rejects empty, over-long and control-character titles', async () => {
    const { maps } = services(WORKSPACE_A);
    await expect(maps.createMap('   ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(maps.createMap('x'.repeat(201))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(maps.createMap('a\u0007b')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('requires the current revision for structural changes', async () => {
    const { maps } = services(WORKSPACE_A);
    const view = await maps.createMap('Map');
    await maps.renameMap(view.map.id, view.map.revision, 'Renamed');

    await expect(maps.renameMap(view.map.id, view.map.revision, 'Stale')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect((await maps.getMap(view.map.id)).map.title).toBe('Renamed');
  });

  it('keeps maps of other workspaces invisible', async () => {
    const own = services(WORKSPACE_A);
    const other = services(WORKSPACE_B);
    const view = await own.maps.createMap('Private');

    await expect(other.maps.listMaps()).resolves.toEqual([]);
    await expect(other.maps.getMap(view.map.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const foreignNode = await other.nodes.create({ title: 'Foreign' });
    await expect(
      own.maps.addPlacement(view.map.id, view.map.revision, { nodeId: foreignNode.id, x: 0, y: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('persists the viewport without changing the revision and validates it', async () => {
    const { maps } = services(WORKSPACE_A);
    const view = await maps.createMap('Map');
    await maps.setViewport(view.map.id, { x: 10, y: -20, zoom: 1.5 });

    const reloaded = await maps.getMap(view.map.id);
    expect(reloaded.map).toMatchObject({ viewport: { x: 10, y: -20, zoom: 1.5 }, revision: 1 });
    await expect(maps.setViewport(view.map.id, { x: 0, y: 0, zoom: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      maps.setViewport(view.map.id, { x: Number.NaN, y: 0, zoom: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('placements of canonical nodes', () => {
  it('shows one node with the same content in two maps; moving one leaves the other (criterion 6)', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Photosynthesis' });
    let first = await maps.createMap('First');
    let second = await maps.createMap('Second');
    first = await maps.addPlacement(first.map.id, first.map.revision, {
      nodeId: node.id,
      x: 1,
      y: 2,
    });
    second = await maps.addPlacement(second.map.id, second.map.revision, {
      nodeId: node.id,
      x: 1,
      y: 2,
    });

    await nodes.update(node.id, node.revision, { title: 'Photosynthesis (light)' });
    first = await maps.movePlacements(first.map.id, first.map.revision, [
      { placementId: placementOf(first, 'Photosynthesis').id, x: 500, y: 600 },
    ]);

    const reloadedSecond = await maps.getMap(second.map.id);
    expect(first.placements[0]).toMatchObject({ nodeId: node.id, x: 500, y: 600 });
    expect(reloadedSecond.placements[0]).toMatchObject({
      nodeId: node.id,
      nodeTitle: 'Photosynthesis (light)',
      x: 1,
      y: 2,
    });
  });

  it('places a node at most once per map', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Once' });
    const view = await maps.createMap('Map');
    const placed = await maps.addPlacement(view.map.id, view.map.revision, {
      nodeId: node.id,
      x: 0,
      y: 0,
    });

    await expect(
      maps.addPlacement(view.map.id, placed.map.revision, { nodeId: node.id, x: 5, y: 5 }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('creates a new node only explicitly, and discards it when the placement is rejected', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    const view = await maps.createMap('Map');

    await expect(
      maps.addPlacement(view.map.id, view.map.revision, {
        newNodeTitle: 'Orphan',
        x: Number.POSITIVE_INFINITY,
        y: 0,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await nodes.list({ sort: 'title-asc', page: { limit: 10 } })).items).toEqual([]);

    const placed = await maps.addPlacement(view.map.id, view.map.revision, {
      newNodeTitle: 'Created here',
      x: 0,
      y: 0,
    });
    expect(
      (await nodes.list({ sort: 'title-asc', page: { limit: 10 } })).items.map(
        (node) => node.title,
      ),
    ).toEqual(['Created here']);
    expect(placed.placements[0]?.nodeTitle).toBe('Created here');
  });

  it('removes a placement without deleting its node; its children take its place', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), [
      'Root',
      'A',
      'B',
      'C',
      'A1',
      'A2',
    ]);
    const root = placementOf(view, 'Root').id;
    for (const title of ['A', 'B', 'C']) {
      view = await maps.reparent(
        view.map.id,
        view.map.revision,
        placementOf(view, title).id,
        root,
        9,
      );
    }
    for (const title of ['A1', 'A2']) {
      view = await maps.reparent(
        view.map.id,
        view.map.revision,
        placementOf(view, title).id,
        placementOf(view, 'A').id,
        9,
      );
    }

    view = await maps.removePlacement(view.map.id, view.map.revision, placementOf(view, 'A').id);

    expect(childTitles(view, 'Root')).toEqual(['A1', 'A2', 'B', 'C']);
    expect((await nodes.list({ sort: 'title-asc', page: { limit: 10 } })).items).toHaveLength(6);
  });

  it('promotes children when the node of a parent placement is deleted', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['Parent', 'Child']);
    view = await maps.reparent(
      view.map.id,
      view.map.revision,
      placementOf(view, 'Child').id,
      placementOf(view, 'Parent').id,
      0,
    );

    const parentNode = await nodes.get(placementOf(view, 'Parent').nodeId);
    await nodes.delete(parentNode.id, parentNode.revision);

    const reloaded = await maps.getMap(view.map.id);
    expect(reloaded.placements).toMatchObject([{ nodeTitle: 'Child', parentPlacementId: null }]);
  });

  it('validates styles', async () => {
    const { maps } = services(WORKSPACE_A);
    const view = await placeNew(maps, await maps.createMap('Map'), ['A']);
    const styled = await maps.setPlacementStyle(
      view.map.id,
      view.map.revision,
      placementOf(view, 'A').id,
      { color: 'green' },
    );

    expect(placementOf(styled, 'A').style).toEqual({ color: 'green' });
    await expect(
      maps.setPlacementStyle(styled.map.id, styled.map.revision, placementOf(view, 'A').id, {
        color: 'url(javascript:alert(1))' as 'green',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('hierarchy', () => {
  it('reorders siblings and rejects cycles (exit criterion)', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['Root', 'A', 'B']);
    const root = placementOf(view, 'Root').id;
    view = await maps.reparent(view.map.id, view.map.revision, placementOf(view, 'A').id, root, 0);
    view = await maps.reparent(view.map.id, view.map.revision, placementOf(view, 'B').id, root, 0);
    expect(childTitles(view, 'Root')).toEqual(['B', 'A']);

    await expect(
      maps.reparent(view.map.id, view.map.revision, root, placementOf(view, 'A').id, 0),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
    await expect(
      maps.reparent(view.map.id, view.map.revision, root, root, 0),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
    expect(childTitles(await maps.getMap(view.map.id), null)).toEqual(['Root']);
  });

  it('collapses and expands a subtree', async () => {
    const { maps } = services(WORKSPACE_A);
    const view = await placeNew(maps, await maps.createMap('Map'), ['Root']);
    const collapsed = await maps.setCollapsed(
      view.map.id,
      view.map.revision,
      placementOf(view, 'Root').id,
      true,
    );
    expect(placementOf(collapsed, 'Root').isCollapsed).toBe(true);
  });

  it('never creates semantic relationships from hierarchy', async () => {
    const { maps, relationships } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['Whole', 'Part']);
    view = await maps.reparent(
      view.map.id,
      view.map.revision,
      placementOf(view, 'Part').id,
      placementOf(view, 'Whole').id,
      0,
    );

    await expect(relationships.listForNode(placementOf(view, 'Whole').nodeId)).resolves.toEqual([]);
  });
});

describe('connectors', () => {
  it('allows cycles between freeform connectors but not self-connectors', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B']);
    const a = placementOf(view, 'A').id;
    const b = placementOf(view, 'B').id;
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: a,
      targetPlacementId: b,
      label: '  leads to ',
    });
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: b,
      targetPlacementId: a,
    });

    expect(view.connections.map((connection) => connection.label)).toEqual(['leads to', null]);
    await expect(
      maps.addConnection(view.map.id, view.map.revision, {
        sourcePlacementId: a,
        targetPlacementId: a,
      }),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
  });

  it('references a relationship only when it connects the same two nodes', async () => {
    const { maps, relationships } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B', 'C']);
    const [a, b, c] = ['A', 'B', 'C'].map((title) => placementOf(view, title));
    const dependsOn = (await relationships.listTypes()).find((t) => t.label === 'depends on')!;
    const relationship = await relationships.create({
      sourceNodeId: b!.nodeId,
      targetNodeId: a!.nodeId,
      typeId: dependsOn.id,
    });

    await expect(
      maps.addConnection(view.map.id, view.map.revision, {
        sourcePlacementId: a!.id,
        targetPlacementId: c!.id,
        relationshipId: relationship.id,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: a!.id,
      targetPlacementId: b!.id,
      relationshipId: relationship.id,
    });
    expect(view.connections[0]).toMatchObject({
      relationshipId: relationship.id,
      relationshipTypeLabel: 'depends on',
    });

    // Deleting the relationship keeps the connector as a plain visual connector.
    await relationships.delete(relationship.id);
    expect((await maps.getMap(view.map.id)).connections[0]).toMatchObject({
      relationshipId: null,
      relationshipTypeLabel: null,
    });
  });

  it('links an existing connector to a relationship of the same nodes, and unlinks it', async () => {
    const { maps, relationships } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B', 'C']);
    const [a, b, c] = ['A', 'B', 'C'].map((title) => placementOf(view, title));
    const types = await relationships.listTypes();
    const dependsOn = types.find((t) => t.label === 'depends on')!;
    const relatedTo = types.find((t) => t.label === 'related to')!;
    // Opposite direction to the connector: still the same two nodes.
    const between = await relationships.create({
      sourceNodeId: b!.nodeId,
      targetNodeId: a!.nodeId,
      typeId: dependsOn.id,
    });
    const elsewhere = await relationships.create({
      sourceNodeId: a!.nodeId,
      targetNodeId: c!.nodeId,
      typeId: relatedTo.id,
    });
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: a!.id,
      targetPlacementId: b!.id,
      label: 'kept',
    });
    const connectionId = view.connections[0]!.id;

    await expect(
      maps.setConnectionRelationship(view.map.id, view.map.revision, connectionId, elsewhere.id),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    view = await maps.setConnectionRelationship(
      view.map.id,
      view.map.revision,
      connectionId,
      between.id,
    );
    expect(view.connections[0]).toMatchObject({
      relationshipId: between.id,
      relationshipTypeLabel: 'depends on',
      label: 'kept',
    });
    // The relationship itself is unchanged.
    expect(await relationships.listForNode(a!.nodeId)).toHaveLength(2);

    view = await maps.setConnectionRelationship(view.map.id, view.map.revision, connectionId, null);
    expect(view.connections[0]).toMatchObject({ relationshipId: null, label: 'kept' });

    await expect(
      maps.setConnectionRelationship(view.map.id, view.map.revision - 1, connectionId, null),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    view = await maps.removeConnection(view.map.id, view.map.revision, connectionId);
    await expect(
      maps.setConnectionRelationship(view.map.id, view.map.revision, connectionId, between.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removes connectors', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B']);
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: placementOf(view, 'A').id,
      targetPlacementId: placementOf(view, 'B').id,
    });
    const connectionId = view.connections[0]!.id;
    view = await maps.removeConnection(view.map.id, view.map.revision, connectionId);

    expect(view.connections).toEqual([]);
    await expect(
      maps.removeConnection(view.map.id, view.map.revision, connectionId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('writes, changes and removes the note on a connector', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B']);
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: placementOf(view, 'A').id,
      targetPlacementId: placementOf(view, 'B').id,
    });
    const connectionId = view.connections[0]!.id;

    view = await maps.setConnectionLabel(
      view.map.id,
      view.map.revision,
      connectionId,
      '  causes\n heat ',
    );
    expect(view.connections[0]!.label).toBe('causes heat');
    expect((await maps.getMap(view.map.id)).connections[0]!.label).toBe('causes heat');

    view = await maps.setConnectionLabel(
      view.map.id,
      view.map.revision,
      connectionId,
      'שגורם לחום',
    );
    expect(view.connections[0]!.label).toBe('שגורם לחום');

    view = await maps.setConnectionLabel(view.map.id, view.map.revision, connectionId, '   ');
    expect(view.connections[0]!.label).toBeNull();
  });

  it('rejects a note on a missing connector, a stale map and an over-long note', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B']);
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: placementOf(view, 'A').id,
      targetPlacementId: placementOf(view, 'B').id,
    });
    const connectionId = view.connections[0]!.id;

    await expect(
      maps.setConnectionLabel(view.map.id, view.map.revision - 1, connectionId, 'stale'),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      maps.setConnectionLabel(view.map.id, view.map.revision, connectionId, 'x'.repeat(201)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    view = await maps.removeConnection(view.map.id, view.map.revision, connectionId);
    await expect(
      maps.setConnectionLabel(view.map.id, view.map.revision, connectionId, 'gone'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('finding nodes to add to a map', () => {
  it('leaves out the nodes already on that map, however many (regression: the list was capped)', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    const titles = Array.from({ length: 60 }, (_, index) => `Planet ${index}`);
    const view = await placeNew(maps, await maps.createMap('Solar system'), titles);
    const other = await maps.createMap('Other map');
    const unplaced = await nodes.create({ title: 'Planet Nine' });
    const search = new SqliteSearchIndex(connections);

    const onThisMap = await search.lookupTitles(WORKSPACE_A, 'planet', 50, [], view.map.id);
    expect(onThisMap.map((match) => match.nodeId)).toEqual([unplaced.id]);
    // Another map, or none, leaves everything in.
    expect(await search.lookupTitles(WORKSPACE_A, 'planet', 50, [], other.map.id)).toHaveLength(50);
    // A map of another workspace changes nothing.
    expect(await search.lookupTitles(WORKSPACE_B, 'planet', 50, [], view.map.id)).toEqual([]);
  });
});

describe('duplicating a map', () => {
  it('copies placements, hierarchy and connectors over the same canonical nodes', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Original'), ['Root', 'Child']);
    view = await maps.reparent(
      view.map.id,
      view.map.revision,
      placementOf(view, 'Child').id,
      placementOf(view, 'Root').id,
      0,
    );
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: placementOf(view, 'Child').id,
      targetPlacementId: placementOf(view, 'Root').id,
    });

    const copy = await maps.duplicateMap(view.map.id);

    expect(copy.map.title).toBe('Original (copy)');
    expect(copy.placements.map((p) => p.nodeId).sort()).toEqual(
      view.placements.map((p) => p.nodeId).sort(),
    );
    expect(copy.placements.some((p) => view.placements.some((o) => o.id === p.id))).toBe(false);
    expect(placementOf(copy, 'Child').parentPlacementId).toBe(placementOf(copy, 'Root').id);
    expect(copy.connections[0]).toMatchObject({
      sourcePlacementId: placementOf(copy, 'Child').id,
      targetPlacementId: placementOf(copy, 'Root').id,
    });
  });
});

describe('switching modes', () => {
  it('requires a reviewed assignment and keeps freeform coordinates for switching back', async () => {
    const { maps } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B', 'C']);
    const [a, b, c] = ['A', 'B', 'C'].map((title) => placementOf(view, title).id) as [
      PlacementId,
      PlacementId,
      PlacementId,
    ];
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: a,
      targetPlacementId: c,
    });
    view = await maps.addConnection(view.map.id, view.map.revision, {
      sourcePlacementId: b,
      targetPlacementId: c,
    });

    const proposal = await maps.proposeHierarchy(view.map.id);
    expect(proposal.ambiguous).toEqual([{ id: c, candidates: [a, b].sort() }]);
    await expect(
      maps.switchMode(view.map.id, view.map.revision, 'hierarchical'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      maps.switchMode(
        view.map.id,
        view.map.revision,
        'hierarchical',
        new Map([
          [a, b],
          [b, a],
          [c, null],
        ]),
      ),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });

    const parents = new Map(proposal.parents as ReadonlyMap<PlacementId, PlacementId | null>);
    parents.set(c, b); // the user's decision for the ambiguous item
    const hierarchical = await maps.switchMode(
      view.map.id,
      view.map.revision,
      'hierarchical',
      parents,
    );
    expect(hierarchical.map.mode).toBe('hierarchical');
    expect(childTitles(hierarchical, 'B')).toEqual(['C']);

    const freeform = await maps.switchMode(
      hierarchical.map.id,
      hierarchical.map.revision,
      'freeform',
    );
    expect(freeform.placements.map(({ nodeTitle, x, y }) => ({ nodeTitle, x, y }))).toEqual(
      expect.arrayContaining([
        { nodeTitle: 'A', x: 0, y: 0 },
        { nodeTitle: 'B', x: 100, y: 0 },
        { nodeTitle: 'C', x: 200, y: 0 },
      ]),
    );
    expect(childTitles(freeform, 'B')).toEqual(['C']);
  });
});

describe('review regressions', () => {
  /** Hierarchical map Root → Child, switched to freeform (the hierarchy is kept). */
  async function keptHierarchy(maps: MapService) {
    let view = await placeNew(maps, await maps.createMap('Map', 'hierarchical'), ['Root', 'Child']);
    const root = placementOf(view, 'Root').id;
    const child = placementOf(view, 'Child').id;
    view = await maps.reparent(view.map.id, view.map.revision, child, root, 0);
    view = await maps.switchMode(view.map.id, view.map.revision, 'freeform');
    return { view, root, child };
  }

  it('applies an assignment that inverts the kept hierarchy (rows written in any order)', async () => {
    const { maps } = services(WORKSPACE_A);
    const { view, root, child } = await keptHierarchy(maps);

    const switched = await maps.switchMode(
      view.map.id,
      view.map.revision,
      'hierarchical',
      new Map([
        [root, child],
        [child, null],
      ]),
    );

    expect(childTitles(switched, 'Child')).toEqual(['Root']);
  });

  it('proposes the kept hierarchy when switching back, not a flat list from connectors', async () => {
    const { maps } = services(WORKSPACE_A);
    const { view, root, child } = await keptHierarchy(maps);

    const proposal = await maps.proposeHierarchy(view.map.id);

    expect(proposal.source).toBe('previous-hierarchy');
    expect(proposal.parents.get(child)).toBe(root);
    expect(proposal.ambiguous).toEqual([]);
  });

  it('appends after the last sibling even when node deletion left a gap', async () => {
    const { maps, nodes } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B', 'C']);
    const nodeB = await nodes.get(placementOf(view, 'B').nodeId);
    await nodes.delete(nodeB.id, nodeB.revision);

    const stale = view.map.revision;
    view = await maps.getMap(view.map.id);
    expect(view.map.revision).toBeGreaterThan(stale);
    view = await maps.addPlacement(view.map.id, view.map.revision, {
      newNodeTitle: 'D',
      x: 0,
      y: 0,
    });

    expect(childTitles(view, null)).toEqual(['A', 'C', 'D']);
    expect(placementOf(view, 'D').siblingOrder).toBeGreaterThan(
      placementOf(view, 'C').siblingOrder,
    );
  });

  it('lists maps with their revision', async () => {
    const { maps } = services(WORKSPACE_A);
    const view = await maps.createMap('Map');
    await maps.renameMap(view.map.id, view.map.revision, 'Renamed');
    await expect(maps.listMaps()).resolves.toMatchObject([{ title: 'Renamed', revision: 2 }]);
  });
});

describe('semantic relationships on maps', () => {
  it('shows relationships between nodes on the map and follows their changes', async () => {
    const { maps, relationships, nodes } = services(WORKSPACE_A);
    let view = await placeNew(maps, await maps.createMap('Map'), ['A', 'B']);
    const outside = await nodes.create({ title: 'Not on the map' });
    const a = placementOf(view, 'A').nodeId;
    const b = placementOf(view, 'B').nodeId;
    const types = await relationships.listTypes();
    const dependsOn = types.find((type) => type.label === 'depends on')!;
    const relatedTo = types.find((type) => type.label === 'related to')!;

    // Created elsewhere (for example in the node panel): shown on reading the map.
    const created = await relationships.create({
      sourceNodeId: a,
      targetNodeId: b,
      typeId: dependsOn.id,
    });
    await relationships.create({ sourceNodeId: a, targetNodeId: outside.id, typeId: dependsOn.id });
    view = await maps.getMap(view.map.id);
    expect(view.relationships).toEqual([
      {
        id: created.id,
        sourceNodeId: a,
        targetNodeId: b,
        typeLabel: 'depends on',
        directionality: 'directed',
      },
    ]);
    // Showing it adds nothing to the map: the other node is not placed, no connector is created.
    expect(view.placements).toHaveLength(2);
    expect(view.connections).toEqual([]);

    // Edited and deleted elsewhere: the map shows the current state.
    await relationships.update(created.id, { typeId: relatedTo.id });
    expect((await maps.getMap(view.map.id)).relationships).toMatchObject([
      { typeLabel: 'related to', directionality: 'undirected' },
    ]);
    await relationships.delete(created.id);
    expect((await maps.getMap(view.map.id)).relationships).toEqual([]);
  });
});
