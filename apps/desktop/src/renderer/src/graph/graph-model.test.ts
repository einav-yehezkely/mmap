/**
 * Knowledge graph view model (PRD §5.7, §13 criteria 9 and 14, graph redesign acceptance
 * scenarios): completeness statements, neighborhood merging, map membership (one canonical node,
 * several maps, no map), emphasis for selection and map highlighting, Focus mode, elements and the
 * accessible list.
 */

import type { GraphSliceDto } from '@mmap/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildGraphList,
  computeEmphasis,
  describeCompleteness,
  findNodes,
  focusNodeIds,
  isPartial,
  mapColors,
  mergeNeighborhood,
  stateFromOverview,
  toCytoscapeElements,
} from './graph-model';

const id = (letter: string) => `00000000-0000-4000-8000-${letter.repeat(12)}`;
const TYPE = '00000000-0000-4000-8000-ffffffffffff';
const NETWORKING = '10000000-0000-4000-8000-000000000001';
const SECURITY = '10000000-0000-4000-8000-000000000002';
const LONG_TITLE =
  'A very long node title that goes on and on to check that the full text is kept for hover';

/**
 * Alpha (on Networking and Security) ─depends on→ Beta (Networking); Alpha ─related to─ Gamma
 * (no map). Beta and Gamma are in different maps / no map, and their connection to Alpha crosses
 * maps.
 */
function slice(overrides: Partial<GraphSliceDto> = {}): GraphSliceDto {
  return {
    nodes: [
      { id: id('a'), title: 'Alpha', degree: 2, mapIds: [NETWORKING, SECURITY] },
      { id: id('b'), title: 'Beta', degree: 1, mapIds: [NETWORKING] },
      { id: id('c'), title: 'Gamma', degree: 1, mapIds: [] },
    ],
    edges: [
      {
        id: id('1'),
        sourceNodeId: id('a'),
        targetNodeId: id('b'),
        typeId: TYPE,
        typeLabel: 'depends on',
        directionality: 'directed',
      },
      {
        id: id('2'),
        sourceNodeId: id('a'),
        targetNodeId: id('c'),
        typeId: TYPE,
        typeLabel: 'related to',
        directionality: 'undirected',
      },
    ],
    maps: [
      { id: NETWORKING, title: 'Networking', nodeCount: 2 },
      { id: SECURITY, title: 'Security', nodeCount: 1 },
    ],
    references: [],
    totalNodes: 3,
    edgesTruncated: false,
    referencesTruncated: false,
    connectors: [],
    connectorsTruncated: false,
    ...overrides,
  };
}

const NO_POSITIONS = new Map<string, { x: number; y: number }>();

describe('completeness', () => {
  it('says when everything is shown', () => {
    const state = stateFromOverview(slice());
    expect(isPartial(state)).toBe(false);
    expect(describeCompleteness(state)).toEqual(['Showing all 3 matching nodes.']);
  });

  it('never presents a bounded view as complete', () => {
    const state = stateFromOverview(slice({ totalNodes: 10_000, edgesTruncated: true }));
    expect(isPartial(state)).toBe(true);
    const lines = describeCompleteness(state);
    expect(lines[0]).toMatch(/^Partial view: showing 3 of 10,000 matching nodes/u);
    expect(lines[1]).toMatch(/relationships .* not drawn/u);
  });

  it('describes an empty graph', () => {
    const empty = stateFromOverview(slice({ nodes: [], edges: [], totalNodes: 0 }));
    expect(describeCompleteness(empty)).toEqual(['No nodes match the current filters.']);
    expect(toCytoscapeElements(empty, NO_POSITIONS, { showMaps: true })).toEqual([]);
    expect(buildGraphList(empty)).toEqual([]);
  });
});

