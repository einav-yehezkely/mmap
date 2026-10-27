/**
 * Deterministic tree layout for hierarchical mind maps (PRD §5.6).
 *
 * The layout grows left to right:
 * - x is the depth: `x = depth * columnWidth` (roots at depth 0);
 * - every visible leaf takes the next free row (`y = row * rowHeight`) in depth-first display
 *   order, so subtrees never overlap;
 * - a parent is vertically centred between its first and last visible child (midpoint of their
 *   y values), which may fall between rows;
 * - root trees are stacked in display order with one empty row between consecutive trees;
 * - a collapsed item is laid out as a leaf, and all of its descendants are hidden: they get no
 *   position and consume no rows.
 *
 * Determinism: positions depend only on the item data, never on the input array order, because
 * siblings are always sorted by `siblingOrder` then `id`.
 *
 * Tolerance for imperfect input (the layout must always render something):
 * - an item whose `parentId` refers to a missing item, or to itself, is treated as a root;
 * - a corrupt pre-existing cycle is broken at its member with the smallest `id`, which is then
 *   treated as a root, so every item is still laid out exactly once.
 * Placement IDs are assumed to be unique.
 *
 * Everything is iterative, so 10,000-deep chains do not overflow the call stack.
 */

import { DomainError } from '../errors';
import { childrenIndex, compareIds } from './hierarchy';
import type { HierarchyItem } from './hierarchy';

export interface LayoutItem extends HierarchyItem {
  readonly collapsed: boolean;
}

export interface LayoutOptions {
  readonly columnWidth: number;
  readonly rowHeight: number;
}

export interface LayoutResult {
  /** Positions of visible items (descendants of collapsed items are hidden and absent). */
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  /** IDs hidden because an ancestor is collapsed. */
  readonly hidden: ReadonlySet<string>;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = { columnWidth: 260, rowHeight: 56 };

interface Position {
  readonly x: number;
  readonly y: number;
}

/** A unit of work for the explicit traversal stack: lay out an item, or finish a parent. */
interface Frame {
  readonly item: LayoutItem;
  readonly depth: number;
  readonly exit: boolean;
}

/**
 * Lays out the items as a left-to-right forest. Same input → same output, independent of the
 * order of `items`.
 *
 * @throws DomainError `VALIDATION_FAILED` when an option is not a positive finite number.
 */
export function layoutTree(
  items: readonly LayoutItem[],
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const { columnWidth, rowHeight } = resolveOptions(options);
  const children = childrenIndex(withEffectiveParents(items));
  const positions = new Map<string, Position>();
  const hidden = new Set<string>();
  let row = 0;

  (children.get(null) ?? []).forEach((root, rootIndex) => {
    if (rootIndex > 0) row += 1; // one empty row between root trees
    const stack: Frame[] = [{ item: root, depth: 0, exit: false }];

    while (stack.length > 0) {
      const { item, depth, exit } = stack.pop() as Frame;
      const kids = children.get(item.id) ?? [];
      const x = depth * columnWidth;

      if (exit) {
        positions.set(item.id, { x, y: midpoint(positions, kids) });
      } else if (kids.length === 0 || item.collapsed) {
        positions.set(item.id, { x, y: row * rowHeight });
        row += 1;
        hideDescendants(children, item, hidden);
      } else {
        stack.push({ item, depth, exit: true });
        for (let i = kids.length - 1; i >= 0; i -= 1) {
          const kid = kids[i];
          if (kid !== undefined) stack.push({ item: kid, depth: depth + 1, exit: false });
        }
      }
    }
  });

  return { positions, hidden };
}

function resolveOptions(options: Partial<LayoutOptions>): LayoutOptions {
  const resolved = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  for (const value of [resolved.columnWidth, resolved.rowHeight]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new DomainError('VALIDATION_FAILED', 'Layout sizes must be positive numbers.');
    }
  }
  return resolved;
}

/** Vertical centre between the first and last (already positioned) visible children. */
function midpoint(positions: ReadonlyMap<string, Position>, kids: readonly LayoutItem[]): number {
  const first = positions.get(kids[0]?.id ?? '');
  const last = positions.get(kids[kids.length - 1]?.id ?? '');
  if (first === undefined || last === undefined) {
    throw new DomainError('INVARIANT_VIOLATION', 'Children must be positioned before a parent.');
  }
  return (first.y + last.y) / 2;
}

/** Adds every descendant of `item` to `hidden` (iterative; the effective forest is acyclic). */
function hideDescendants(
  children: ReadonlyMap<string | null, readonly LayoutItem[]>,
  item: LayoutItem,
  hidden: Set<string>,
): void {
  const stack = [...(children.get(item.id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as LayoutItem;
    hidden.add(next.id);
    for (const kid of children.get(next.id) ?? []) stack.push(kid);
  }
}

/**
 * Returns copies of the items whose `parentId` is the parent actually used for layout: missing or
 * self parents become `null`, and each corrupt cycle is cut at its smallest-ID member. The result
 * is guaranteed to be a forest.
 */
function withEffectiveParents(items: readonly LayoutItem[]): LayoutItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const parentOf = new Map<string, string | null>();
  for (const item of items) {
    const { parentId } = item;
    const valid = parentId !== null && parentId !== item.id && byId.has(parentId);
    parentOf.set(item.id, valid ? parentId : null);
  }

  breakCycles(parentOf);
  return items.map((item) => ({ ...item, parentId: parentOf.get(item.id) ?? null }));
}

/**
 * Walks up from every item (in ID order, for determinism) until reaching a root or an item
 * already known to reach one. Meeting an item on the current path means a cycle; it is cut by
 * making its smallest-ID member a root. Each item is walked at most once, so this is O(n).
 */
function breakCycles(parentOf: Map<string, string | null>): void {
  const settled = new Set<string>();
  const ids = [...parentOf.keys()].sort(compareIds);

  for (const start of ids) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | null = start;

    while (current !== null && !settled.has(current) && !onPath.has(current)) {
      path.push(current);
      onPath.add(current);
      current = parentOf.get(current) ?? null;
    }

    if (current !== null && onPath.has(current)) {
      const cycle = path.slice(path.indexOf(current));
      const cutAt = cycle.reduce((min, id) => (compareIds(id, min) < 0 ? id : min));
      parentOf.set(cutAt, null);
    }
    for (const id of path) settled.add(id);
  }
}
