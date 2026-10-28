/**
 * `SqliteSearchIndex` against a real temporary database (PRD §5.8, §10.6, §11): FTS5 ranking,
 * snippets, pagination, tag filters, picker lookup and workspace isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeNodeService,
  createRelationshipService,
  createTagService,
  createWorkspaceService,
  type KnowledgeNodeService,
  type NodeId,
  type RelationshipService,
  type RelationshipTypeId,
  type SearchHit,
  type TagId,
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
import { SqliteSearchIndex } from './sqlite-search-index';

const WORKSPACE_A = '70000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = '70000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let index: SqliteSearchIndex;
let idCounter = 0;

const ids = {
  newId: () => `80000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
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

const paragraph = (text: string): unknown => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Creates a node through the real service, so plain text and FTS rows come from the triggers. */
async function createNode(
  workspaceId: WorkspaceId,
  fields: { title: string; summary?: string; note?: string },
): Promise<NodeId> {
  const { nodes } = services(workspaceId);
  const node = await nodes.create({ title: fields.title, summary: fields.summary ?? null });
  if (fields.note !== undefined) {
    await nodes.update(node.id, node.revision, { note: paragraph(fields.note) });
  }
  return node.id;
}

async function tag(workspaceId: WorkspaceId, nodeId: NodeId, label: string): Promise<TagId> {
  const assigned = await services(workspaceId).tags.assignToNode(nodeId, label);
  const found = assigned.find((summary) => summary.label === label);
  if (found === undefined) throw new Error(`Tag ${label} was not assigned.`);
  return found.id;
}

function search(
  text: string,
  options: {
    workspaceId?: WorkspaceId;
    tagIds?: TagId[];
    relationshipTypeIds?: RelationshipTypeId[];
    limit?: number;
    cursor?: string;
  } = {},
): ReturnType<SqliteSearchIndex['search']> {
  return index.search({
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    text,
    tagIds: options.tagIds ?? [],
    relationshipTypeIds: options.relationshipTypeIds ?? [],
    page: { limit: options.limit ?? 20, cursor: options.cursor },
  });
}

function relationships(workspaceId: WorkspaceId): RelationshipService {
  return createRelationshipService({
    workspaceId,
    transactions: connections,
    relationships: new SqliteRelationshipRepository(connections),
    types: new SqliteRelationshipTypeRepository(connections),
    nodes: new SqliteKnowledgeNodeRepository(connections),
    timeline: new SqliteTimelineEventRepository(connections),
    ids,
    clock,
  });
}

/** Relates two nodes with the built-in type `label`; returns the type's ID. */
async function relate(
  workspaceId: WorkspaceId,
  sourceNodeId: NodeId,
  targetNodeId: NodeId,
  label: string,
): Promise<RelationshipTypeId> {
  const service = relationships(workspaceId);
  const type = (await service.listTypes()).find((item) => item.label === label);
  if (type === undefined) throw new Error(`No type ${label}`);
  await service.create({ sourceNodeId, targetNodeId, typeId: type.id });
  return type.id;
}

const hitIds = (hits: readonly SearchHit[]): NodeId[] => hits.map((hit) => hit.nodeId);

const snippetText = (hit: SearchHit | undefined): string =>
  (hit?.snippet ?? []).map((segment) => segment.text).join('');

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-search-'));
  connections = (
    await openWorkspaceDatabase(join(directory, 'mmap.sqlite'), { backupDirectory: directory })
  ).connections;
  index = new SqliteSearchIndex(connections);
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

