/**
 * Map regions and collapsing (graph redesign section 5): overlapping membership is never turned
 * into an exclusive hierarchy, shared nodes stay canonical and visible, connections to collapsed
 * maps are aggregated.
 */

import type { GraphSliceDto } from '@mmap/contracts';
import { describe, expect, it } from 'vitest';

import { stateFromOverview } from './graph-model';
import { collapseMaps, convexHull, regionSpecs, summaryId, summaryPosition } from './graph-regions';

const id = (letter: string) => `00000000-0000-4000-8000-${letter.repeat(12)}`;
const NET = '10000000-0000-4000-8000-000000000001';
const SEC = '10000000-0000-4000-8000-000000000002';
const TYPE = '00000000-0000-4000-8000-ffffffffffff';

/**
 * HTTP (Networking + Security), TCP (Networking), TLS (Security), Orphan (no map).
 * TCP → HTTP, TLS → TCP, Orphan → TLS.
 */
function state() {
  const edge = (key: string, source: string, target: string) => ({
    id: id(key),
    sourceNodeId: id(source),
    targetNodeId: id(target),
    typeId: TYPE,
    typeLabel: 'depends on',
    directionality: 'directed' as const,
  });
  const slice: GraphSliceDto = {
    nodes: [
      { id: id('h'), title: 'HTTP', degree: 1, mapIds: [NET, SEC] },
      { id: id('t'), title: 'TCP', degree: 2, mapIds: [NET] },
      { id: id('s'), title: 'TLS', degree: 2, mapIds: [SEC] },
      { id: id('o'), title: 'Orphan', degree: 1, mapIds: [] },
    ],
    edges: [edge('1', 't', 'h'), edge('2', 's', 't'), edge('3', 'o', 's')],
    references: [],
    maps: [
      { id: NET, title: 'Networking', nodeCount: 2 },
      { id: SEC, title: 'Security', nodeCount: 2 },
    ],
    totalNodes: 4,
    edgesTruncated: false,
    referencesTruncated: false,
  };
  return stateFromOverview(slice);
}

describe('collapseMaps', () => {
  it('changes nothing when no map is collapsed', () => {
    expect(collapseMaps(state(), new Set())).toEqual({
      hidden: new Set(),
      summaries: [],
      connections: [],
    });
  });

  it('keeps a shared node visible when one of its maps is still expanded', () => {
    const result = collapseMaps(state(), new Set([SEC]));
    // TLS is only on Security: hidden. HTTP is also on Networking: stays one visible node.
    expect([...result.hidden]).toEqual([id('s')]);
    expect(result.summaries).toEqual([
      {
        mapId: SEC,
        title: 'Security',
        memberCount: 2,
        memberIds: [id('h'), id('s')],
        hiddenIds: [id('s')],
      },
    ]);
  });

  it('aggregates connections to collapsed maps, keeping nodes on no map visible', () => {
    const result = collapseMaps(state(), new Set([SEC]));
    // TLS → TCP and Orphan → TLS now connect TCP and Orphan to the Security summary.
    const asText = (source: string, target: string, count: number) =>
      `${[source, target].sort().join(' ~ ')} x${count}`;
    expect(result.connections.map((c) => asText(c.source, c.target, c.count)).sort()).toEqual(
      [asText(summaryId(SEC), id('t'), 1), asText(summaryId(SEC), id('o'), 1)].sort(),
    );
    expect(result.hidden.has(id('o'))).toBe(false);
  });

  it('hides a node shared only by collapsed maps once, inside each of their summaries', () => {
    const result = collapseMaps(state(), new Set([NET, SEC]));
    expect([...result.hidden].sort()).toEqual([id('h'), id('s'), id('t')].sort());
    const net = result.summaries.find((summary) => summary.mapId === NET);
    const sec = result.summaries.find((summary) => summary.mapId === SEC);
    expect(net?.hiddenIds).toContain(id('h'));
    expect(sec?.hiddenIds).toContain(id('h'));
    // Connections between the two collapsed maps are aggregated with counts; nothing links a
    // summary to itself.
    const between = result.connections.find(
      (c) => [c.source, c.target].sort().join() === [summaryId(NET), summaryId(SEC)].sort().join(),
    );
    expect(between?.count).toBeGreaterThanOrEqual(1);
    expect(result.connections.every((c) => c.source !== c.target)).toBe(true);
  });

  it('places a summary at the center of its hidden members', () => {
    const summary = {
      mapId: SEC,
      title: 'Security',
      memberCount: 3,
      memberIds: ['a', 'b', 'c'],
      hiddenIds: ['a', 'b'],
    };
    const positions = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 10, y: 20 }],
      ['c', { x: 100, y: 100 }],
    ]);
    expect(summaryPosition(summary, positions)).toEqual({ x: 5, y: 10 });
    // Nothing hidden (all members shared with expanded maps): placed among all members.
    expect(summaryPosition({ ...summary, hiddenIds: [] }, positions)).toEqual({
      x: 110 / 3,
      y: 40,
    });
  });
});

describe('convexHull', () => {
  it('returns single points and pairs as they are', () => {
    expect(convexHull([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
    expect(convexHull([])).toEqual([]);
  });

  it('drops interior points', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual({ x: 5, y: 5 });
  });
});

describe('regionSpecs', () => {
  it('draws overlapping regions for expanded maps, skipping hidden members and collapsed maps', () => {
    const graph = state();
    const colors = new Map([
      [NET, '#111111'],
      [SEC, '#222222'],
    ]);
    const all = regionSpecs(graph, colors, new Set(), new Set(), [], 10);
    expect(all.regions.map((region) => [region.title, region.memberIds.length])).toEqual([
      ['Networking', 2],
      ['Security', 2],
    ]);
    // HTTP is inside both regions.
    expect(all.regions.every((region) => region.memberIds.includes(id('h')))).toBe(true);

    const collapsed = collapseMaps(graph, new Set([SEC]));
    const some = regionSpecs(graph, colors, new Set([SEC]), collapsed.hidden, [], 10);
    expect(some.regions.map((region) => region.title)).toEqual(['Networking']);

    const limited = regionSpecs(graph, colors, new Set(), new Set(), [], 1);
    expect(limited).toMatchObject({ omitted: 1 });
    expect(regionSpecs(graph, colors, new Set(), new Set(), [SEC], 10).regions).toHaveLength(1);
  });
});
