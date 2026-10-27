/**
 * Mind map membership in the knowledge graph and graph layout persistence, against a real
 * database (PRD §4.4, §5.7). Covers the redesign's rules: one canonical node however many maps
 * place it, membership never creating edges, the map filter showing the union of maps, nodes on
 * no map staying visible, and graph positions never touching map placements.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGraphService,
  createKnowledgeNodeService,
  createMapService,
  createRelationshipService,
  createWorkspaceService,
  type GraphService,
  type KnowledgeNodeService,
  type MapService,
  type MapView,
  type NodeId,
  type RelationshipService,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteKnowledgeNodeRepository } from '../repositories/sqlite-knowledge-node-repository';
import { SqliteMapRepository } from '../repositories/sqlite-map-repository';
import { SqliteNoteReferenceRepository } from '../repositories/sqlite-note-reference-repository';
import { SqliteRelationshipRepository } from '../repositories/sqlite-relationship-repository';
import { SqliteRelationshipTypeRepository } from '../repositories/sqlite-relationship-type-repository';
import { SqliteTagRepository } from '../repositories/sqlite-tag-repository';
import { SqliteTimelineEventRepository } from '../repositories/sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from '../repositories/sqlite-workspace-repository';
import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteGraphLayoutRepository } from './sqlite-graph-layout-repository';
import { SqliteGraphQuery } from './sqlite-graph-query';

const WORKSPACE_A = 'a0000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = 'a0000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let idCounter = 0;
const ids = {
  newId: () => `f0000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-27T12:00:00.000Z' as UtcTimestamp };

interface Services {
  nodes: KnowledgeNodeService;
  relationships: RelationshipService;
  maps: MapService;
  graph: GraphService;
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
    graph: createGraphService({
      workspaceId,
      graph: new SqliteGraphQuery(connections),
      layout: new SqliteGraphLayoutRepository(connections),
      transactions: connections,
      clock,
    }),
  };
}

async function place(maps: MapService, view: MapView, nodeId: NodeId): Promise<MapView> {
  return maps.addPlacement(view.map.id, view.map.revision, { nodeId, x: 10, y: 20 });
}

/**
 * HTTP is on both "Networking" and "Security"; TCP only on Networking; TLS only on Security;
 * Orphan is on no map. TCP ─depends on→ HTTP is the only relationship.
 */
async function sample() {
  const { nodes, maps, relationships } = services(WORKSPACE_A);
  const http = (await nodes.create({ title: 'HTTP' })).id;
  const tcp = (await nodes.create({ title: 'TCP' })).id;
  const tls = (await nodes.create({ title: 'TLS' })).id;
  const orphan = (await nodes.create({ title: 'Orphan' })).id;
  let networking = await maps.createMap('Networking');
  networking = await place(maps, networking, http);
  networking = await place(maps, networking, tcp);
  let security = await maps.createMap('Security');
  security = await place(maps, security, http);
  security = await place(maps, security, tls);
  const dependsOn = (await relationships.listTypes()).find((t) => t.label === 'depends on')!;
  await relationships.create({ sourceNodeId: tcp, targetNodeId: http, typeId: dependsOn.id });
  return { http, tcp, tls, orphan, networking, security };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-graph-maps-'));
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

describe('map membership in the graph', () => {
  it('shows one canonical node with every membership, and nodes on no map', async () => {
    const { http, orphan, networking, security } = await sample();
    const slice = await services(WORKSPACE_A).graph.overview({});

    expect(slice.nodes.filter((node) => node.id === http)).toHaveLength(1);
    expect(slice.nodes.find((node) => node.id === http)?.mapIds).toEqual(
      [networking.map.id, security.map.id].sort(),
    );
    expect(slice.nodes.find((node) => node.id === orphan)?.mapIds).toEqual([]);
    expect(slice.maps).toEqual([
      { id: networking.map.id, title: 'Networking', nodeCount: 2 },
      { id: security.map.id, title: 'Security', nodeCount: 2 },
    ]);
  });

  it('never creates edges from shared map membership', async () => {
    await sample();
    const slice = await services(WORKSPACE_A).graph.overview({});
    // HTTP and TLS share "Security", TCP and HTTP share "Networking": only the real
    // relationship TCP → HTTP is an edge.
    expect(slice.edges).toHaveLength(1);
  });

  it('filters to the union of the selected maps', async () => {
    const { networking, security } = await sample();
    const { graph } = services(WORKSPACE_A);

    const one = await graph.overview({ mapIds: [networking.map.id] });
    expect(one.nodes.map((node) => node.title).sort()).toEqual(['HTTP', 'TCP']);
    expect(one.totalNodes).toBe(2);

    const both = await graph.overview({ mapIds: [networking.map.id, security.map.id] });
    expect(both.nodes.map((node) => node.title).sort()).toEqual(['HTTP', 'TCP', 'TLS']);
  });

  it('keeps maps of other workspaces out', async () => {
    await sample();
    expect((await services(WORKSPACE_B).graph.overview({})).maps).toEqual([]);
  });
});

describe('graph layout', () => {
  it('saves and reads positions', async () => {
    const { http, tcp } = await sample();
    const { graph } = services(WORKSPACE_A);
    await graph.savePositions([
      { nodeId: http, x: 100, y: -50 },
      { nodeId: tcp, x: 0, y: 0 },
    ]);
    await graph.savePositions([{ nodeId: http, x: 120, y: -40 }]);
    const positions = await graph.positions([http, tcp]);
    expect([...positions].sort((a, b) => a.x - b.x)).toEqual([
      { nodeId: tcp, x: 0, y: 0 },
      { nodeId: http, x: 120, y: -40 },
    ]);
  });

  it('never moves a node inside any mind map', async () => {
    const { http, networking } = await sample();
    const { graph, maps } = services(WORKSPACE_A);
    await graph.savePositions([{ nodeId: http, x: 999, y: 999 }]);

    const placement = (await maps.getMap(networking.map.id)).placements.find(
      (item) => item.nodeId === http,
    );
    expect(placement).toMatchObject({ x: 10, y: 20 });
  });

  it('ignores positions of deleted or foreign nodes and removes them with the node', async () => {
    const { http } = await sample();
    const { graph, nodes } = services(WORKSPACE_A);
    const foreign = await services(WORKSPACE_B).nodes.create({ title: 'Foreign' });
    await graph.savePositions([
      { nodeId: http, x: 1, y: 2 },
      { nodeId: foreign.id, x: 3, y: 4 },
    ]);
    expect(await graph.positions([http, foreign.id])).toEqual([{ nodeId: http, x: 1, y: 2 }]);

    const node = await nodes.get(http);
    await nodes.delete(http, node.revision);
    expect(await graph.positions([http])).toEqual([]);
  });

  it('rejects corrupt coordinates', async () => {
    const { http } = await sample();
    const { graph } = services(WORKSPACE_A);
    await expect(
      graph.savePositions([{ nodeId: http, x: Number.NaN, y: 0 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(graph.savePositions([{ nodeId: http, x: 2_000_000, y: 0 }])).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
  });
});