describe('search matching and ranking', () => {
  it('ranks a title match above a match only in the note', async () => {
    const inNote = await createNode(WORKSPACE_A, {
      title: 'Thermodynamics',
      note: 'The second law introduces entropy as a state function.',
    });
    const inTitle = await createNode(WORKSPACE_A, { title: 'Entropy' });

    const page = await search('entropy');

    expect(hitIds(page.items)).toEqual([inTitle, inNote]);
    expect(page.totalCount).toBe(2);
  });

  it('ranks a summary match above a match only in the note', async () => {
    const inNote = await createNode(WORKSPACE_A, { title: 'A', note: 'about photosynthesis' });
    const inSummary = await createNode(WORKSPACE_A, {
      title: 'B',
      summary: 'photosynthesis basics',
    });

    expect(hitIds((await search('photosynthesis')).items)).toEqual([inSummary, inNote]);
  });

  it('ignores diacritics and case', async () => {
    const node = await createNode(WORKSPACE_A, { title: 'Café culture' });

    expect(hitIds((await search('cafe')).items)).toEqual([node]);
    expect(hitIds((await search('CAFÉ')).items)).toEqual([node]);
  });

  it('matches the last word as a prefix', async () => {
    const node = await createNode(WORKSPACE_A, { title: 'Entropy' });

    expect(hitIds((await search('entro')).items)).toEqual([node]);
  });

  it('matches earlier words as whole words only', async () => {
    await createNode(WORKSPACE_A, { title: 'Entropy and heat' });

    expect((await search('entro heat')).items).toEqual([]);
  });

  it('requires every word (AND)', async () => {
    const both = await createNode(WORKSPACE_A, { title: 'Wave', note: 'interference of light' });
    await createNode(WORKSPACE_A, { title: 'Light', note: 'photons only' });
    await createNode(WORKSPACE_A, { title: 'Sound', note: 'interference of sound' });

    expect(hitIds((await search('light interference')).items)).toEqual([both]);
  });

  it('finds Hebrew and Arabic text', async () => {
    const hebrew = await createNode(WORKSPACE_A, { title: 'שלום עולם' });
    const arabic = await createNode(WORKSPACE_A, { title: 'Greeting', note: 'مرحبا بالعالم' });

    expect(hitIds((await search('עולם')).items)).toEqual([hebrew]);
    expect(hitIds((await search('مرحبا')).items)).toEqual([arabic]);
  });

  it('finds pointed Hebrew with the same pointing (niqqud is part of the indexed word)', async () => {
    // unicode61 removes Latin diacritics but keeps Hebrew points, so "שלום" does not match
    // "שָׁלוֹם". This documents the tokenizer's behaviour rather than endorsing it.
    const pointed = await createNode(WORKSPACE_A, { title: 'שָׁלוֹם' });

    expect(hitIds((await search('שָׁלוֹם')).items)).toEqual([pointed]);
  });

  it('reflects note edits through the FTS triggers', async () => {
    const { nodes } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Draft' });
    await nodes.update(node.id, 1, { note: paragraph('first idea: superconductivity') });
    await nodes.update(node.id, 2, { note: paragraph('second idea: magnetism') });

    expect((await search('superconductivity')).items).toEqual([]);
    expect(hitIds((await search('magnetism')).items)).toEqual([node.id]);
  });

  it('returns an empty page for text without searchable words', async () => {
    await createNode(WORKSPACE_A, { title: 'Anything' });

    await expect(search('  "*()^ 😀 ')).resolves.toEqual({
      items: [],
      nextCursor: null,
      totalCount: 0,
    });
  });

  it.each([
    '"',
    'title:secret',
    'summary:x OR note_plain_text:y',
    'a OR b',
    'a AND b',
    'NOT a',
    'NEAR(a b, 2)',
    '*',
    '-x',
    '(',
    ')',
    '^',
    '{title}: x',
    "'; DROP TABLE knowledge_nodes; --",
    '\u0000',
    'x'.repeat(10_000),
  ])('treats hostile input %j as literal words', async (text) => {
    const secret = await createNode(WORKSPACE_A, { title: 'Secret plans', note: 'title data' });

    const page = await search(text);

    // The query must run without an FTS5 syntax error, and anything it finds can only come
    // from the literal words in the input (here at most the one node).
    for (const hit of page.items) {
      expect(hit.nodeId).toBe(secret);
    }
    await expect(search('plans')).resolves.toMatchObject({ totalCount: 1 });
  });

  it('treats a column filter as two literal words', async () => {
    const both = await createNode(WORKSPACE_A, { title: 'Title of the secret' });
    await createNode(WORKSPACE_A, { title: 'secret', note: 'no t-word here' });

    expect(hitIds((await search('title:secret')).items)).toEqual([both]);
  });
});

