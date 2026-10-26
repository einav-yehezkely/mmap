import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';
import type { NodeId } from '../ids';
import { toStoredEndpoints } from './relationship-rules';

const nodeA = '00000000-0000-4000-8000-00000000000a' as NodeId;
const nodeB = '00000000-0000-4000-8000-00000000000b' as NodeId;

describe('toStoredEndpoints', () => {
  it('keeps the user-selected direction for directed relationships', () => {
    expect(toStoredEndpoints({ sourceNodeId: nodeB, targetNodeId: nodeA }, 'directed')).toEqual({
      sourceNodeId: nodeB,
      targetNodeId: nodeA,
    });
  });

  it('stores undirected relationships in canonical order regardless of input order', () => {
    const forward = toStoredEndpoints({ sourceNodeId: nodeA, targetNodeId: nodeB }, 'undirected');
    const reversed = toStoredEndpoints({ sourceNodeId: nodeB, targetNodeId: nodeA }, 'undirected');

    // Both orders collapse to the same stored pair, so a reversed duplicate is detectable.
    expect(reversed).toEqual(forward);
    expect(forward).toEqual({ sourceNodeId: nodeA, targetNodeId: nodeB });
  });

  it.each(['directed', 'undirected'] as const)('rejects self-links (%s)', (directionality) => {
    const attempt = () =>
      toStoredEndpoints({ sourceNodeId: nodeA, targetNodeId: nodeA }, directionality);

    expect(attempt).toThrow(DomainError);
    expect(attempt).toThrow(expect.objectContaining({ code: 'INVARIANT_VIOLATION' }));
  });
});
