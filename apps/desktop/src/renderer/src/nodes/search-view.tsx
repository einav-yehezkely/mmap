/**
 * Search results (PRD §5.8): ranked full-text matches over titles, summaries and note text, with
 * highlighted plain-text snippets, tag filters and paging. Highlights are rendered as <mark>
 * elements from snippet segments; stored text is never inserted as HTML.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { errorMessage, unwrap } from '../lib/ipc';
import { useNodesChanged } from './node-events';
import { TagFilterBar, type TagOption } from './tag-filter-bar';

const PAGE_SIZE = 20;

interface SearchHit {
  readonly nodeId: string;
  readonly title: string;
  readonly snippet: readonly { readonly text: string; readonly isMatch: boolean }[];
}

interface Results {
  readonly items: readonly SearchHit[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export function SearchView({
  query,
  onOpenNode,
}: {
  query: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const [tagIds, setTagIds] = useState<readonly string[]>([]);
  const [tagOptions, setTagOptions] = useState<readonly TagOption[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      unwrap(window.mmap.search.query({ text: query, tagIds: [...tagIds], limit: PAGE_SIZE })),
      unwrap(window.mmap.tags.list()),
    ]).then(
      ([page, tags]) => {
        if (cancelled) return;
        setResults(page);
        setTagOptions(tags.items);
        setError(null);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [query, tagIds, reloadToken]);

  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  const loadMore = async () => {
    if (results === null || results.nextCursor === null) return;
    try {
      const page = await unwrap(
        window.mmap.search.query({
          text: query,
          tagIds: [...tagIds],
          limit: PAGE_SIZE,
          cursor: results.nextCursor,
        }),
      );
      setResults({ ...page, items: [...results.items, ...page.items] });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section aria-labelledby="search-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="search-title" className="text-2xl font-semibold tracking-tight">
        Search
      </h1>
      <TagFilterBar options={tagOptions} selected={tagIds} onChange={setTagIds} />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {query.trim() === '' && (
        <p className="text-muted-foreground">Type in the search box above to search your notes.</p>
      )}

      {query.trim() !== '' && results !== null && (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {results.totalCount === 0
              ? `No results for “${query}”.`
              : `Showing ${results.items.length} of ${results.totalCount} results for “${query}”.`}
          </p>
          <ul className="divide-y rounded-md border">
            {results.items.map((hit) => (
              <li key={hit.nodeId}>
                <button
                  type="button"
                  onClick={() => onOpenNode(hit.nodeId)}
                  className="block w-full px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span dir="auto" className="block font-medium">
                    {hit.title}
                  </span>
                  {hit.snippet.length > 0 && (
                    <span dir="auto" className="mt-1 block text-sm text-muted-foreground">
                      {hit.snippet.map((segment, index) =>
                        segment.isMatch ? (
                          <mark key={index} className="rounded bg-accent px-0.5 text-foreground">
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={index}>{segment.text}</span>
                        ),
                      )}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {results.nextCursor !== null && (
            <Button variant="outline" onClick={() => void loadMore()}>
              Load more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