describe('search snippets', () => {
  it('returns plain-text segments with the matched words highlighted', async () => {
    await createNode(WORKSPACE_A, {
      title: 'Thermodynamics',
      note: 'The second law states that entropy of an isolated system never decreases.',
    });

    const [hit] = (await search('entropy')).items;

    expect(hit?.snippet).toContainEqual({ text: 'entropy', isMatch: true });
    expect(snippetText(hit)).toContain('second law states that entropy of an isolated');
  });

  it('returns markup-like content as literal text', async () => {
    await createNode(WORKSPACE_A, {
      title: 'Markup',
      note: 'payload <script>alert(1)</script> &amp; more payload',
    });

    const [hit] = (await search('payload')).items;
    const text = snippetText(hit);

    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('&amp;');
    expect(hit?.snippet.filter((segment) => segment.isMatch)).toEqual([
      { text: 'payload', isMatch: true },
      { text: 'payload', isMatch: true },
    ]);
  });

  it('strips private-use marker characters that occur in stored text', async () => {
    await createNode(WORKSPACE_A, { title: 'Odd text', note: 'odd  marker  text' });

    const [hit] = (await search('marker')).items;

    expect(snippetText(hit)).not.toMatch(/[]/u);
    expect(snippetText(hit)).toContain('marker');
  });

  it('uses the title as the snippet when only the title matches', async () => {
    await createNode(WORKSPACE_A, { title: 'Quantum tunnelling' });

    const [hit] = (await search('tunnelling')).items;

    expect(hit?.snippet).toEqual([
      { text: 'Quantum ', isMatch: false },
      { text: 'tunnelling', isMatch: true },
    ]);
  });
});

