/**
 * Relationship service + SQLite repositories against a real database (PRD §4.2, §5.5, §13
 * acceptance criterion 4).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createRelationshipService,
  createWorkspaceService,
  type KnowledgeNodeService,
  type NodeId,
  type RelationshipService,
  type RelationshipTypeId,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteKnowledgeNodeRepository } from './sqlite-knowledge-node-repository';
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
  newId: () => `b0000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-27T12:00:00.000Z' as UtcTimestamp };

function services(workspaceId: WorkspaceId): {
  nodes: KnowledgeNodeService;
  relationships: RelationshipService;
} {
  const nodeRepository = new SqliteKnowledgeNodeRepository(connections);
  const timeline = new SqliteTimelineEventRepository(connections);
  return {
    nodes: createKnowledgeNodeService({
      workspaceId,
      transactions: connections,
      nodes: nodeRepository,
      timeline,
      tags: new SqliteTagRepository(connections),
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
  };
}

async function typeId(service: RelationshipService, label: string): Promise<RelationshipTypeId> {
  const type = (await service.listTypes()).find((item) => item.label === label);
  if (type === undefined) throw new Error(`No type ${label}`);
  return type.id;
}

async function twoNodes(nodes: KnowledgeNodeService): Promise<{ a: NodeId; b: NodeId }> {
  const a = await nodes.create({ title: 'A' });
  const b = await nodes.create({ title: 'B' });
  return { a: a.id, b: b.id };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-relationships-'));
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

describe('direction and uniqueness (acceptance criterion 4)', () => {
  it('keeps A → B for a directed type and shows it from both nodes', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);

    const created = await relationships.create({
      sourceNodeId: a,
      targetNodeId: b,
      typeId: await typeId(relationships, 'depends on'),
    });

    expect(created).toMatchObject({
      directionality: 'directed',
      source: { id: a, title: 'A' },
      target: { id: b, title: 'B' },
    });
    await expect(relationships.listForNode(b)).resolves.toEqual([created]);
  });

  it('rejects a reversed undirected duplicate but allows other types between the same nodes', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    const relatedTo = await typeId(relationships, 'related to');

    const first = await relationships.create({
      sourceNodeId: a,
      targetNodeId: b,
      typeId: relatedTo,
    });

    expect(first.directionality).toBe('undirected');
    await expect(
      relationships.create({ sourceNodeId: b, targetNodeId: a, typeId: relatedTo }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(
      relationships.create({
        sourceNodeId: b,
        targetNodeId: a,
        typeId: await typeId(relationships, 'contradicts'),
      }),
    ).resolves.toMatchObject({ typeLabel: 'contradicts' });
  });

  it('allows the reverse direction of a directed type but not an exact duplicate', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    const dependsOn = await typeId(relationships, 'depends on');
    await relationships.create({ sourceNodeId: a, targetNodeId: b, typeId: dependsOn });

    await expect(
      relationships.create({ sourceNodeId: a, targetNodeId: b, typeId: dependsOn }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(
      relationships.create({ sourceNodeId: b, targetNodeId: a, typeId: dependsOn }),
    ).resolves.toMatchObject({ source: { id: b }, target: { id: a } });
  });

  it('rejects self-links', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a } = await twoNodes(nodes);

    await expect(
      relationships.create({
        sourceNodeId: a,
        targetNodeId: a,
        typeId: await typeId(relationships, 'part of'),
      }),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
  });
});

describe('editing relationships', () => {
  it('reverses a directed relationship and refuses a reversal that would duplicate', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    const dependsOn = await typeId(relationships, 'depends on');
    const aToB = await relationships.create({
      sourceNodeId: a,
      targetNodeId: b,
      typeId: dependsOn,
    });

    const reversed = await relationships.update(aToB.id, { reverseDirection: true });
    expect(reversed).toMatchObject({ source: { id: b }, target: { id: a } });

    await relationships.create({ sourceNodeId: a, targetNodeId: b, typeId: dependsOn });
    await expect(relationships.update(aToB.id, { reverseDirection: true })).rejects.toMatchObject({
      code: 'DUPLICATE',
    });
  });

  it('changes the type, re-ordering endpoints canonically for undirected types', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    // Create in the direction high → low so canonical ordering has to swap it.
    const [low, high] = a < b ? [a, b] : [b, a];
    const directed = await relationships.create({
      sourceNodeId: high,
      targetNodeId: low,
      typeId: await typeId(relationships, 'depends on'),
    });

    const undirected = await relationships.update(directed.id, {
      typeId: await typeId(relationships, 'related to'),
      description: '  Both describe entropy.  ',
    });

    expect(undirected).toMatchObject({
      directionality: 'undirected',
      source: { id: low },
      target: { id: high },
      description: 'Both describe entropy.',
    });
  });

  it('deletes a relationship without touching the nodes', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    const created = await relationships.create({
      sourceNodeId: a,
      targetNodeId: b,
      typeId: await typeId(relationships, 'example of'),
    });

    await relationships.delete(created.id);

    await expect(relationships.listForNode(a)).resolves.toEqual([]);
    await expect(nodes.get(b)).resolves.toMatchObject({ title: 'B' });
  });

  it('records relationship creation in the timeline (PRD §5.9)', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    await relationships.create({
      sourceNodeId: a,
      targetNodeId: b,
      typeId: await typeId(relationships, 'part of'),
    });

    const row = connections
      .forRead()
      .prepare("SELECT node_id FROM timeline_events WHERE event_type = 'relationship_created'")
      .get();
    expect(row?.node_id).toBe(a);
  });

  it('rejects descriptions that are too long', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);

    await expect(
      relationships.create({
        sourceNodeId: a,
        targetNodeId: b,
        typeId: await typeId(relationships, 'part of'),
        description: 'x'.repeat(1_001),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('relationship types', () => {
  it('starts with the PRD built-in types', async () => {
    const { relationships } = services(WORKSPACE_A);

    const types = await relationships.listTypes();

    expect(types.map((type) => [type.label, type.directionality, type.isBuiltin])).toEqual([
      ['contradicts', 'undirected', true],
      ['depends on', 'directed', true],
      ['example of', 'directed', true],
      ['part of', 'directed', true],
      ['related to', 'undirected', true],
    ]);
  });

  it('creates and renames custom types with case-insensitive uniqueness', async () => {
    const { relationships } = services(WORKSPACE_A);
    const custom = await relationships.createType('Inspired by', 'directed');

    await expect(relationships.createType('inspired BY', 'directed')).rejects.toMatchObject({
      code: 'DUPLICATE',
    });
    await expect(relationships.renameType(custom.id, 'Depends On')).rejects.toMatchObject({
      code: 'DUPLICATE',
    });
    await expect(relationships.renameType(custom.id, 'Influenced by')).resolves.toMatchObject({
      label: 'Influenced by',
      isBuiltin: false,
    });
  });

  it('keeps relationships of an archived type but blocks new ones until restored', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    const custom = await relationships.createType('cites', 'directed');
    await relationships.create({ sourceNodeId: a, targetNodeId: b, typeId: custom.id });

    const archived = await relationships.setTypeArchived(custom.id, true);

    expect(archived).toMatchObject({ isArchived: true, usageCount: 1 });
    await expect(relationships.listForNode(a)).resolves.toHaveLength(1);
    await expect(
      relationships.create({ sourceNodeId: b, targetNodeId: a, typeId: custom.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await relationships.setTypeArchived(custom.id, false);
    await expect(
      relationships.create({ sourceNodeId: b, targetNodeId: a, typeId: custom.id }),
    ).resolves.toBeDefined();
  });

  it('changes directionality only while a type is unused', async () => {
    const { nodes, relationships } = services(WORKSPACE_A);
    const { a, b } = await twoNodes(nodes);
    const unused = await relationships.createType('unused', 'directed');
    const used = await relationships.createType('used', 'directed');
    await relationships.create({ sourceNodeId: a, targetNodeId: b, typeId: used.id });

    await expect(
      relationships.changeTypeDirectionality(unused.id, 'undirected'),
    ).resolves.toMatchObject({ directionality: 'undirected' });
    await expect(
      relationships.changeTypeDirectionality(used.id, 'undirected'),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
  });
});

describe('workspace isolation', () => {
  it('cannot connect to another workspace node or use its types', async () => {
    const a = services(WORKSPACE_A);
    const b = services(WORKSPACE_B);
    const local = await a.nodes.create({ title: 'Local' });
    const otherLocal = await a.nodes.create({ title: 'Other local' });
    const foreign = await b.nodes.create({ title: 'Foreign' });
    const foreignType = await typeId(b.relationships, 'depends on');

    await expect(
      a.relationships.create({
        sourceNodeId: local.id,
        targetNodeId: foreign.id,
        typeId: await typeId(a.relationships, 'depends on'),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      a.relationships.create({
        sourceNodeId: local.id,
        targetNodeId: otherLocal.id,
        typeId: foreignType,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
