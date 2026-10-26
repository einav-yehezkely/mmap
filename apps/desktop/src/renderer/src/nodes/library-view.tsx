/**
 * Library: every node in the workspace with sorting and paging (PRD §5.2). Tags and search
 * filters join in later slices.
 */

import type { NodeSummary } from '@mmap/contracts';
import { Library, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { formatDateTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
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
  const [list, setList] = useState<ListState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const sortId = useId();

  // Loads the first page whenever the sort order changes or nodes change elsewhere.
  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.nodes.list({ sort, limit: PAGE_SIZE })).then(
      (page) => {
        if (cancelled) return;
        setList(page);
        setError(null);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sort, reloadToken]);

  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  const loadMore = async () => {
    if (list === null || list.nextCursor === null) return;
    try {
      const page = await unwrap(
        window.mmap.nodes.list({ sort, limit: PAGE_SIZE, cursor: list.nextCursor }),
      );
      setList({ ...page, items: [...list.items, ...page.items] });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section aria-labelledby="library-title" className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 id="library-title" className="mr-auto text-2xl font-semibold tracking-tight">
          Library
        </h1>
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

      {list !== null && list.totalCount === 0 && (
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

      {list !== null && list.totalCount > 0 && (
        <>
          <p className="mt-4 text-sm text-muted-foreground" aria-live="polite">
            Showing {list.items.length} of {list.totalCount} nodes
          </p>
          <ul className="mt-2 divide-y rounded-md border">
            {list.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenNode(item.id)}
                  aria-current={item.id === selectedNodeId ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-baseline gap-4 px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    item.id === selectedNodeId && 'bg-accent',
                  )}
                >
                  <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDateTime(item.updatedAt, timeZone)}
                  </span>
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
    </section>
  );
}
