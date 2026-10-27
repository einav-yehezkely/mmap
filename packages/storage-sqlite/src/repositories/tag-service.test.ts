/**
 * Tag service + SQLite repositories against a real database (PRD §5.8).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createTagService,
  createWorkspaceService,
  type KnowledgeNodeService,
  type TagService,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteKnowledgeNodeRepository } from './sqlite-knowledge-node-repository';
import { SqliteNoteReferenceRepository } from './sqlite-note-reference-repository';
import { SqliteRelationshipTypeRepository } from './sqlite-relationship-type-repository';
import { SqliteTagRepository } from './sqlite-tag-repository';
import { SqliteTimelineEventRepository } from './sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository';

const WORKSPACE_A = '50000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = '50000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let idCounter = 0;

const ids = {
  newId: () => `60000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-26T12:00:00.000Z' as UtcTimestamp };

function services(workspaceId: WorkspaceId): { nodes: KnowledgeNodeService; tags: TagService } {
  const tagRepository = new SqliteTagRepository(connections);
  const nodeRepository = new SqliteKnowledgeNodeRepository(connections);
  return {
    nodes: createKnowledgeNodeService({
      workspaceId,
      transactions: connections,
      nodes: nodeRepository,
      timeline: new SqliteTimelineEventRepository(connections),
      tags: tagRepository,
      references: new SqliteNoteReferenceRepository(connections),
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

/** First element of a result that the test setup guarantees to be non-empty. */
function first<Item>(items: readonly Item[]): Item {
  const [item] = items;
  if (item === undefined) throw new Error('Expected at least one item.');
  return item;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-tags-'));
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

describe('tag assignment', () => {
  it('reuses an existing tag regardless of case and spacing', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const firstNode = await nodes.create({ title: 'First' });
    const secondNode = await nodes.create({ title: 'Second' });

    await tags.assignToNode(firstNode.id, 'Quantum Physics');
    const secondTags = await tags.assignToNode(secondNode.id, '  quantum   PHYSICS ');

    expect(secondTags.map((tag) => tag.label)).toEqual(['Quantum Physics']);
    await expect(tags.list()).resolves.toEqual([
      { id: first(secondTags).id, label: 'Quantum Physics', nodeCount: 2 },
    ]);
  });

  it('is idempotent, sorts by label and does not change the node revision', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Node' });

    await tags.assignToNode(node.id, 'zeta');
    await tags.assignToNode(node.id, 'Alpha');
    const result = await tags.assignToNode(node.id, 'alpha');

    expect(result.map((tag) => tag.label)).toEqual(['Alpha', 'zeta']);
    await expect(nodes.get(node.id)).resolves.toMatchObject({
      revision: 1,
      tags: [{ label: 'Alpha' }, { label: 'zeta' }],
    });
  });

  it('removes a tag from one node only', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const firstNode = await nodes.create({ title: 'First' });
    const secondNode = await nodes.create({ title: 'Second' });
    const tag = first(await tags.assignToNode(firstNode.id, 'shared'));
    await tags.assignToNode(secondNode.id, 'shared');

    await expect(tags.removeFromNode(firstNode.id, tag.id)).resolves.toEqual([]);
    await expect(nodes.get(secondNode.id)).resolves.toMatchObject({
      tags: [{ label: 'shared' }],
    });
  });

  it('rejects invalid labels', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Node' });

    await expect(tags.assignToNode(node.id, '   ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('tag management', () => {
  it('renames a tag and keeps every assignment', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Node' });
    const tag = first(await tags.assignToNode(node.id, 'physcis'));

    await tags.rename(tag.id, 'Physics');

    await expect(nodes.get(node.id)).resolves.toMatchObject({ tags: [{ label: 'Physics' }] });
  });

  it('allows changing only the casing of a tag', async () => {
    const { tags } = services(WORKSPACE_A);
    const tag = await tags.create('physics');

    await expect(tags.rename(tag.id, 'Physics')).resolves.toMatchObject({ label: 'Physics' });
  });

  it('rejects creating or renaming to a label that already exists', async () => {
    const { tags } = services(WORKSPACE_A);
    await tags.create('Biology');
    const other = await tags.create('Chemistry');

    await expect(tags.create('BIOLOGY')).rejects.toMatchObject({ code: 'DUPLICATE' });
    await expect(tags.rename(other.id, 'biology')).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('deletes a tag without deleting nodes (PRD §5.8)', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Kept' });
    const tag = first(await tags.assignToNode(node.id, 'temporary'));

    await tags.delete(tag.id);

    await expect(nodes.get(node.id)).resolves.toMatchObject({ title: 'Kept', tags: [] });
    await expect(tags.list()).resolves.toEqual([]);
  });
});

describe('tag filtering in the library', () => {
  it('lists only nodes that carry all selected tags, with honest totals', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const both = await nodes.create({ title: 'Both' });
    const onlyPhysics = await nodes.create({ title: 'Only physics' });
    await nodes.create({ title: 'Untagged' });
    const physics = first(await tags.assignToNode(both.id, 'physics'));
    await tags.assignToNode(both.id, 'math');
    await tags.assignToNode(onlyPhysics.id, 'physics');
    const math = first((await tags.list()).filter((tag) => tag.label === 'math'));

    const physicsOnly = await nodes.list({
      sort: 'title-asc',
      page: { limit: 10 },
      tagIds: [physics.id],
    });
    const physicsAndMath = await nodes.list({
      sort: 'title-asc',
      page: { limit: 10 },
      tagIds: [physics.id, math.id],
    });

    expect(physicsOnly.items.map((item) => item.title)).toEqual(['Both', 'Only physics']);
    expect(physicsOnly.totalCount).toBe(2);
    expect(physicsAndMath.items.map((item) => item.title)).toEqual(['Both']);
    expect(physicsAndMath.totalCount).toBe(1);
    expect(first(physicsAndMath.items).tags.map((tag) => tag.label)).toEqual(['math', 'physics']);
  });

  it('copies tags when a node is duplicated', async () => {
    const { nodes, tags } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Original' });
    await tags.assignToNode(node.id, 'keep me');

    await expect(nodes.duplicate(node.id)).resolves.toMatchObject({
      tags: [{ label: 'keep me' }],
    });
  });
});

describe('workspace isolation', () => {
  it('keeps same-named tags separate per workspace and blocks cross-workspace use', async () => {
    const a = services(WORKSPACE_A);
    const b = services(WORKSPACE_B);
    const nodeA = await a.nodes.create({ title: 'A' });
    const nodeB = await b.nodes.create({ title: 'B' });
    const tagA = first(await a.tags.assignToNode(nodeA.id, 'same name'));
    const tagB = first(await b.tags.assignToNode(nodeB.id, 'same name'));

    expect(tagA.id).not.toBe(tagB.id);
    await expect(b.tags.rename(tagA.id, 'stolen')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.tags.assignToNode(nodeA.id, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Even a raw attach of A's tag to B's node is refused by the composite foreign key.
    await expect(
      connections.runInTransaction(() =>
        new SqliteTagRepository(connections).attach(WORKSPACE_B, nodeB.id, tagA.id, clock.now()),
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
