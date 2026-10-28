/**
 * Graph queries against a real database (PRD §5.7, §13 acceptance criterion 9): deterministic
 * bounded selection, visible partial results, filters, the note-reference layer, neighborhood
 * expansion and workspace isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createRelationshipService,
  createTagService,
  createWorkspaceService,
  type GraphFilters,
  type KnowledgeNodeService,
  type NodeId,
  type RelationshipService,
  type RelationshipTypeId,
  type TagService,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteKnowledgeNodeRepository } from '../repositories/sqlite-knowledge-node-repository';
import { SqliteNoteReferenceRepository } from '../repositories/sqlite-note-reference-repository';
import { SqliteRelationshipRepository } from '../repositories/sqlite-relationship-repository';
import { SqliteRelationshipTypeRepository } from '../repositories/sqlite-relationship-type-repository';
import { SqliteTagRepository } from '../repositories/sqlite-tag-repository';
import { SqliteTimelineEventRepository } from '../repositories/sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from '../repositories/sqlite-workspace-repository';
import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteGraphQuery } from './sqlite-graph-query';

const WORKSPACE_A = 'a0000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = 'a0000000-0000-4000-8000-00000000000b' as WorkspaceId;
const NO_FILTERS: GraphFilters = {
  tagIds: [],
  relationshipTypeIds: [],
  mapIds: [],
  text: null,
  includeReferences: false,
  includeConnectors: false,
};
const LIMITS = { maxNodes: 1_000, maxEdges: 3_000 };

let directory: string;
let connections: SqliteConnections;
let graph: SqliteGraphQuery;
let idCounter = 0;
const ids = {
  newId: () => `d0000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-27T12:00:00.000Z' as UtcTimestamp };

function services(workspaceId: WorkspaceId): {
  nodes: KnowledgeNodeService;
  relationships: RelationshipService;
  tags: TagService;
} {
  const nodeRepository = new SqliteKnowledgeNodeRepository(connections);
  const timeline = new SqliteTimelineEventRepository(connections);
  const tagRepository = new SqliteTagRepository(connections);
  return {
    nodes: createKnowledgeNodeService({
      workspaceId,
      transactions: connections,
      nodes: nodeRepository,
      timeline,
      tags: tagRepository,
      references: new SqliteNoteReferenceRepository(connections),
      ids,
      clock,
    }),
    relationships: createRelationshipService({
      workspaceId,
      transactions: connections,
      relationships: new SqliteRelationshipRepository(connections),
      types: new SqliteRelationshipTypeRepository(connections),
      nodes: nodeRepository,
      timeline,
      ids,
      clock,
    }),
    tags: createTagService({
      workspaceId,
      transactions: connections,
      tags: tagRepository,
      nodes: nodeRepository,
      ids,
      clock,
    }),
  };
}

async function typeId(relationships: RelationshipService, label: string) {
  const type = (await relationships.listTypes()).find((item) => item.label === label);
  if (type === undefined) throw new Error(`No type ${label}`);
  return type.id;
}

/**
 * Hub ─depends on→ A, Hub ─depends on→ B, Hub ─related to─ C, A ─related to─ B; Lonely has none.
 * Degrees: Hub 3, A 2, B 2, C 1, Lonely 0.
 */
async function sampleGraph() {
  const { nodes, relationships } = services(WORKSPACE_A);
  const create = async (title: string) => (await nodes.create({ title })).id;
  const hub = await create('Hub');
  const a = await create('Alpha');
  const b = await create('Beta');
  const c = await create('Gamma');
  const lonely = await create('Lonely');
  const dependsOn = await typeId(relationships, 'depends on');
  const relatedTo = await typeId(relationships, 'related to');
  const link = (sourceNodeId: NodeId, targetNodeId: NodeId, type: RelationshipTypeId) =>
    relationships.create({ sourceNodeId, targetNodeId, typeId: type });
  await link(hub, a, dependsOn);
  await link(hub, b, dependsOn);
  await link(hub, c, relatedTo);
  await link(a, b, relatedTo);
  return { hub, a, b, c, lonely, dependsOn, relatedTo };
}

