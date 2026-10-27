/**
 * Learning timeline against a real database (PRD §5.9, Phase 4 exit criterion "timeline uses
 * correct timezone and event grouping").
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createTimelineService,
  createTagService,
  createWorkspaceService,
  type KnowledgeNodeService,
  type TagService,
  type TimelineQuery,
  type TimelineService,
  type UtcTimestamp,
  type WorkspaceId,
  type WorkspaceService,
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

const WORKSPACE_A = 'a0000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = 'a0000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let idCounter = 0;
const ids = {
  newId: () => `e0000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
let now = '2026-10-27T12:00:00.000Z';
const clock = { now: () => now as UtcTimestamp };

interface Services {
  nodes: KnowledgeNodeService;
  timeline: TimelineService;
  tags: TagService;
  workspaces: WorkspaceService;
}

function services(workspaceId: WorkspaceId): Services {
  const nodeRepository = new SqliteKnowledgeNodeRepository(connections);
  const timelineRepository = new SqliteTimelineEventRepository(connections);
  const tagRepository = new SqliteTagRepository(connections);
  const workspaceRepository = new SqliteWorkspaceRepository(connections);
  return {
    nodes: createKnowledgeNodeService({
      workspaceId,
      transactions: connections,
      nodes: nodeRepository,
      timeline: timelineRepository,
      tags: tagRepository,
      references: new SqliteNoteReferenceRepository(connections),
      ids,
      clock,
    }),
    timeline: createTimelineService({
      workspaceId,
      transactions: connections,
      timeline: timelineRepository,
      nodes: nodeRepository,
      workspaces: workspaceRepository,
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
    workspaces: createWorkspaceService({
      transactions: connections,
      workspaces: workspaceRepository,
      relationshipTypes: new SqliteRelationshipTypeRepository(connections),
      ids,
      clock,
    }),
  };
}

const ALL: TimelineQuery = {
  fromDate: null,
  toDate: null,
  eventTypes: [],
  tagIds: [],
  nodeId: null,
  page: { limit: 100 },
};

async function list(timeline: TimelineService, query: Partial<TimelineQuery> = {}) {
  return (await timeline.list({ ...ALL, ...query })).items;
}

beforeEach(async () => {
  now = '2026-10-27T12:00:00.000Z';
  directory = mkdtempSync(join(tmpdir(), 'mmap-timeline-'));
  connections = (
    await openWorkspaceDatabase(join(directory, 'mmap.sqlite'), { backupDirectory: directory })
  ).connections;
  const { workspaces } = services(WORKSPACE_A);
  await workspaces.initialize(WORKSPACE_A, 'A', 'UTC');
  await workspaces.initialize(WORKSPACE_B, 'B', 'UTC');
});

afterEach(async () => {
  await connections.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('recorded activity', () => {
  it('lists events newest first, grouping note edits into one editing session', async () => {
    const { nodes, timeline } = services(WORKSPACE_A);
    now = '2026-10-27T09:00:00.000Z';
    let node = await nodes.create({ title: 'Entropy' });
    for (const minute of ['09:05', '09:20', '09:45']) {
      now = `2026-10-27T${minute}:00.000Z`;
      node = await nodes.update(node.id, node.revision, {
        note: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: `at ${minute}` }] }],
        },
      });
    }
    now = '2026-10-27T11:00:00.000Z'; // 75 minutes later: a new session
    await nodes.update(node.id, node.revision, {
      note: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'later' }] }],
      },
    });

    const events = await list(timeline);
    expect(
      events.map((event) => [event.eventType, event.occurredAt, event.lastActivityAt]),
    ).toEqual([
      ['note_updated', '2026-10-27T11:00:00.000Z', '2026-10-27T11:00:00.000Z'],
      ['note_updated', '2026-10-27T09:05:00.000Z', '2026-10-27T09:45:00.000Z'],
      ['node_created', '2026-10-27T09:00:00.000Z', '2026-10-27T09:00:00.000Z'],
    ]);
  });

  it('keeps entries of deleted nodes readable', async () => {
    const { nodes, timeline } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Gone soon' });
    await nodes.delete(node.id, node.revision);

    expect(await list(timeline)).toMatchObject([
      {
        eventType: 'node_created',
        nodeId: null,
        nodeTitleSnapshot: 'Gone soon',
        currentNodeTitle: null,
      },
    ]);
  });

  it('pages without repeating or skipping entries', async () => {
    const { nodes, timeline } = services(WORKSPACE_A);
    for (let index = 0; index < 7; index += 1) {
      now = `2026-10-27T10:0${index}:00.000Z`;
      await nodes.create({ title: `Node ${index}` });
    }
    // Two events in the same millisecond must still page correctly (ordered by ID).
    await nodes.create({ title: 'Same time' });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await timeline.list({ ...ALL, page: { limit: 3, cursor } });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('rejects a forged cursor', async () => {
    const { timeline } = services(WORKSPACE_A);
    await expect(
      timeline.list({ ...ALL, page: { limit: 3, cursor: 'not-a-cursor' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('filters', () => {
  it('filters by event type, node and tags', async () => {
    const { nodes, timeline, tags } = services(WORKSPACE_A);
    const tagged = await nodes.create({ title: 'Tagged' });
    const other = await nodes.create({ title: 'Other' });
    await tags.assignToNode(tagged.id, 'physics');
    const tag = (await tags.list())[0]!;
    await timeline.markReviewed(other.id, null);

    expect((await list(timeline, { eventTypes: ['reviewed'] })).map((e) => e.nodeId)).toEqual([
      other.id,
    ]);
    expect((await list(timeline, { nodeId: tagged.id })).map((e) => e.eventType)).toEqual([
      'node_created',
    ]);
    expect((await list(timeline, { tagIds: [tag.id] })).map((e) => e.nodeId)).toEqual([tagged.id]);
  });

  it('interprets date ranges as calendar days in the workspace timezone', async () => {
    const { nodes, timeline, workspaces } = services(WORKSPACE_A);
    await workspaces.setTimezone(WORKSPACE_A, 'Asia/Jerusalem');
    // 2026-03-26 23:30 UTC is already 27 March in Jerusalem (UTC+2 before the DST change).
    now = '2026-03-26T21:30:00.000Z';
    await nodes.create({ title: 'Late 26th local' });
    now = '2026-03-26T22:30:00.000Z';
    await nodes.create({ title: 'Early 27th local' });
    // 27 March is a 23-hour day in Jerusalem; 21:30 UTC is 00:30 on the 28th (UTC+3).
    now = '2026-03-27T21:30:00.000Z';
    await nodes.create({ title: 'Early 28th local' });

    const day = await list(timeline, { fromDate: '2026-03-27', toDate: '2026-03-27' });
    expect(day.map((event) => event.nodeTitleSnapshot)).toEqual(['Early 27th local']);

    await workspaces.setTimezone(WORKSPACE_A, 'UTC');
    const utcDay = await list(timeline, { fromDate: '2026-03-27', toDate: '2026-03-27' });
    expect(utcDay.map((event) => event.nodeTitleSnapshot)).toEqual(['Early 28th local']);
  });

  it('rejects an inverted date range and an unknown timezone', async () => {
    const { timeline, workspaces } = services(WORKSPACE_A);
    await expect(
      timeline.list({ ...ALL, fromDate: '2026-03-28', toDate: '2026-03-27' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(workspaces.setTimezone(WORKSPACE_A, 'Mars/Olympus')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('never shows events of another workspace', async () => {
    await services(WORKSPACE_A).nodes.create({ title: 'Private' });
    expect(await list(services(WORKSPACE_B).timeline)).toEqual([]);
  });
});

describe('reviewed entries', () => {
  it('records a review with a reflection, which the user can edit and delete', async () => {
    const { nodes, timeline } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Entropy' });
    const review = await timeline.markReviewed(node.id, '  Finally clear:\nheat flows downhill.  ');

    expect(review).toMatchObject({
      eventType: 'reviewed',
      reflection: 'Finally clear:\nheat flows downhill.',
      currentNodeTitle: 'Entropy',
      isImported: false,
    });
    const edited = await timeline.updateReflection(review.id, '   ');
    expect(edited.reflection).toBeNull();

    await timeline.deleteReviewed(review.id);
    expect((await list(timeline)).map((event) => event.eventType)).toEqual(['node_created']);
  });

  it('never changes or removes recorded activity', async () => {
    const { nodes, timeline } = services(WORKSPACE_A);
    await nodes.create({ title: 'Recorded' });
    const [created] = await list(timeline);

    await expect(timeline.updateReflection(created!.id, 'no')).rejects.toMatchObject({
      code: 'INVARIANT_VIOLATION',
    });
    await expect(timeline.deleteReviewed(created!.id)).rejects.toMatchObject({
      code: 'INVARIANT_VIOLATION',
    });
  });

  it('validates reflections and nodes', async () => {
    const { nodes, timeline } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Node' });

    await expect(timeline.markReviewed(node.id, 'x'.repeat(2_001))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(timeline.markReviewed(node.id, 'bell\u0007')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const foreign = await services(WORKSPACE_B).nodes.create({ title: 'Foreign' });
    await expect(timeline.markReviewed(foreign.id, null)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
