/**
 * Rules for semantic relationships between knowledge nodes (PRD §4.2).
 *
 * Invariants:
 * - A relationship connects two distinct nodes (no self-links).
 * - Directed relationships keep the user's source → target order; the reverse direction is a
 *   different relationship and is allowed.
 * - Undirected relationships are stored with canonical endpoint ordering (`source < target`,
 *   compared as canonical lowercase UUID text). Storing A–B and B–A identically is what makes
 *   "reversed duplicates" detectable by a plain uniqueness constraint.
 *
 * The SQLite schema repeats these rules as CHECK/UNIQUE constraints as a second line of defense;
 * this module is the primary rule that services apply before writing.
 */

import { DomainError } from '../errors';
import type { NodeId } from '../ids';

export const RELATIONSHIP_DIRECTIONALITIES = ['directed', 'undirected'] as const;
export type RelationshipDirectionality = (typeof RELATIONSHIP_DIRECTIONALITIES)[number];

export interface RelationshipEndpoints {
  readonly sourceNodeId: NodeId;
  readonly targetNodeId: NodeId;
}

/**
 * Validates a pair of endpoints and returns them in storage order.
 *
 * @throws DomainError `INVARIANT_VIOLATION` when both endpoints are the same node.
 */
export function toStoredEndpoints(
  endpoints: RelationshipEndpoints,
  directionality: RelationshipDirectionality,
): RelationshipEndpoints {
  const { sourceNodeId, targetNodeId } = endpoints;

  if (sourceNodeId === targetNodeId) {
    throw new DomainError('INVARIANT_VIOLATION', 'A relationship must connect two distinct nodes.');
  }

  if (directionality === 'directed') {
    return { sourceNodeId, targetNodeId };
  }

  // Plain `<` on strings compares UTF-16 code units. For canonical lowercase UUIDs (ASCII only)
  // this matches SQLite's default BINARY collation, so the domain and the database agree.
  return sourceNodeId < targetNodeId
    ? { sourceNodeId, targetNodeId }
    : { sourceNodeId: targetNodeId, targetNodeId: sourceNodeId };
}
