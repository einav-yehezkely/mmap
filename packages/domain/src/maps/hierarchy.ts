/**
 * Hierarchy rules for mind-map placements (PRD §4.4, §5.6).
 *
 * A hierarchical map is a forest: it may have several roots, and every non-root placement has
 * exactly one parent. Hierarchy is purely organizational: it never creates semantic `part of`
 * relationships between the underlying knowledge nodes.
 *
 * Invariants enforced here:
 * - No hierarchy cycles: an item can never become a descendant of itself.
 * - Siblings have a stable display order: `siblingOrder` ascending, ties broken by `id`
 *   (plain code-unit string comparison, so the order never depends on locale or input order).
 *
 * All algorithms are iterative (no recursion), so a 10,000-item chain cannot overflow the stack,
 * and every walk keeps a visited set, so corrupt input that already contains a cycle still
 * terminates instead of looping forever.
 */

import { DomainError } from '../errors';

export interface HierarchyItem {
  /** Placement ID. */
  readonly id: string;
  /** Parent placement ID, or `null` for a root. */
  readonly parentId: string | null;
  /** Integer position among siblings; ties are broken by `id`. */
  readonly siblingOrder: number;
}

/** One entry of a move plan: the new parent and sibling order for a single item. */
export interface HierarchyChange {
  readonly id: string;
  readonly parentId: string | null;
  readonly siblingOrder: number;
}

const CYCLE_MESSAGE = 'This would put an item inside its own branch.';

/** Compares plain strings by UTF-16 code units (locale-independent and deterministic). */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Display order of siblings: `siblingOrder` ascending, then `id`. */
export function compareSiblings(a: HierarchyItem, b: HierarchyItem): number {
  return a.siblingOrder - b.siblingOrder || compareIds(a.id, b.id);
}

function indexById<T extends HierarchyItem>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * True when making `newParentId` the parent of `itemId` would create a cycle, i.e. when
 * `newParentId` is `itemId` itself or one of its descendants. Moving to the root level
 * (`newParentId === null`) never creates a cycle.
 *
 * Algorithm: walk up the ancestor chain of `newParentId`; reaching `itemId` means a cycle. A
 * visited set stops the walk if the input already contains a (corrupt) cycle that does not pass
 * through `itemId`; such a move does not close a new cycle through `itemId`, so it returns false.
 *
 * @throws DomainError `VALIDATION_FAILED` when `newParentId` is not one of `items`.
 */
