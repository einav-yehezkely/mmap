/**
 * Knowledge node service + SQLite repositories, tested together against a real database
 * (PRD §10.6, §11: revisions, workspace isolation, transactions, FTS5).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createWorkspaceService,
  type KnowledgeNodeService,
  type NodeId,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteKnowledgeNodeRepository } from './sqlite-knowledge-node-repository';
import { SqliteRelationshipTypeRepository } from './sqlite-relationship-type-repository';
import { SqliteTimelineEventRepository } from './sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository';

const WORKSPACE_A = '30000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = '30000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let clockMillis: number;
let idCounter: number;

function nextId(): string {
  idCounter += 1;
  return `40000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}

const clock = {
  now: (): UtcTimestamp => {
    clockMillis += 1_000;
    return new Date(clockMillis).toISOString() as UtcTimestamp;
  },
};

function nodeService(workspaceId: WorkspaceId): KnowledgeNodeService {
  return createKnowledgeNodeService({
    workspaceId,
    transactions: connections,
    nodes: new SqliteKnowledgeNodeRepository(connections),
    timeline: new SqliteTimelineEventRepository(connections),
    ids: { newId: nextId },
    clock,
  });
}

function scalar(sql: string, ...parameters: string[]): unknown {
  const row = connections
    .forRead()
    .prepare(sql)
    .get(...parameters);
  return row === undefined ? undefined : Object.values(row)[0];
}

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-nodes-'));
  clockMillis = Date.parse('2026-10-26T12:00:00.000Z');
  idCounter = 0;
  connections = (
    await openWorkspaceDatabase(join(directory, 'mmap.sqlite'), { backupDirectory: directory })
  ).connections;
  const workspaces = createWorkspaceService({
    transactions: connections,
    workspaces: new SqliteWorkspaceRepository(connections),
    relationshipTypes: new SqliteRelationshipTypeRepository(connections),
    ids: { newId: nextId },
    clock,
  });
  await workspaces.initialize(WORKSPACE_A, 'A', 'UTC');
  await workspaces.initialize(WORKSPACE_B, 'B', 'UTC');
});

afterEach(async () => {
  await connections.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('create and read', () => {
  it('creates a node with an empty note, revision 1 and a timeline event', async () => {
    const node = await nodeService(WORKSPACE_A).create({ title: '  Entropy\n', summary: '  ' });

    expect(node).toMatchObject({ title: 'Entropy', summary: null, revision: 1 });
    expect(node.note).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(
      scalar(
        "SELECT node_title_snapshot FROM timeline_events WHERE node_id = ? AND event_type = 'node_created'",
        node.id,
      ),
    ).toBe('Entropy');
  });

  it('allows duplicate titles because identity is the ID (PRD §4.1)', async () => {
    const service = nodeService(WORKSPACE_A);
    const first = await service.create({ title: 'Same' });
    const second = await service.create({ title: 'Same' });

    expect(first.id).not.toBe(second.id);
  });

  it('rejects empty titles without writing anything', async () => {
    await expect(nodeService(WORKSPACE_A).create({ title: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(scalar('SELECT count(*) FROM knowledge_nodes')).toBe(0);
  });
});

describe('update and revisions (PRD §5.2, §13 criterion 13)', () => {
  it('saves note content, derives plain text and updates the search index', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Waves' });

    const updated = await service.update(node.id, 1, { note: paragraph('Interference patterns') });

    expect(updated.revision).toBe(2);
    expect(scalar('SELECT note_plain_text FROM knowledge_nodes WHERE id = ?', node.id)).toBe(
      'Interference patterns',
    );
    expect(
      scalar(
        "SELECT count(*) FROM knowledge_nodes_fts WHERE knowledge_nodes_fts MATCH 'interference'",
      ),
    ).toBe(1);
  });

  it('rejects a stale revision and keeps the newer content', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Original' });
    await service.update(node.id, 1, { title: 'Saved by window one' });

    await expect(service.update(node.id, 1, { title: 'Stale window two' })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(service.get(node.id)).resolves.toMatchObject({
      title: 'Saved by window one',
      revision: 2,
    });
  });

  it('rejects unsafe note content and leaves the stored note unchanged', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Links' });
    const hostile = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    };

    await expect(service.update(node.id, 1, { note: hostile })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.get(node.id)).resolves.toMatchObject({ revision: 1 });
  });

  it('keeps unchanged fields when only one field is updated', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Keep', summary: 'A summary' });
    await service.update(node.id, 1, { note: paragraph('body') });

    await expect(service.update(node.id, 2, { title: 'Renamed' })).resolves.toMatchObject({
      title: 'Renamed',
      summary: 'A summary',
      note: paragraph('body'),
    });
  });

  it('can clear the summary explicitly', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'T', summary: 'remove me' });

    await expect(service.update(node.id, 1, { summary: null })).resolves.toMatchObject({
      summary: null,
    });
  });
});

describe('timeline editing sessions (PRD §5.9)', () => {
  function noteEvents(nodeId: NodeId) {
    return connections
      .forRead()
      .prepare(
        `SELECT occurred_at, last_activity_at FROM timeline_events
         WHERE node_id = ? AND event_type = 'note_updated' ORDER BY occurred_at`,
      )
      .all(nodeId);
  }

  it('groups note saves into one event per session and starts a new one after 30 minutes', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Session' });
    let revision = node.revision;
    for (const word of ['a', 'ab', 'abc']) {
      revision = (await service.update(node.id, revision, { note: paragraph(word) })).revision;
    }
    expect(noteEvents(node.id)).toHaveLength(1);
    const [session] = noteEvents(node.id);
    expect(session?.last_activity_at).not.toBe(session?.occurred_at);

    clockMillis += 31 * 60 * 1_000;
    await service.update(node.id, revision, { note: paragraph('after a break') });

    expect(noteEvents(node.id)).toHaveLength(2);
  });

  it('does not record title-only changes as note updates', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Before' });

    await service.update(node.id, 1, { title: 'After' });

    expect(noteEvents(node.id)).toHaveLength(0);
  });

  it('does not record a save that leaves the note unchanged', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Same' });
    const saved = await service.update(node.id, 1, { note: paragraph('x') });

    await service.update(node.id, saved.revision, { note: paragraph('x'), title: 'Renamed' });

    expect(noteEvents(node.id)).toHaveLength(1);
  });
});

describe('list and pagination', () => {
  it('pages through all nodes without gaps or duplicates in every sort order', async () => {
    const service = nodeService(WORKSPACE_A);
    const titles = ['delta', 'Alpha', 'charlie', 'Bravo', 'echo'];
    for (const title of titles) {
      await service.create({ title });
    }

    for (const sort of ['updated-desc', 'created-desc', 'title-asc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.list({ sort, page: { limit: 2, cursor } });
        expect(page.totalCount).toBe(5);
        seen.push(...page.items.map((item) => item.title));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      expect([...seen].sort()).toEqual([...titles].sort());
      if (sort === 'title-asc') {
        expect(seen).toEqual(['Alpha', 'Bravo', 'charlie', 'delta', 'echo']);
      }
      if (sort === 'created-desc') {
        expect(seen).toEqual([...titles].reverse());
      }
    }
  });

  it('does not repeat or skip rows when a node is edited between pages', async () => {
    const service = nodeService(WORKSPACE_A);
    const nodes = [];
    for (const title of ['one', 'two', 'three', 'four']) {
      nodes.push(await service.create({ title }));
    }
    const firstPage = await service.list({ sort: 'created-desc', page: { limit: 2 } });
    // Editing changes updated_at but not created_at, so the created order is stable.
    const first = nodes[0];
    if (first === undefined) throw new Error('fixture missing');
    await service.update(first.id, 1, { title: 'one (edited)' });
    const secondPage = await service.list({
      sort: 'created-desc',
      page: { limit: 2, cursor: firstPage.nextCursor ?? undefined },
    });

    expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).toEqual(
      [...nodes].reverse().map((node) => node.id),
    );
  });

  it('rejects a tampered cursor', async () => {
    await expect(
      nodeService(WORKSPACE_A).list({ sort: 'updated-desc', page: { limit: 10, cursor: '%%%' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('workspace isolation (acceptance criterion 2)', () => {
  it('never reads, updates, lists or deletes nodes of another workspace', async () => {
    const foreign = await nodeService(WORKSPACE_B).create({ title: 'Secret' });
    const service = nodeService(WORKSPACE_A);

    await expect(service.get(foreign.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.update(foreign.id, 1, { title: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.delete(foreign.id, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.list({ sort: 'updated-desc', page: { limit: 10 } }),
    ).resolves.toMatchObject({ items: [], totalCount: 0 });
  });
});

describe('duplicate', () => {
  it('copies title, summary and note but not relationships', async () => {
    const service = nodeService(WORKSPACE_A);
    const source = await service.create({ title: 'Source', summary: 'S' });
    await service.update(source.id, 1, { note: paragraph('shared text') });
    const other = await service.create({ title: 'Other' });
    insertRelationship(source.id, other.id);

    const copy = await service.duplicate(source.id);

    expect(copy).toMatchObject({
      title: 'Source (copy)',
      summary: 'S',
      note: paragraph('shared text'),
      revision: 1,
    });
    expect(
      scalar(
        'SELECT count(*) FROM relationships WHERE source_node_id = ? OR target_node_id = ?',
        copy.id,
        copy.id,
      ),
    ).toBe(0);
  });
});

describe('delete (PRD §5.2, acceptance criterion 8)', () => {
  it('previews and removes dependents transactionally, keeping history readable', async () => {
    const service = nodeService(WORKSPACE_A);
    const doomed = await service.create({ title: 'Doomed' });
    const neighbour = await service.create({ title: 'Neighbour' });
    insertRelationship(doomed.id, neighbour.id);
    insertReference(neighbour.id, doomed.id);

    await expect(service.previewDelete(doomed.id)).resolves.toEqual({
      relationships: 1,
      referencingNotes: 1,
      mapPlacements: 0,
      attachments: 0,
    });

    await service.delete(doomed.id, 1);

    expect(scalar('SELECT count(*) FROM relationships')).toBe(0);
    expect(scalar('SELECT count(*) FROM note_references')).toBe(0);
    await expect(service.get(neighbour.id)).resolves.toMatchObject({ title: 'Neighbour' });
    // The creation event survives with a readable title snapshot.
    expect(
      scalar(
        "SELECT node_title_snapshot FROM timeline_events WHERE node_id IS NULL AND event_type = 'node_created'",
      ),
    ).toBe('Doomed');
  });

  it('promotes child placements instead of deleting map subtrees', async () => {
    const service = nodeService(WORKSPACE_A);
    const root = await service.create({ title: 'Root' });
    const middle = await service.create({ title: 'Middle' });
    const leaf = await service.create({ title: 'Leaf' });
    const mapId = insertMap();
    const rootPlacement = insertPlacement(mapId, root.id, null);
    const middlePlacement = insertPlacement(mapId, middle.id, rootPlacement);
    const leafPlacement = insertPlacement(mapId, leaf.id, middlePlacement);

    await service.delete(middle.id, 1);

    expect(
      scalar('SELECT parent_placement_id FROM map_placements WHERE id = ?', leafPlacement),
    ).toBe(rootPlacement);
    expect(scalar('SELECT count(*) FROM map_placements')).toBe(2);
  });

  it('refuses to delete based on an outdated revision', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Edited elsewhere' });
    await service.update(node.id, 1, { title: 'Newer' });

    await expect(service.delete(node.id, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(scalar('SELECT count(*) FROM knowledge_nodes')).toBe(1);
  });
});

// --- Fixture helpers for tables that have no service yet (relationships, references, maps). ---

const NOW = '2026-10-26T12:00:00.000Z';

function write(sql: string, ...parameters: (string | null)[]): void {
  connections.writerConnection.prepare(sql).run(...parameters);
}

function insertRelationship(source: NodeId, target: NodeId): void {
  const typeId = String(
    scalar(
      "SELECT id FROM relationship_types WHERE workspace_id = ? AND normalized_label = 'depends on'",
      WORKSPACE_A,
    ),
  );
  write(
    `INSERT INTO relationships (id, workspace_id, source_node_id, target_node_id, type_id,
       directionality, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'directed', ?, ?)`,
    nextId(),
    WORKSPACE_A,
    source,
    target,
    typeId,
    NOW,
    NOW,
  );
}

function insertReference(source: NodeId, target: NodeId): void {
  write(
    `INSERT INTO note_references (workspace_id, source_node_id, ordinal, target_node_id, label)
     VALUES (?, ?, 0, ?, 'link')`,
    WORKSPACE_A,
    source,
    target,
  );
}

function insertMap(): string {
  const id = nextId();
  write(
    `INSERT INTO mind_maps (id, workspace_id, title, mode, created_at, updated_at)
     VALUES (?, ?, 'Map', 'hierarchical', ?, ?)`,
    id,
    WORKSPACE_A,
    NOW,
    NOW,
  );
  return id;
}

function insertPlacement(mapId: string, nodeId: NodeId, parent: string | null): string {
  const id = nextId();
  write(
    `INSERT INTO map_placements (id, workspace_id, map_id, node_id, parent_placement_id,
       created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    WORKSPACE_A,
    mapId,
    nodeId,
    parent,
    NOW,
    NOW,
  );
  return id;
}
