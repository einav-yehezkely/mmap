/**
 * Proposing and validating a parent assignment when a freeform map switches to hierarchical mode
 * (PRD §5.6).
 *
 * Freeform connectors may form any graph, including cycles; a hierarchy must be a forest. The
 * proposal applies a few simple, explainable rules (no AI, no inference — PRD §1) and leaves
 * everything it cannot decide to the user, who reviews the result before the switch. The previous
 * freeform coordinates are kept by the caller so the user can switch back.
 */

import { DomainError } from '../errors';
import { compareIds } from './hierarchy';

export interface FreeformConnector {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
}

export interface ParentProposal {
  /** Proposed parent for every placement (null = root). */
  readonly parents: ReadonlyMap<string, string | null>;
  /** Placements whose parent could not be decided automatically, with the candidate parents to review. */
  readonly ambiguous: readonly { readonly id: string; readonly candidates: readonly string[] }[];
}

/**
 * Proposes a parent for every placement. A connector `source → target` suggests "source is the
 * parent of target". Placements are processed in ID order so the outcome never depends on the
 * input order:
 * - no incoming connectors → root;
 * - exactly one distinct source → that source becomes the parent, unless this would close a cycle
 *   with the parents already accepted; then the placement is ambiguous (candidate: that source);
 * - two or more distinct sources → ambiguous, candidates = the distinct sources sorted by ID.
 * Ambiguous placements are proposed as roots until the user decides. Self-connectors and
 * connectors that reference unknown placements are ignored; duplicate connectors count once.
 *
 * Accepting the proposal as-is is always cycle-free: only cycle-checked edges are accepted.
 *
 * Cycle check: accepted edges form a forest, and a placement only receives its parent when it is
 * processed, so at that moment it is the root of its own tree. Accepting `source → target` closes
 * a cycle exactly when `source` already lies in `target`'s tree. A union-find over the trees
 * answers that in near-constant time, keeping the whole proposal near-linear for large maps.
 */
export function proposeHierarchy(
  placementIds: readonly string[],
  connectors: readonly FreeformConnector[],
): ParentProposal {
  const ids = [...new Set(placementIds)].sort(compareIds);
  const sources = incomingSources(ids, connectors);
  const trees = new UnionFind();
  const parents = new Map<string, string | null>();
  const ambiguous: { id: string; candidates: string[] }[] = [];

  for (const id of ids) {
    const candidates = [...(sources.get(id) ?? [])].sort(compareIds);
    const [only] = candidates;

    if (only !== undefined && candidates.length === 1 && trees.find(only) !== trees.find(id)) {
      parents.set(id, only);
      trees.union(id, only);
    } else {
      parents.set(id, null);
      if (candidates.length > 0) ambiguous.push({ id, candidates });
    }
  }
  return { parents, ambiguous };
}

/** Distinct, known, non-self sources of incoming connectors for each placement. */
function incomingSources(
  ids: readonly string[],
  connectors: readonly FreeformConnector[],
): Map<string, Set<string>> {
  const known = new Set(ids);
  const sources = new Map<string, Set<string>>();
  for (const { sourceId, targetId } of connectors) {
    if (sourceId === targetId || !known.has(sourceId) || !known.has(targetId)) continue;
    const set = sources.get(targetId);
    if (set === undefined) sources.set(targetId, new Set([sourceId]));
    else set.add(sourceId);
  }
  return sources;
}

/** Minimal disjoint-set forest with path halving (iterative, no recursion). */
class UnionFind {
  private readonly parent = new Map<string, string>();

  public find(id: string): string {
    let current = id;
    let next = this.parent.get(current);
    while (next !== undefined && next !== current) {
      const grandparent = this.parent.get(next) ?? next;
      this.parent.set(current, grandparent);
      current = grandparent;
      next = this.parent.get(current);
    }
    return current;
  }

  public union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

/**
 * Validates a user-reviewed parent assignment before switching to hierarchical mode:
 * - placement IDs are unique;
 * - every placement has an entry, and there are no entries for unknown placements;
 * - every non-null parent is one of the placements;
 * - the assignment has no cycles (an item cannot be its own parent or ancestor).
 *
 * @throws DomainError `VALIDATION_FAILED` for missing, unknown or duplicate entries.
 * @throws DomainError `INVARIANT_VIOLATION` when the assignment contains a cycle.
 */
export function validateHierarchyAssignment(
  placementIds: readonly string[],
  parents: ReadonlyMap<string, string | null>,
): void {
  const known = new Set(placementIds);
  if (known.size !== placementIds.length) {
    throw new DomainError('VALIDATION_FAILED', 'Placement IDs must be unique.');
  }
  for (const id of placementIds) {
    if (!parents.has(id)) {
      throw new DomainError('VALIDATION_FAILED', 'Every placement needs a parent decision.');
    }
  }
  for (const [id, parentId] of parents) {
    if (!known.has(id) || (parentId !== null && !known.has(parentId))) {
      throw new DomainError('VALIDATION_FAILED', 'The assignment refers to an unknown placement.');
    }
  }
  assertAcyclic(placementIds, parents);
}

/**
 * Walks up from each placement until reaching a root or a placement already known to be safe;
 * meeting a placement on the current path is a cycle. Each placement is walked once: O(n).
 */
function assertAcyclic(
  placementIds: readonly string[],
  parents: ReadonlyMap<string, string | null>,
): void {
  const safe = new Set<string>();
  for (const start of placementIds) {
    const path = new Set<string>();
    let current: string | null = start;
    while (current !== null && !safe.has(current)) {
      if (path.has(current)) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'This would put an item inside its own branch.',
        );
      }
      path.add(current);
      current = parents.get(current) ?? null;
    }
    for (const id of path) safe.add(id);
  }
}