export function wouldCreateCycle(
  items: readonly HierarchyItem[],
  itemId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;

  const byId = indexById(items);
  if (!byId.has(newParentId)) {
    throw new DomainError('VALIDATION_FAILED', 'The new parent is not part of this map.');
  }

  const visited = new Set<string>();
  let current: string | null = newParentId;
  while (current !== null && !visited.has(current)) {
    if (current === itemId) return true;
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * Rejects a parent assignment that would create a hierarchy cycle.
 *
 * @throws DomainError `INVARIANT_VIOLATION` when {@link wouldCreateCycle} is true.
 * @throws DomainError `VALIDATION_FAILED` when `newParentId` is not one of `items`.
 */
export function assertNoCycle(
  items: readonly HierarchyItem[],
  itemId: string,
  newParentId: string | null,
): void {
  if (wouldCreateCycle(items, itemId, newParentId)) {
    throw new DomainError('INVARIANT_VIOLATION', CYCLE_MESSAGE);
  }
}

/**
 * Children of `parentId` (`null` = the roots) in display order. Only items whose `parentId` is
 * exactly `parentId` are returned; orphans pointing at a missing parent are not roots here.
 */
export function orderedChildren(
  items: readonly HierarchyItem[],
  parentId: string | null,
): HierarchyItem[] {
  return items.filter((item) => item.parentId === parentId).sort(compareSiblings);
}

/** Clamps a 0-based insertion index into `[0, length]`; ±Infinity clamp to the ends. */
function clampIndex(index: number, length: number): number {
  if (Number.isNaN(index)) {
    throw new DomainError('VALIDATION_FAILED', 'The target position must be a number.');
  }
  return Math.min(Math.max(Math.floor(index), 0), length);
}

/**
 * Plans moving `itemId` so that it ends up at position `index` (0-based, in the final order,
 * clamped to the valid range) among the children of `newParentId` (`null` = root level).
 *
 * The affected sibling groups (the old group and the new group, or one group when the parent does
 * not change) are renumbered densely as 0..n-1 in display order. Only items whose `parentId` or
 * `siblingOrder` actually changes are returned, new group first, each group in display order.
 *
 * A true no-op (same parent, same display position) returns `[]` without renumbering, even when
 * the existing sibling orders are sparse: nothing the user can see changes.
 *
 * @throws DomainError `VALIDATION_FAILED` when `itemId` or `newParentId` is unknown, or `index`
 *   is NaN.
 * @throws DomainError `INVARIANT_VIOLATION` when the move would create a cycle.
 */
export function planMove(
  items: readonly HierarchyItem[],
  itemId: string,
  newParentId: string | null,
  index: number,
): HierarchyChange[] {
  const item = items.find((candidate) => candidate.id === itemId);
  if (item === undefined) {
    throw new DomainError('VALIDATION_FAILED', 'The item to move is not part of this map.');
  }
  assertNoCycle(items, itemId, newParentId);

  const newGroup = orderedChildren(items, newParentId).filter((child) => child.id !== itemId);
  const targetIndex = clampIndex(index, newGroup.length);
  const sameParent = item.parentId === newParentId;

  if (sameParent) {
    const currentIndex = orderedChildren(items, newParentId).findIndex((c) => c.id === itemId);
    if (currentIndex === targetIndex) return [];
  }

  newGroup.splice(targetIndex, 0, item);
  const changes = renumber(newGroup, newParentId);

  if (!sameParent) {
    const oldGroup = orderedChildren(items, item.parentId).filter((c) => c.id !== itemId);
    changes.push(...renumber(oldGroup, item.parentId));
  }
  return changes;
}

/** Assigns dense orders 0..n-1 under `parentId` and returns only the entries that change. */
function renumber(group: readonly HierarchyItem[], parentId: string | null): HierarchyChange[] {
  const changes: HierarchyChange[] = [];
  group.forEach((child, siblingOrder) => {
    if (child.parentId !== parentId || child.siblingOrder !== siblingOrder) {
      changes.push({ id: child.id, parentId, siblingOrder });
    }
  });
  return changes;
}

/**
 * Builds a parent → ordered children index in one pass (O(n log n)), used for whole-tree walks
 * instead of repeated {@link orderedChildren} scans.
 */
export function childrenIndex<T extends HierarchyItem>(
  items: readonly T[],
): Map<string | null, T[]> {
  const index = new Map<string | null, T[]>();
  for (const item of items) {
    const siblings = index.get(item.parentId);
    if (siblings === undefined) index.set(item.parentId, [item]);
    else siblings.push(item);
  }
  for (const siblings of index.values()) siblings.sort(compareSiblings);
  return index;
}

/**
 * IDs of all descendants of `itemId` (excluding the item itself), depth-first pre-order in
 * display order. Unknown items have no descendants. A visited set keeps corrupt input with an
 * existing cycle from looping forever.
 */
export function descendantsOf(items: readonly HierarchyItem[], itemId: string): string[] {
  const children = childrenIndex(items);
  const visited = new Set<string>([itemId]);
  const result: string[] = [];
  // Stack holds IDs to visit; children are pushed in reverse so the first child pops first.
  const stack = [...(children.get(itemId) ?? [])].reverse().map((child) => child.id);

  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    const kids = children.get(id) ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const kid = kids[i];
      if (kid !== undefined) stack.push(kid.id);
    }
  }
  return result;
}