describe('map membership', () => {
  it('draws one canonical node per node, with every membership, and no membership edges', () => {
    const elements = toCytoscapeElements(stateFromOverview(slice()), NO_POSITIONS, {
      showMaps: true,
    });
    const nodes = elements.filter((element) => element.group === 'nodes');
    const edges = elements.filter((element) => element.group === 'edges');

    expect(nodes.filter((node) => node.data.id === id('a'))).toHaveLength(1);
    // Only the two real relationships: sharing "Networking" does not connect Alpha and Beta twice.
    expect(edges).toHaveLength(2);
    const alpha = nodes.find((node) => node.data.id === id('a'))!;
    expect(alpha.data).toMatchObject({ mapsText: 'Networking, Security', mapCount: 2 });
    expect(alpha.classes).toContain('in-maps');
    expect(alpha.data.pie1Size).toBe(50);
    expect(alpha.data.pie2Size).toBe(50);
    const gamma = nodes.find((node) => node.data.id === id('c'))!;
    expect(gamma.classes).not.toContain('in-maps');
    expect(gamma.data.mapsText).toBe('');
  });

  it('shows badges only when asked, but always names maps for the tooltip', () => {
    const nodes = toCytoscapeElements(stateFromOverview(slice()), NO_POSITIONS, {
      showMaps: false,
    }).filter((element) => element.group === 'nodes');
    expect(nodes.every((node) => !node.classes?.includes('in-maps'))).toBe(true);
    expect(nodes[0]?.data.mapsText).toBe('Networking, Security');
  });

  it('summarizes more than six memberships as one extra slice', () => {
    const maps = Array.from({ length: 8 }, (_, index) => ({
      id: `20000000-0000-4000-8000-00000000000${index}`,
      title: `Map ${index}`,
      nodeCount: 1,
    }));
    const many = stateFromOverview(
      slice({
        nodes: [{ id: id('a'), title: 'Alpha', degree: 0, mapIds: maps.map((map) => map.id) }],
        edges: [],
        maps,
        totalNodes: 1,
      }),
    );
    const [node] = toCytoscapeElements(many, NO_POSITIONS, { showMaps: true });
    const sizes = [1, 2, 3, 4, 5, 6, 7].map((index) => Number(node?.data[`pie${index}Size`]));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(100);
    expect(sizes.every((size) => size > 0)).toBe(true);
  });

  it('gives each map a stable color and lists memberships in the list view', () => {
    const state = stateFromOverview(slice());
    expect(mapColors(state.maps).get(NETWORKING)).not.toBe(mapColors(state.maps).get(SECURITY));
    expect(buildGraphList(state).map((item) => [item.title, item.maps])).toEqual([
      ['Alpha', ['Networking', 'Security']],
      ['Beta', ['Networking']],
      ['Gamma', []],
    ]);
  });
});

describe('emphasis and focus', () => {
  it('emphasizes a selected node with its immediate neighbors and connecting edges', () => {
    const state = stateFromOverview(slice());
    const emphasis = computeEmphasis(state, id('b'), null);
    expect([...(emphasis.nodes ?? [])].sort()).toEqual([id('a'), id('b')]);
    expect([...(emphasis.edges ?? [])]).toEqual([`relationship:${id('1')}`]);
  });

  it('emphasizes a highlighted map’s members when nothing is selected', () => {
    const state = stateFromOverview(slice());
    const emphasis = computeEmphasis(state, null, NETWORKING);
    expect([...(emphasis.nodes ?? [])].sort()).toEqual([id('a'), id('b')]);
    expect(computeEmphasis(state, null, null)).toEqual({ nodes: null, edges: null });
  });

  it('focuses on a node and its connections, growing only by explicit expansion', () => {
    const state = stateFromOverview(slice());
    expect([...focusNodeIds(state, id('b'), [])].sort()).toEqual([id('a'), id('b')]);
    expect([...focusNodeIds(state, id('b'), [id('a')])].sort()).toEqual([
      id('a'),
      id('b'),
      id('c'),
    ]);
  });
});

