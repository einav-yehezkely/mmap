import { describe, expect, it } from 'vitest';

import type { FreeformConnector, ParentProposal } from './hierarchy-proposal';
import { proposeHierarchy, validateHierarchyAssignment } from './hierarchy-proposal';

let nextConnectorId = 0;
function connector(sourceId: string, targetId: string): FreeformConnector {
  nextConnectorId += 1;
  return { id: `c${nextConnectorId}`, sourceId, targetId };
}

/** Plain-object view of a proposal, independent of map insertion order. */
function snapshot(proposal: ParentProposal): {
  parents: [string, string | null][];
  ambiguous: ParentProposal['ambiguous'];
} {
  return { parents: [...proposal.parents].sort(), ambiguous: proposal.ambiguous };
}

describe('proposeHierarchy', () => {
  it('makes every placement a root when there are no connectors', () => {
    const proposal = proposeHierarchy(['b', 'a'], []);

    expect(snapshot(proposal)).toEqual({
      parents: [
        ['a', null],
        ['b', null],
      ],
      ambiguous: [],
    });
  });

  it('follows a chain of connectors', () => {
    const proposal = proposeHierarchy(['a', 'b', 'c'], [connector('a', 'b'), connector('b', 'c')]);

    expect(proposal.parents).toEqual(
      new Map([
        ['a', null],
        ['b', 'a'],
        ['c', 'b'],
      ]),
    );
    expect(proposal.ambiguous).toEqual([]);
  });

  it('marks a placement with several sources as ambiguous with sorted candidates', () => {
    const proposal = proposeHierarchy(
      ['top', 'left', 'right', 'bottom'],
      [
        connector('top', 'left'),
        connector('top', 'right'),
        connector('right', 'bottom'),
        connector('left', 'bottom'),
        connector('left', 'bottom'),
      ],
    );

    expect(proposal.parents.get('bottom')).toBeNull();
    expect(proposal.parents.get('left')).toBe('top');
    expect(proposal.ambiguous).toEqual([{ id: 'bottom', candidates: ['left', 'right'] }]);
  });

  it('breaks a connector cycle by leaving one placement ambiguous', () => {
    const placements = ['a', 'b', 'c'];
    const proposal = proposeHierarchy(placements, [
      connector('a', 'b'),
      connector('b', 'c'),
      connector('c', 'a'),
    ]);

    // Processing by id: a ← c, b ← a accepted; c ← b would close the cycle.
    expect(proposal.parents).toEqual(
      new Map([
        ['a', 'c'],
        ['b', 'a'],
        ['c', null],
      ]),
    );
    expect(proposal.ambiguous).toEqual([{ id: 'c', candidates: ['b'] }]);
    expect(() => validateHierarchyAssignment(placements, proposal.parents)).not.toThrow();
  });

  it('ignores self-connectors and connectors to unknown placements', () => {
    const proposal = proposeHierarchy(
      ['a', 'b'],
      [connector('a', 'a'), connector('ghost', 'b'), connector('a', 'ghost'), connector('a', 'b')],
    );

    expect(proposal.parents).toEqual(
      new Map([
        ['a', null],
        ['b', 'a'],
      ]),
    );
    expect(proposal.ambiguous).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const placements = ['e', 'a', 'd', 'b', 'c'];
    const connectors = [
      connector('a', 'b'),
      connector('b', 'c'),
      connector('c', 'a'),
      connector('d', 'e'),
      connector('a', 'e'),
      connector('e', 'd'),
    ];

    const forward = proposeHierarchy(placements, connectors);
    const reversed = proposeHierarchy([...placements].reverse(), [...connectors].reverse());

    expect(snapshot(reversed)).toEqual(snapshot(forward));
    expect(() => validateHierarchyAssignment(placements, forward.parents)).not.toThrow();
  });

  it('stays acyclic and fast on a large reversed chain plus back edges', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `n${String(i).padStart(5, '0')}`);
    const connectors = ids.slice(1).map((id, i) => connector(id, ids[i] as string));
    connectors.push(connector(ids[0] as string, ids[ids.length - 1] as string));

    const proposal = proposeHierarchy(ids, connectors);

    expect(proposal.ambiguous).toHaveLength(1);
    expect(() => validateHierarchyAssignment(ids, proposal.parents)).not.toThrow();
  });
});

describe('validateHierarchyAssignment', () => {
  const placements = ['a', 'b', 'c'];

  it('accepts a valid forest', () => {
    const parents = new Map([
      ['a', null],
      ['b', 'a'],
      ['c', null],
    ]);

    expect(() => validateHierarchyAssignment(placements, parents)).not.toThrow();
  });

  it('rejects a missing entry', () => {
    const parents = new Map([
      ['a', null],
      ['b', 'a'],
    ]);

    expect(() => validateHierarchyAssignment(placements, parents)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('rejects an unknown parent or an entry for an unknown placement', () => {
    const unknownParent = new Map([
      ['a', null],
      ['b', 'ghost'],
      ['c', null],
    ]);
    const unknownPlacement = new Map([
      ['a', null],
      ['b', null],
      ['c', null],
      ['ghost', null],
    ]);

    for (const parents of [unknownParent, unknownPlacement]) {
      expect(() => validateHierarchyAssignment(placements, parents)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
  });

  it('rejects cycles, including self-parents', () => {
    const cycle = new Map([
      ['a', 'c'],
      ['b', 'a'],
      ['c', 'b'],
    ]);
    const selfParent = new Map([
      ['a', 'a'],
      ['b', null],
      ['c', null],
    ]);

    for (const parents of [cycle, selfParent]) {
      expect(() => validateHierarchyAssignment(placements, parents)).toThrow(
        expect.objectContaining({ code: 'INVARIANT_VIOLATION' }),
      );
    }
  });
});