describe('search pagination and filters', () => {
  async function createNumbered(count: number): Promise<NodeId[]> {
    const created: NodeId[] = [];
    for (let number = 0; number < count; number += 1) {
      created.push(await createNode(WORKSPACE_A, { title: `Orbit ${number}` }));
    }
    return created;
  }

  it('pages through all results without gaps or repeats and reports the total', async () => {
    const created = await createNumbered(5);

    const first = await search('orbit', { limit: 2 });
    const second = await search('orbit', { limit: 2, cursor: first.nextCursor ?? undefined });
    const third = await search('orbit', { limit: 2, cursor: second.nextCursor ?? undefined });

    expect(first.totalCount).toBe(5);
    expect(third.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items, ...third.items].map((hit) => hit.nodeId);
    expect([...seen].sort()).toEqual([...created].sort());
  });

  it('orders equal scores by node ID', async () => {
    // Identical single-word titles give identical BM25 scores.
    const twins = [
      await createNode(WORKSPACE_A, { title: 'Twin' }),
      await createNode(WORKSPACE_A, { title: 'Twin' }),
    ];

    expect(hitIds((await search('twin')).items)).toEqual([...twins].sort());
  });

  it('clamps the page size', async () => {
    await createNumbered(3);

    const page = await search('orbit', { limit: 0 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it.each([
    ['not base64 JSON', '!!!'],
    ['a negative offset', Buffer.from('{"offset":-1}').toString('base64url')],
    ['a fractional offset', Buffer.from('{"offset":1.5}').toString('base64url')],
    ['a string offset', Buffer.from('{"offset":"1"}').toString('base64url')],
    ['an extra field', Buffer.from('{"offset":1,"x":1}').toString('base64url')],
    ['an array', Buffer.from('[1]').toString('base64url')],
    ['a huge offset', Buffer.from('{"offset":99999999}').toString('base64url')],
    ['padded base64', `${Buffer.from('{"offset":2}').toString('base64')}==`],
  ])('rejects a cursor with %s', async (_name, cursor) => {
    await expect(search('orbit', { cursor })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Even when the text has no searchable words.
    await expect(search('', { cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns only nodes carrying every requested tag', async () => {
    const both = await createNode(WORKSPACE_A, { title: 'Lens optics' });
    const onlyOne = await createNode(WORKSPACE_A, { title: 'Lens design' });
    await createNode(WORKSPACE_A, { title: 'Lens history' });
    const physics = await tag(WORKSPACE_A, both, 'physics');
    const optics = await tag(WORKSPACE_A, both, 'optics');
    await tag(WORKSPACE_A, onlyOne, 'physics');

    const page = await search('lens', { tagIds: [physics, optics, physics] });

    expect(hitIds(page.items)).toEqual([both]);
    expect(page.totalCount).toBe(1);
    expect((await search('lens', { tagIds: [physics] })).totalCount).toBe(2);
  });
});

describe('relationship-type filter (PRD §5.8)', () => {
  it('returns nodes with a relationship of a chosen type at either end', async () => {
    const source = await createNode(WORKSPACE_A, { title: 'Orbit source' });
    const target = await createNode(WORKSPACE_A, { title: 'Orbit target' });
    const elsewhere = await createNode(WORKSPACE_A, { title: 'Orbit elsewhere' });
    const unrelated = await createNode(WORKSPACE_A, { title: 'Orbit alone' });
    const dependsOn = await relate(WORKSPACE_A, source, target, 'depends on');
    await relate(WORKSPACE_A, elsewhere, unrelated, 'related to');

    const page = await search('orbit', { relationshipTypeIds: [dependsOn] });

    expect(new Set(hitIds(page.items))).toEqual(new Set([source, target]));
    expect(page.totalCount).toBe(2);
  });

  it('matches any of several types, and combines with tags', async () => {
    const a = await createNode(WORKSPACE_A, { title: 'Wave a' });
    const b = await createNode(WORKSPACE_A, { title: 'Wave b' });
    const c = await createNode(WORKSPACE_A, { title: 'Wave c' });
    const d = await createNode(WORKSPACE_A, { title: 'Wave d' });
    const dependsOn = await relate(WORKSPACE_A, a, b, 'depends on');
    const relatedTo = await relate(WORKSPACE_A, c, d, 'related to');
    const physics = await tag(WORKSPACE_A, a, 'physics');
    await tag(WORKSPACE_A, c, 'physics');

    const anyType = await search('wave', {
      relationshipTypeIds: [dependsOn, relatedTo, dependsOn],
    });
    expect(anyType.totalCount).toBe(4);

    const withTag = await search('wave', { relationshipTypeIds: [dependsOn], tagIds: [physics] });
    expect(hitIds(withTag.items)).toEqual([a]);
    expect(withTag.totalCount).toBe(1);
  });

  it('returns nothing for a type no relationship uses', async () => {
    await createNode(WORKSPACE_A, { title: 'Quiet node' });
    const unused = (await relationships(WORKSPACE_A).listTypes()).find(
      (type) => type.label === 'contradicts',
    )!.id;

    expect((await search('quiet', { relationshipTypeIds: [unused] })).items).toEqual([]);
  });

  it('does not let a type from another workspace widen results', async () => {
    const a1 = await createNode(WORKSPACE_A, { title: 'Prism one' });
    const a2 = await createNode(WORKSPACE_A, { title: 'Prism two' });
    await relate(WORKSPACE_A, a1, a2, 'depends on');
    const b1 = await createNode(WORKSPACE_B, { title: 'Prism one' });
    const b2 = await createNode(WORKSPACE_B, { title: 'Prism two' });
    const typeInB = await relate(WORKSPACE_B, b1, b2, 'depends on');

    expect((await search('prism', { relationshipTypeIds: [typeInB] })).items).toEqual([]);
  });
});

describe('workspace isolation', () => {
  it('never returns or counts matches from another workspace', async () => {
    const inA = await createNode(WORKSPACE_A, { title: 'Shared words', note: 'gravity well' });
    const inB = await createNode(WORKSPACE_B, { title: 'Shared words', note: 'gravity well' });

    const pageA = await search('gravity');
    const pageB = await search('gravity', { workspaceId: WORKSPACE_B });

    expect(hitIds(pageA.items)).toEqual([inA]);
    expect(pageA.totalCount).toBe(1);
    expect(hitIds(pageB.items)).toEqual([inB]);
    expect(pageB.totalCount).toBe(1);
  });

  it('does not let a tag from another workspace widen results', async () => {
    await createNode(WORKSPACE_A, { title: 'Comet' });
    const inB = await createNode(WORKSPACE_B, { title: 'Comet' });
    const tagB = await tag(WORKSPACE_B, inB, 'space');

    expect((await search('comet', { tagIds: [tagB] })).items).toEqual([]);
  });

  it('isolates title lookup', async () => {
    const inA = await createNode(WORKSPACE_A, { title: 'Nebula' });
    await createNode(WORKSPACE_B, { title: 'Nebula' });

    await expect(index.lookupTitles(WORKSPACE_A, 'neb', 10)).resolves.toEqual([
      { nodeId: inA, title: 'Nebula' },
    ]);
  });
});

describe('lookupTitles', () => {
  const titlesFor = async (text: string, limit = 50, exclude: NodeId[] = []): Promise<string[]> =>
    (await index.lookupTitles(WORKSPACE_A, text, limit, exclude)).map((match) => match.title);

  it('lists prefix matches first, then substring matches, each by length, title and ID', async () => {
    for (const title of ['Thermal entropy', 'entropy', 'Entropy of mixing', 'Negentropy', 'Ent']) {
      await createNode(WORKSPACE_A, { title });
    }
    await createNode(WORKSPACE_A, { title: 'Unrelated' });

    expect(await titlesFor('ENTRO')).toEqual([
      'entropy',
      'Entropy of mixing',
      'Negentropy',
      'Thermal entropy',
    ]);
  });

  it('breaks exact ties by node ID', async () => {
    const first = await createNode(WORKSPACE_A, { title: 'Same' });
    const second = await createNode(WORKSPACE_A, { title: 'Same' });

    const matches = await index.lookupTitles(WORKSPACE_A, 'same', 10);

    expect(matches.map((match) => match.nodeId)).toEqual([first, second].sort());
  });

  it('treats LIKE wildcards and the escape character literally', async () => {
    for (const title of ['50% off', '500 items', 'a_b', 'axb', 'back\\slash', 'backslash']) {
      await createNode(WORKSPACE_A, { title });
    }

    expect(await titlesFor('50%')).toEqual(['50% off']);
    expect(await titlesFor('a_b')).toEqual(['a_b']);
    expect(await titlesFor('\\')).toEqual(['back\\slash']);
    expect(await titlesFor('%')).toEqual(['50% off']);
    expect(await titlesFor('_')).toEqual(['a_b']);
  });

  it('excludes the given node IDs', async () => {
    const keep = await createNode(WORKSPACE_A, { title: 'Pulsar' });
    const skip = await createNode(WORKSPACE_A, { title: 'Pulsar timing' });

    const matches = await index.lookupTitles(WORKSPACE_A, 'pulsar', 10, [skip, skip]);

    expect(matches).toEqual([{ nodeId: keep, title: 'Pulsar' }]);
  });

  it('returns nothing for empty or whitespace text', async () => {
    await createNode(WORKSPACE_A, { title: 'Anything' });

    expect(await titlesFor('')).toEqual([]);
    expect(await titlesFor('   ')).toEqual([]);
  });

  it('trims the text and clamps the limit to 1..50', async () => {
    for (let number = 0; number < 60; number += 1) {
      await createNode(WORKSPACE_A, { title: `Star ${number}` });
    }

    expect(await titlesFor('  star ', 1_000)).toHaveLength(50);
    expect(await titlesFor('star', 0)).toHaveLength(1);
    expect(await titlesFor('star', Number.NaN)).toHaveLength(1);
  });

  it('folds ASCII case only (no ICU in node:sqlite)', async () => {
    await createNode(WORKSPACE_A, { title: 'Émile' });

    expect(await titlesFor('Émile')).toEqual(['Émile']);
    expect(await titlesFor('émile')).toEqual([]);
  });

  it('matches Hebrew titles', async () => {
    await createNode(WORKSPACE_A, { title: 'תורת הקוונטים' });

    expect(await titlesFor('הקוו')).toEqual(['תורת הקוונטים']);
  });
});