async function linkInNote(sourceId: NodeId, targetIds: readonly NodeId[]) {
  const { nodes } = services(WORKSPACE_A);
  const source = await nodes.get(sourceId);
  await nodes.update(sourceId, source.revision, {
    note: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: targetIds.map((targetNodeId) => ({
            type: 'wikilink',
            attrs: { targetNodeId, label: 'link' },
          })),
        },
      ],
    },
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-graph-'));
  connections = (
    await openWorkspaceDatabase(join(directory, 'mmap.sqlite'), { backupDirectory: directory })
  ).connections;
  graph = new SqliteGraphQuery(connections);
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

describe('overview', () => {
  it('returns all nodes ranked by degree with their relationships and directions', async () => {
    const { hub, a } = await sampleGraph();
    const slice = await graph.overview(WORKSPACE_A, NO_FILTERS, LIMITS);

    expect(slice.nodes.map((node) => [node.title, node.degree])).toEqual([
      ['Hub', 3],
      ['Alpha', 2],
      ['Beta', 2],
      ['Gamma', 1],
      ['Lonely', 0],
    ]);
    expect(slice).toMatchObject({ totalNodes: 5, edgesTruncated: false, references: [] });
    expect(slice.edges).toHaveLength(4);
    expect(slice.edges.find((edge) => edge.targetNodeId === a)).toMatchObject({
      sourceNodeId: hub,
      typeLabel: 'depends on',
      directionality: 'directed',
    });
  });

  it('marks a bounded view as partial and keeps only edges among the shown nodes', async () => {
    const { hub, a } = await sampleGraph();
    const slice = await graph.overview(WORKSPACE_A, NO_FILTERS, { maxNodes: 2, maxEdges: 10 });

    expect(slice.nodes.map((node) => node.id)).toEqual([hub, a]);
    expect(slice.totalNodes).toBe(5);
    expect(slice.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([[hub, a]]);
  });

  it('reports truncated edges', async () => {
    await sampleGraph();
    const slice = await graph.overview(WORKSPACE_A, NO_FILTERS, { maxNodes: 10, maxEdges: 3 });
    expect(slice.edges).toHaveLength(3);
    expect(slice.edgesTruncated).toBe(true);
  });

  it('is deterministic', async () => {
    await sampleGraph();
    const first = await graph.overview(WORKSPACE_A, NO_FILTERS, LIMITS);
    const second = await graph.overview(WORKSPACE_A, NO_FILTERS, LIMITS);
    expect(second).toEqual(first);
  });

  it('filters by relationship type: matching edges and only the nodes taking part', async () => {
    const { dependsOn } = await sampleGraph();
    const slice = await graph.overview(
      WORKSPACE_A,
      { ...NO_FILTERS, relationshipTypeIds: [dependsOn] },
      LIMITS,
    );
    expect(slice.nodes.map((node) => [node.title, node.degree])).toEqual([
      ['Hub', 2],
      ['Alpha', 1],
      ['Beta', 1],
    ]);
    expect(slice.edges.every((edge) => edge.typeId === dependsOn)).toBe(true);
    expect(slice.totalNodes).toBe(3);
  });

  it('filters by tags (all must match) and by text', async () => {
    const { hub, a } = await sampleGraph();
    const { tags } = services(WORKSPACE_A);
    const tag = await tags.create('core');
    await tags.assignToNode(hub, 'core');
    await tags.assignToNode(a, 'core');

    const tagged = await graph.overview(WORKSPACE_A, { ...NO_FILTERS, tagIds: [tag.id] }, LIMITS);
    expect(tagged.nodes.map((node) => node.title)).toEqual(['Hub', 'Alpha']);

    const byText = await graph.overview(WORKSPACE_A, { ...NO_FILTERS, text: 'gam' }, LIMITS);
    expect(byText.nodes.map((node) => node.title)).toEqual(['Gamma']);

    const noWords = await graph.overview(WORKSPACE_A, { ...NO_FILTERS, text: '"*' }, LIMITS);
    expect(noWords).toMatchObject({ nodes: [], totalNodes: 0 });
  });

  it('includes the note-reference layer only on request, counting occurrences', async () => {
    const { hub, a, c } = await sampleGraph();
    await linkInNote(c, [a, a, hub, c]);

    const without = await graph.overview(WORKSPACE_A, NO_FILTERS, LIMITS);
    expect(without.references).toEqual([]);

    const withReferences = await graph.overview(
      WORKSPACE_A,
      { ...NO_FILTERS, includeReferences: true },
      LIMITS,
    );
    expect(withReferences.references).toEqual(
      expect.arrayContaining([
        { sourceNodeId: c, targetNodeId: a, occurrences: 2 },
        { sourceNodeId: c, targetNodeId: hub, occurrences: 1 },
      ]),
    );
    // A note linking to its own node is not a connection.
    expect(withReferences.references).toHaveLength(2);
  });

  it('never shows another workspace', async () => {
    await sampleGraph();
    const other = await graph.overview(WORKSPACE_B, NO_FILTERS, LIMITS);
    expect(other).toMatchObject({ nodes: [], edges: [], totalNodes: 0 });
  });
});

describe('neighborhood', () => {
  it('returns the node, its direct neighbors and the relationships among them', async () => {
    const { a, hub, b, c } = await sampleGraph();
    const slice = await graph.neighborhood(WORKSPACE_A, a, NO_FILTERS, {
      maxNeighbors: 10,
      maxEdges: 10,
    });

    expect(slice?.nodes.map((node) => node.id)).toEqual([a, hub, b]);
    expect(slice?.totalNodes).toBe(2);
    expect(slice?.edges).toHaveLength(3);
    expect(slice?.nodes.map((node) => node.id)).not.toContain(c);
  });

  it('bounds the neighbors and reports how many there are', async () => {
    const { hub } = await sampleGraph();
    const slice = await graph.neighborhood(WORKSPACE_A, hub, NO_FILTERS, {
      maxNeighbors: 1,
      maxEdges: 10,
    });
    expect(slice?.nodes).toHaveLength(2);
    expect(slice?.totalNodes).toBe(3);
  });

  it('reaches note-reference neighbors only when the layer is included', async () => {
    const { lonely, c } = await sampleGraph();
    await linkInNote(lonely, [c]);

    const without = await graph.neighborhood(WORKSPACE_A, lonely, NO_FILTERS, {
      maxNeighbors: 10,
      maxEdges: 10,
    });
    expect(without?.nodes.map((node) => node.id)).toEqual([lonely]);

    const withReferences = await graph.neighborhood(
      WORKSPACE_A,
      lonely,
      { ...NO_FILTERS, includeReferences: true },
      { maxNeighbors: 10, maxEdges: 10 },
    );
    expect(withReferences?.nodes.map((node) => node.id)).toEqual([lonely, c]);
    expect(withReferences?.references).toEqual([
      { sourceNodeId: lonely, targetNodeId: c, occurrences: 1 },
    ]);
  });

  it('returns null for unknown nodes and nodes of another workspace', async () => {
    const { hub } = await sampleGraph();
    await expect(
      graph.neighborhood(WORKSPACE_B, hub, NO_FILTERS, { maxNeighbors: 10, maxEdges: 10 }),
    ).resolves.toBeNull();
    await expect(
      graph.neighborhood(
        WORKSPACE_A,
        'd0000000-0000-4000-8000-ffffffffffff' as NodeId,
        NO_FILTERS,
        {
          maxNeighbors: 10,
          maxEdges: 10,
        },
      ),
    ).resolves.toBeNull();
  });
});
