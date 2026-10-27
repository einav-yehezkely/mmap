/**
 * Wikilink references and backlinks against a real database (PRD §4.3, §5.4, §13 acceptance
 * criterion 5: "A selected [[wikilink]] navigates to its stable target after a rename. Its source
 * appears in backlinks; removing the link removes that backlink after save. No semantic
 * relationship is silently added.").
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
import { SqliteNoteReferenceRepository } from './sqlite-note-reference-repository';
import { SqliteRelationshipTypeRepository } from './sqlite-relationship-type-repository';
import { SqliteTagRepository } from './sqlite-tag-repository';
import { SqliteTimelineEventRepository } from './sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository';

const WORKSPACE_A = 'c0000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = 'c0000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let idCounter = 0;
const ids = {
  newId: () => `d0000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-27T12:00:00.000Z' as UtcTimestamp };

function nodeService(workspaceId: WorkspaceId): KnowledgeNodeService {
  return createKnowledgeNodeService({
    workspaceId,
    transactions: connections,
    nodes: new SqliteKnowledgeNodeRepository(connections),
    timeline: new SqliteTimelineEventRepository(connections),
    tags: new SqliteTagRepository(connections),
    references: new SqliteNoteReferenceRepository(connections),
    ids,
    clock,
  });
}

/** A note with one paragraph containing text and links to the given targets. */
function noteLinking(...targets: { id: NodeId; label: string }[]) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Related reading: ' },
          ...targets.map((target) => ({
            type: 'wikilink',
            attrs: { targetNodeId: target.id, label: target.label },
          })),
        ],
      },
    ],
  };
}

function countRelationships(): number {
  return Number(connections.forRead().prepare('SELECT count(*) AS n FROM relationships').get()?.n);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-references-'));
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

describe('wikilinks and backlinks (acceptance criterion 5)', () => {
  it('lists the source in the target backlinks, with an excerpt, and creates no relationship', async () => {
    const service = nodeService(WORKSPACE_A);
    const target = await service.create({ title: 'Entropy' });
    const source = await service.create({ title: 'Heat engines' });

    await service.update(source.id, 1, { note: noteLinking({ id: target.id, label: 'entropy' }) });

    await expect(service.backlinks(target.id)).resolves.toEqual([
      {
        sourceNodeId: source.id,
        sourceTitle: 'Heat engines',
        label: 'entropy',
        excerpt: 'Related reading: entropy',
        occurrences: 1,
      },
    ]);
    expect(countRelationships()).toBe(0);
  });

  it('keeps the link working after the target is renamed (identity is the ID)', async () => {
    const service = nodeService(WORKSPACE_A);
    const target = await service.create({ title: 'Entropy' });
    const source = await service.create({ title: 'Source' });
    await service.update(source.id, 1, { note: noteLinking({ id: target.id, label: 'Entropy' }) });

    await service.update(target.id, 1, { title: 'Thermodynamic entropy' });

    await expect(service.resolveLinkTargets([target.id])).resolves.toEqual([
      { id: target.id, title: 'Thermodynamic entropy' },
    ]);
    await expect(service.backlinks(target.id)).resolves.toHaveLength(1);
    // The label in the note stays as the author wrote it.
    expect(JSON.stringify((await service.get(source.id)).note)).toContain('"label":"Entropy"');
  });

  it('removes the backlink when the link is removed and the note is saved', async () => {
    const service = nodeService(WORKSPACE_A);
    const target = await service.create({ title: 'Target' });
    const source = await service.create({ title: 'Source' });
    const linked = await service.update(source.id, 1, {
      note: noteLinking({ id: target.id, label: 'Target' }),
    });
    await expect(service.backlinks(target.id)).resolves.toHaveLength(1);

    await service.update(source.id, linked.revision, { note: noteLinking() });

    await expect(service.backlinks(target.id)).resolves.toEqual([]);
  });

  it('keeps the link text readable and unresolved when the target is deleted', async () => {
    const service = nodeService(WORKSPACE_A);
    const target = await service.create({ title: 'Doomed' });
    const source = await service.create({ title: 'Source' });
    await service.update(source.id, 1, { note: noteLinking({ id: target.id, label: 'Doomed' }) });

    await expect(service.previewDelete(target.id)).resolves.toMatchObject({ referencingNotes: 1 });
    await service.delete(target.id, 1);

    const note = JSON.stringify((await service.get(source.id)).note);
    expect(note).toContain('"label":"Doomed"');
    await expect(service.resolveLinkTargets([target.id])).resolves.toEqual([]);
  });

  it('counts several links from one note as one backlink with occurrences', async () => {
    const service = nodeService(WORKSPACE_A);
    const target = await service.create({ title: 'Target' });
    const source = await service.create({ title: 'Source' });

    await service.update(source.id, 1, {
      note: noteLinking({ id: target.id, label: 'first' }, { id: target.id, label: 'second' }),
    });

    await expect(service.backlinks(target.id)).resolves.toMatchObject([
      { label: 'first', occurrences: 2 },
    ]);
  });

  it('gives a duplicated node the same outgoing links', async () => {
    const service = nodeService(WORKSPACE_A);
    const target = await service.create({ title: 'Target' });
    const source = await service.create({ title: 'Source' });
    await service.update(source.id, 1, { note: noteLinking({ id: target.id, label: 'Target' }) });

    await service.duplicate(source.id);

    expect((await service.backlinks(target.id)).map((link) => link.sourceTitle)).toEqual([
      'Source',
      'Source (copy)',
    ]);
  });

  it('does not list a note linking to itself as its own backlink', async () => {
    const service = nodeService(WORKSPACE_A);
    const node = await service.create({ title: 'Self' });

    await service.update(node.id, 1, { note: noteLinking({ id: node.id, label: 'me' }) });

    await expect(service.backlinks(node.id)).resolves.toEqual([]);
  });
});

describe('workspace isolation', () => {
  it('never stores or resolves links to another workspace', async () => {
    const a = nodeService(WORKSPACE_A);
    const b = nodeService(WORKSPACE_B);
    const foreign = await b.create({ title: 'Secret' });
    const source = await a.create({ title: 'Source' });

    await a.update(source.id, 1, { note: noteLinking({ id: foreign.id, label: 'guess' }) });

    await expect(b.backlinks(foreign.id)).resolves.toEqual([]);
    await expect(a.resolveLinkTargets([foreign.id])).resolves.toEqual([]);
  });
});
