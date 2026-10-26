/**
 * Library: every node in the workspace with sorting, tag filters and paging (PRD §5.2, §5.8).
 * Full-text search joins in Phase 2.
 */

import type { NodeSummary } from '@mmap/contracts';
import { Library, Plus, Tags } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { Button } from '../components/ui/button';
import { formatDateTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import { cn } from '../lib/utils';
import { ManageTagsDialog } from './manage-tags-dialog';
import { useNodesChanged } from './node-events';

const PAGE_SIZE = 50;

type SortOrder = 'updated-desc' | 'created-desc' | 'title-asc';

const SORT_LABELS: Record<SortOrder, string> = {
  'updated-desc': 'Recently updated',
  'created-desc': 'Recently created',
  'title-asc': 'Title (A–Z)',
};

interface ListState {
  readonly items: readonly NodeSummary[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

interface TagOption {
  readonly id: string;
  readonly label: string;
  readonly nodeCount: number;
}

export interface LibraryViewProps {
  readonly timeZone: string;
  readonly selectedNodeId: string | null;
  readonly onOpenNode: (nodeId: string) => void;
  readonly onCreateNode: () => void;
}

export function LibraryView({
  timeZone,
  selectedNodeId,
  onOpenNode,
  onCreateNode,
}: LibraryViewProps) {
  const [sort, setSort] = useState<SortOrder>('updated-desc');
  const [filterTagIds, setFilterTagIds] = useState<readonly string[]>([]);
  const [list, setList] = useState<ListState | null>(null);
  const [tagOptions, setTagOptions] = useState<readonly TagOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  const sortId = useId();

  // Reloads the first page and the tag list when sorting, filters or data change.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      unwrap(window.mmap.nodes.list({ sort, limit: PAGE_SIZE, tagIds: [...filterTagIds] })),
      unwrap(window.mmap.tags.list()),
    ]).then(
      ([page, tags]) => {
        if (cancelled) return;
        setList(page);
        setTagOptions(tags.items);
        // Drop filters for tags that were deleted meanwhile. Returning the same array when
        // nothing changed matters: `filterTagIds` is a dependency of this effect, so a new array
        // every time would reload forever.
        setFilterTagIds((current) => {
          const kept = current.filter((id) => tags.items.some((tag) => tag.id === id));
          return kept.length === current.length ? current : kept;
        });
        setError(null);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sort, filterTagIds, reloadToken]);

  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  const loadMore = async () => {
    if (list === null || list.nextCursor === null) return;
    try {
      const page = await unwrap(
        window.mmap.nodes.list({
          sort,
          limit: PAGE_SIZE,
          cursor: list.nextCursor,
          tagIds: [...filterTagIds],
        }),
      );
      setList({ ...page, items: [...list.items, ...page.items] });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const toggleFilter = (tagId: string) =>
    setFilterTagIds((current) =>
      current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId],
    );

  const isFiltered = filterTagIds.length > 0;

  return (
    <section aria-labelledby="library-title" className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="library-title" className="mr-auto text-2xl font-semibold tracking-tight">
          Library
        </h1>
        <Button variant="outline" size="sm" onClick={() => setManageTagsOpen(true)}>
          <Tags aria-hidden="true" />
          Manage tags
        </Button>
        <label htmlFor={sortId} className="text-sm text-muted-foreground">
          Sort by
        </label>
        <select
          id={sortId}
          value={sort}
          onChange={(event) => setSort(event.target.value as SortOrder)}
          className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {tagOptions.length > 0 && (
        <div
          role="group"
          aria-label="Filter by tags"
          className="mt-4 flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-1 text-sm text-muted-foreground">Filter:</span>
          {tagOptions.map((tag) => {
            const selected = filterTagIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleFilter(tag.id)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                <span dir="auto">{tag.label}</span>
                <span className={cn('ml-1 text-xs', !selected && 'text-muted-foreground')}>
                  {tag.nodeCount}
                </span>
              </button>
            );
          })}
          {isFiltered && (
            <Button variant="ghost" size="sm" onClick={() => setFilterTagIds([])}>
              Clear filters
            </Button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      {list === null && !error && (
        <p role="status" className="mt-6 text-muted-foreground">
          Loading…
        </p>
      )}

      {list !== null && list.totalCount === 0 && !isFiltered && (
        <div className="mt-16 text-center">
          <Library aria-hidden="true" className="mx-auto mb-4 size-10 text-muted-foreground" />
          <p className="text-lg font-medium">Your library is empty</p>
          <p className="mt-1 text-muted-foreground">
            Create a node for each idea, concept or source you want to remember.
          </p>
          <Button className="mt-6" onClick={onCreateNode}>
            <Plus aria-hidden="true" />
            Create your first node
          </Button>
        </div>
      )}

      {list !== null && list.totalCount === 0 && isFiltered && (
        <p className="mt-6 text-muted-foreground">No node has all of the selected tags.</p>
      )}

      {list !== null && list.totalCount > 0 && (
        <>
          <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
            Showing {list.items.length} of {list.totalCount} {isFiltered ? 'matching ' : ''}
            nodes
          </p>
          <ul className="mt-2 divide-y rounded-md border">
            {list.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenNode(item.id)}
                  aria-current={item.id === selectedNodeId ? 'true' : undefined}
                  className={cn(
                    'flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    item.id === selectedNodeId && 'bg-accent',
                  )}
                >
                  <span className="flex items-baseline gap-4">
                    <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
                      {item.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTime(item.updatedAt, timeZone)}
                    </span>
                  </span>
                  {item.tags.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <span
                          key={tag.id}
                          dir="auto"
                          className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {tag.label}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {list.nextCursor !== null && (
            <Button variant="outline" className="mt-4" onClick={() => void loadMore()}>
              Load more
            </Button>
          )}
        </>
      )}

      <ManageTagsDialog open={manageTagsOpen} onOpenChange={setManageTagsOpen} />
    </section>
  );
}
