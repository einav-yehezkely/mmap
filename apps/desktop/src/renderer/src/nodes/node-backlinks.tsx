/**
 * Backlinks of a node (PRD §5.4): notes that link to it, with the source title and a short excerpt
 * around the link. Derived from saved notes, so a link removed and saved elsewhere disappears.
 */

import { useCallback, useEffect, useState } from 'react';

import { errorMessage, unwrap } from '../lib/ipc';
import { useNodesChanged } from './node-events';

interface Backlink {
  readonly sourceNodeId: string;
  readonly sourceTitle: string;
  readonly label: string;
  readonly excerpt: string;
  readonly occurrences: number;
}

export function NodeBacklinks({
  nodeId,
  onOpenNode,
}: {
  nodeId: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const [items, setItems] = useState<readonly Backlink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.nodes.backlinks({ nodeId })).then(
      ({ items: loaded }) => {
        if (!cancelled) setItems(loaded);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, reloadToken]);

  // Another note saved with or without a link to this node changes the list.
  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  return (
    <section aria-labelledby={`backlinks-${nodeId}`} className="space-y-2">
      <h3 id={`backlinks-${nodeId}`} className="text-sm font-medium">
        Linked from
      </h3>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No other note links here yet. Type [[ in a note to link to this node.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="divide-y rounded-md border">
          {items.map((item) => (
            <li key={item.sourceNodeId} className="px-3 py-2 text-sm">
              <button
                type="button"
                dir="auto"
                onClick={() => onOpenNode(item.sourceNodeId)}
                className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {item.sourceTitle}
              </button>
              {item.occurrences > 1 && (
                <span className="ml-2 text-xs text-muted-foreground">{item.occurrences} links</span>
              )}
              <p dir="auto" className="mt-0.5 text-xs text-muted-foreground">
                {item.excerpt}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
