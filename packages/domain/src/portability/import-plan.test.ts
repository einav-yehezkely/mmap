/**
 * Import planning (PRD §5.11, §11 "Unit: … import ID mapping"): new IDs everywhere, rewritten
 * references, label merging, and rejection of inconsistent archives.
 */

import { describe, expect, it } from 'vitest';

import type { UtcTimestamp } from '../clock';
import type { RelationshipTypeId, TagId, WorkspaceId } from '../ids';
import type { RelationshipTypeRecord, TagRecord } from '../ports/repositories';
import type { ArchiveData, ArchiveNode } from './archive-format';
import { planImport, type ImportContext } from './import-plan';

const T = '2026-10-27T10:00:00.000Z';
const WORKSPACE = 'f0000000-0000-4000-8000-000000000000' as WorkspaceId;
// Real archives use the source workspace's UUIDs; notes only accept UUID link targets.
const BETA = 'b0000000-0000-4000-8000-00000000000b';
const ELSEWHERE = 'e0000000-0000-4000-8000-00000000000e';

function context(overrides: Partial<ImportContext> = {}): ImportContext {
  let counter = 0;
  return {
    workspaceId: WORKSPACE,
    existingTypes: [],
    existingTags: [],
    // Descending IDs, so the new order of two nodes is the reverse of the archive order.
    ids: {
      newId: () =>
        `00000000-0000-4000-8000-${(0xffffff - ++counter).toString(16).padStart(12, '0')}`,
    },
    importOrigin: 'Physics (exported 2026-10-27)',
    approvedAttachments: new Map(),
    ...overrides,
  };
}

function node(id: string, title: string, content: unknown[] = []): ArchiveNode {
  return {
    id,
    title,
    summary: null,
    note: { type: 'doc', content },
    noteSchemaVersion: 2,
    createdAt: T,
    updatedAt: T,
  };
}

function data(overrides: Partial<ArchiveData> = {}): ArchiveData {
  return {
    nodes: [node('a', 'Alpha'), node('b', 'Beta')],
    tags: [],
    nodeTags: [],
    relationshipTypes: [],
    relationships: [],
    maps: [],
    placements: [],
    connections: [],
    timelineEvents: [],
    attachments: [],
    graphPositions: [],
    ...overrides,
  };
}

const type = (id: string, label: string, directionality: 'directed' | 'undirected') => ({
  id,
  label,
  directionality,
  isArchived: false,
  isBuiltin: false,
  createdAt: T,
  updatedAt: T,
});

const relationship = (id: string, source: string, target: string, typeId: string) => ({
  id,
  sourceNodeId: source,
  targetNodeId: target,
  typeId,
  description: null,
  createdAt: T,
  updatedAt: T,
});

