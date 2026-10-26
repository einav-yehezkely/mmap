/**
 * Shared pagination contract for list and search operations (PRD §5.2, §5.8).
 *
 * Cursor-based paging keeps results stable while the user edits: offsets would skip or repeat
 * rows when records are created or deleted between page requests. Cursors are opaque strings
 * produced by the adapter; callers must not parse them.
 */

export interface PageRequest {
  /** Maximum number of items to return. Adapters clamp this to a safe upper bound. */
  readonly limit: number;
  /** Opaque cursor returned by the previous page, or `undefined` for the first page. */
  readonly cursor?: string | undefined;
}

export interface Page<Item> {
  readonly items: readonly Item[];
  /** Cursor for the next page, or `null` when there are no more items. */
  readonly nextCursor: string | null;
}

/** Upper bound for any single page. Protects the UI and IPC channel from unbounded payloads. */
export const MAX_PAGE_SIZE = 200;

/** Clamps a requested page size into `[1, MAX_PAGE_SIZE]`. Non-finite input becomes 1. */
export function clampPageSize(requested: number): number {
  if (!Number.isFinite(requested)) {
    return 1;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)));
}