describe('elements', () => {
  it('keeps given positions, the full title for hover and the direction classes', () => {
    const state = stateFromOverview(
      slice({
        nodes: [{ id: id('a'), title: LONG_TITLE, degree: 0, mapIds: [] }],
        edges: [],
        totalNodes: 1,
      }),
    );
    const [node] = toCytoscapeElements(state, new Map([[id('a'), { x: 12, y: 34 }]]), {
      showMaps: false,
    });
    expect(node).toMatchObject({ position: { x: 12, y: 34 }, data: { label: LONG_TITLE } });

    const edges = toCytoscapeElements(stateFromOverview(slice()), NO_POSITIONS, {
      showMaps: false,
    }).filter((element) => element.group === 'edges');
    expect(edges.map((edge) => [edge.classes, edge.data.label])).toEqual([
      ['directed', 'depends on'],
      ['undirected', 'related to'],
    ]);
  });

  it('keeps note links a separate dashed layer', () => {
    const state = stateFromOverview(
      slice({ references: [{ sourceNodeId: id('b'), targetNodeId: id('c'), occurrences: 2 }] }),
    );
    const reference = toCytoscapeElements(state, NO_POSITIONS, { showMaps: false }).find(
      (element) => element.classes === 'reference',
    );
    expect(reference?.data).toMatchObject({
      source: id('b'),
      target: id('c'),
      label: '2 note links',
    });
  });
});

describe('neighborhoods, find and list', () => {
  it('adds an expansion without duplicating nodes and reports partial expansions', () => {
    const expanded = mergeNeighborhood(
      stateFromOverview(slice()),
      id('c'),
      slice({
        nodes: [
          { id: id('c'), title: 'Gamma', degree: 1, mapIds: [] },
          { id: id('d'), title: 'Delta', degree: 1, mapIds: [SECURITY] },
        ],
        edges: [],
        totalNodes: 5,
      }),
    );
    expect(expanded.nodes.size).toBe(4);
    expect(describeCompleteness(expanded)).toContain('Neighbors of “Gamma”: showing 1 of 5.');
  });

  it('finds loaded nodes by title, case-insensitively', () => {
    const state = stateFromOverview(slice());
    expect(findNodes(state, 'ET', 8).map((node) => node.title)).toEqual(['Beta']);
    expect(findNodes(state, '  ', 8)).toEqual([]);
  });

  it('writes every connection out in words with direction', () => {
    const state = stateFromOverview(
      slice({ references: [{ sourceNodeId: id('b'), targetNodeId: id('c'), occurrences: 1 }] }),
    );
    expect(buildGraphList(state).map((item) => [item.title, item.connections])).toEqual([
      ['Alpha', ['depends on → Beta', 'related to — Gamma']],
      ['Beta', ['← depends on Alpha', 'note links to Gamma']],
      ['Gamma', ['linked from the note of Beta', 'related to — Alpha']],
    ]);
  });
});

describe('map connectors in the graph', () => {
  it('draws them as their own dotted layer and names their maps in the List', () => {
    const state = stateFromOverview(
      slice({
        connectors: [
          { sourceNodeId: id('b'), targetNodeId: id('c'), mapIds: [NETWORKING] },
          { sourceNodeId: id('c'), targetNodeId: id('a'), mapIds: [NETWORKING, SECURITY] },
        ],
      }),
    );

    const connectors = toCytoscapeElements(state, NO_POSITIONS, { showMaps: false }).filter(
      (element) => element.classes === 'connector',
    );
    expect(connectors.map((element) => element.data)).toEqual([
      {
        id: `connector:${id('b')}>${id('c')}`,
        source: id('b'),
        target: id('c'),
        label: 'on Networking',
      },
      {
        id: `connector:${id('c')}>${id('a')}`,
        source: id('c'),
        target: id('a'),
        label: 'on 2 maps',
      },
    ]);
    const gamma = buildGraphList(state).find((item) => item.title === 'Gamma');
    expect(gamma?.connections).toEqual(
      expect.arrayContaining([
        'map connector from Beta (on Networking)',
        'map connector to Alpha (on 2 maps)',
      ]),
    );
  });

  it('reports a cut-off connector layer as partial', () => {
    const state = stateFromOverview(slice({ connectorsTruncated: true }));
    expect(isPartial(state)).toBe(true);
    expect(describeCompleteness(state)).toContain(
      'Some map connectors between the shown nodes are not drawn (limit reached).',
    );
  });
});