describe('planImport', () => {
  it('gives every record a new ID and rewrites links inside notes', () => {
    const plan = planImport(
      data({
        nodes: [
          node('a', 'Alpha', [
            {
              type: 'paragraph',
              content: [
                { type: 'wikilink', attrs: { targetNodeId: BETA, label: 'Beta' } },
                { type: 'wikilink', attrs: { targetNodeId: ELSEWHERE, label: 'Gone' } },
              ],
            },
          ]),
          node(BETA, 'Beta'),
        ],
      }),
      context(),
    );
    const alpha = plan.nodes.find((item) => item.title === 'Alpha')!;
    const links = (
      JSON.parse(alpha.noteJson) as {
        content: [{ content: { attrs: { targetNodeId: string; label: string } }[] }];
      }
    ).content[0].content;
    expect(links[0]!.attrs).toEqual({ targetNodeId: plan.nodeIdMap.get(BETA), label: 'Beta' });
    // A link outside the archive keeps its label but points at an ID no node has.
    expect(links[1]!.attrs.label).toBe('Gone');
    expect([...plan.nodeIdMap.values()]).not.toContain(links[1]!.attrs.targetNodeId);
    expect(plan.nodes.map((item) => item.id)).not.toContain('a');
    expect(plan.warnings).toEqual([
      '1 note link points to nodes that are not in the archive. They are kept as unresolved links.',
    ]);
  });

  it('stores undirected relationships in canonical order for the new IDs', () => {
    const plan = planImport(
      data({
        relationshipTypes: [type('t', 'related', 'undirected')],
        relationships: [relationship('r', 'a', 'b', 't')],
      }),
      context(),
    );
    const [stored] = plan.relationships;
    expect(stored!.sourceNodeId < stored!.targetNodeId).toBe(true);
    expect(new Set([stored!.sourceNodeId, stored!.targetNodeId])).toEqual(
      new Set([plan.nodeIdMap.get('a'), plan.nodeIdMap.get('b')]),
    );
  });

  it('keeps the direction of directed relationships', () => {
    const plan = planImport(
      data({
        relationshipTypes: [type('t', 'causes', 'directed')],
        relationships: [relationship('r', 'b', 'a', 't')],
      }),
      context(),
    );
    expect(plan.relationships[0]).toMatchObject({
      sourceNodeId: plan.nodeIdMap.get('b'),
      targetNodeId: plan.nodeIdMap.get('a'),
      directionality: 'directed',
    });
  });

  it('reuses matching tags and types, and renames a type whose direction differs', () => {
    const existingType = (label: string, directionality: 'directed' | 'undirected') =>
      ({
        id: `${label}-id` as RelationshipTypeId,
        workspaceId: WORKSPACE,
        label,
        normalizedLabel: label.toLowerCase(),
        directionality,
        isArchived: false,
        isBuiltin: false,
        createdAt: T as UtcTimestamp,
        updatedAt: T as UtcTimestamp,
      }) satisfies RelationshipTypeRecord;
    const existingTag = {
      id: 'tag-id' as TagId,
      workspaceId: WORKSPACE,
      displayLabel: 'Physics',
      normalizedLabel: 'physics',
      createdAt: T as UtcTimestamp,
      updatedAt: T as UtcTimestamp,
    } satisfies TagRecord;
    const plan = planImport(
      data({
        tags: [{ id: 'g', label: 'PHYSICS', createdAt: T, updatedAt: T }],
        nodeTags: [{ nodeId: 'a', tagId: 'g', createdAt: T }],
        relationshipTypes: [type('t1', 'causes', 'directed'), type('t2', 'Explains', 'directed')],
        relationships: [relationship('r1', 'a', 'b', 't1'), relationship('r2', 'a', 'b', 't2')],
      }),
      context({
        existingTags: [existingTag],
        existingTypes: [existingType('causes', 'directed'), existingType('explains', 'undirected')],
      }),
    );
    expect(plan.tags).toEqual([]);
    expect(plan.nodeTags[0]!.tagId).toBe('tag-id');
    expect(plan.relationships[0]!.typeId).toBe('causes-id');
    expect(plan.relationshipTypes).toMatchObject([
      { label: 'Explains (imported)', directionality: 'directed', isBuiltin: false },
    ]);
    expect(plan.summary).toMatchObject({
      reusedTags: 1,
      reusedRelationshipTypes: 1,
      newRelationshipTypes: 1,
    });
  });

  it('orders placements parents first and maps the hierarchy', () => {
    const placement = (id: string, nodeId: string, parent: string | null) => ({
      id,
      mapId: 'm',
      nodeId,
      x: 0,
      y: 0,
      parentPlacementId: parent,
      siblingOrder: 0,
      isCollapsed: false,
      color: 'green',
      createdAt: T,
      updatedAt: T,
    });
    const plan = planImport(
      data({
        maps: [
          {
            id: 'm',
            title: 'Map',
            mode: 'hierarchical',
            viewport: { x: 0, y: 0, zoom: 1 },
            createdAt: T,
            updatedAt: T,
          },
        ],
        // The child comes first in the archive.
        placements: [placement('child', 'b', 'root'), placement('root', 'a', null)],
      }),
      context(),
    );
    expect(plan.placements.map((item) => item.nodeId)).toEqual([
      plan.nodeIdMap.get('a'),
      plan.nodeIdMap.get('b'),
    ]);
    expect(plan.placements[1]!.parentPlacementId).toBe(plan.placements[0]!.id);
    expect(plan.placements[0]!.style).toEqual({ color: 'green' });
  });

  it('marks imported timeline events with their origin', () => {
    const plan = planImport(
      data({
        timelineEvents: [
          {
            id: 'e',
            nodeId: null,
            nodeTitleSnapshot: 'Deleted node',
            eventType: 'node_created',
            occurredAt: T,
            lastActivityAt: T,
            learnedAt: null,
            title: null,
            reflection: null,
            isImported: false,
            importOrigin: null,
          },
        ],
      }),
      context(),
    );
    expect(plan.timelineEvents[0]).toMatchObject({
      nodeId: null,
      nodeTitleSnapshot: 'Deleted node',
      isImported: true,
      importOrigin: 'Physics (exported 2026-10-27)',
    });
  });

  it.each([
    ['a repeated node ID', data({ nodes: [node('a', 'One'), node('a', 'Two')] })],
    [
      'a relationship to a missing node',
      data({
        relationshipTypes: [type('t', 'causes', 'directed')],
        relationships: [relationship('r', 'a', 'missing', 't')],
      }),
    ],
    [
      'a self-relationship',
      data({
        relationshipTypes: [type('t', 'causes', 'directed')],
        relationships: [relationship('r', 'a', 'a', 't')],
      }),
    ],
    [
      'an undirected duplicate in reverse',
      data({
        relationshipTypes: [type('t', 'related', 'undirected')],
        relationships: [relationship('r1', 'a', 'b', 't'), relationship('r2', 'b', 'a', 't')],
      }),
    ],
    [
      'a hierarchy cycle',
      data({
        maps: [
          {
            id: 'm',
            title: 'Map',
            mode: 'hierarchical',
            viewport: { x: 0, y: 0, zoom: 1 },
            createdAt: T,
            updatedAt: T,
          },
        ],
        placements: [
          {
            id: 'p1',
            mapId: 'm',
            nodeId: 'a',
            x: 0,
            y: 0,
            parentPlacementId: 'p2',
            siblingOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: T,
            updatedAt: T,
          },
          {
            id: 'p2',
            mapId: 'm',
            nodeId: 'b',
            x: 0,
            y: 0,
            parentPlacementId: 'p1',
            siblingOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: T,
            updatedAt: T,
          },
        ],
      }),
    ],
    ['an invalid date', data({ nodes: [{ ...node('a', 'Alpha'), createdAt: 'yesterday' }] })],
    ['an empty title', data({ nodes: [node('a', '   ')] })],
    [
      'a title on a non-milestone event',
      data({
        timelineEvents: [
          {
            id: 'e',
            nodeId: 'a',
            nodeTitleSnapshot: 'Alpha',
            eventType: 'reviewed',
            occurredAt: T,
            lastActivityAt: T,
            learnedAt: null,
            title: 'Sneaky',
            reflection: null,
            isImported: false,
            importOrigin: null,
          },
        ],
      }),
    ],
  ])('rejects %s', (_case, archive) => {
    expect(() => planImport(archive, context())).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('rejects notes from a newer note schema with an actionable message', () => {
    expect(() =>
      planImport(data({ nodes: [{ ...node('a', 'Alpha'), noteSchemaVersion: 99 }] }), context()),
    ).toThrow(/newer version of mmap/u);
  });
});
