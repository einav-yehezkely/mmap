/**
 * Node picker: an accessible combobox (WAI-ARIA 1.2 pattern) backed by the deterministic title
 * lookup (PRD §5.8). Used to choose relationship endpoints and wikilink targets.
 *
 * Keyboard: type to search, ArrowDown/ArrowUp to move, Enter to choose, Escape to clear.
 * Lookups are debounced and stale responses are ignored, so fast typing never shows results
 * for an older query.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { cn } from '../lib/utils';

export interface PickedNode {
  readonly id: string;
  readonly title: string;
}

export interface NodePickerProps {
  readonly label: string;
  readonly onPick: (node: PickedNode) => void;
  readonly excludeNodeIds?: readonly string[];
  /** Leaves out every node already on this map (any number), checked by the main process. */
  readonly excludeOnMapId?: string;
  /** A short note shown after a result's title, e.g. "already on this map". */
  readonly describe?: (node: PickedNode) => string | null;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  /**
   * When set, the list ends with "Create “text”", so creating a node is always an explicit
   * choice (PRD §5.4: "users select a target or explicitly create a new node").
   */
  readonly onCreateNew?: (title: string) => void;
}

const DEBOUNCE_MS = 150;

export function NodePicker({
  label,
  onPick,
  excludeNodeIds = [],
  excludeOnMapId,
  describe,
  placeholder = 'Type to find a node',
  autoFocus = false,
  onCreateNew,
}: NodePickerProps) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<readonly PickedNode[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  /** The query the current results answer; avoids claiming "no match" while still looking up. */
  const [answeredQuery, setAnsweredQuery] = useState('');
  /** Shown instead of an empty list when a lookup fails, so it never looks like "no match". */
  const [lookupError, setLookupError] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const inputId = useId();
  const listId = useId();
  const excludeKey = excludeNodeIds.join(',');

  useEffect(() => {
    const query = text.trim();
    const requestNumber = ++latestRequest.current;
    const timer = setTimeout(() => {
      if (query === '') {
        setResults([]);
        return;
      }
      unwrap(
        window.mmap.nodes.lookup({
          text: query,
          limit: 8,
          excludeNodeIds: excludeKey === '' ? [] : excludeKey.split(','),
          ...(excludeOnMapId === undefined ? {} : { excludeOnMapId }),
        }),
      ).then(
        ({ items }) => {
          if (requestNumber !== latestRequest.current) return;
          setResults(items);
          setAnsweredQuery(query);
          setActiveIndex(0);
          setLookupError(null);
        },
        (caught: unknown) => {
          if (requestNumber !== latestRequest.current) return;
          setResults([]);
          setLookupError(errorMessage(caught));
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, excludeKey, excludeOnMapId]);

  const trimmed = text.trim();
  const canCreate = onCreateNew !== undefined && trimmed !== '' && answeredQuery === trimmed;
  /** Results plus the optional "create" entry, which is always last. */
  const optionCount = results.length + (canCreate ? 1 : 0);

  const pick = (node: PickedNode | undefined) => {
    if (node === undefined) return;
    onPick(node);
    setText('');
    setResults([]);
  };

  const choose = (index: number) => {
    if (index < results.length) {
      pick(results[index]);
    } else if (canCreate) {
      onCreateNew(trimmed);
      setText('');
      setResults([]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, optionCount - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape') {
      setText('');
      setResults([]);
    }
  };

  const open = optionCount > 0;
  const activeId = open ? `${listId}-${activeIndex}` : undefined;

  return (
    <div className="relative">
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        autoFocus={autoFocus}
        dir="auto"
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        className={cn(
          'absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background shadow-md',
          !open && 'hidden',
        )}
      >
        {results.map((node, index) => (
          <li
            key={node.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            dir="auto"
            className={cn(
              'cursor-pointer truncate px-3 py-1.5 text-sm',
              index === activeIndex && 'bg-accent text-accent-foreground',
            )}
            // mousedown (not click) so the choice lands before the input loses focus.
            onMouseDown={(event) => {
              event.preventDefault();
              pick(node);
            }}
            onMouseEnter={() => setActiveIndex(index)}
          >
            {node.title}
            {describe?.(node) && (
              <span className="ml-2 text-xs text-muted-foreground">{describe(node)}</span>
            )}
          </li>
        ))}
        {canCreate && (
          <li
            id={`${listId}-${results.length}`}
            role="option"
            aria-selected={activeIndex === results.length}
            className={cn(
              'cursor-pointer truncate border-t px-3 py-1.5 text-sm italic',
              activeIndex === results.length && 'bg-accent text-accent-foreground',
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(results.length);
            }}
            onMouseEnter={() => setActiveIndex(results.length)}
          >
            Create a new node “{trimmed}”
          </li>
        )}
      </ul>
      {lookupError !== null && trimmed !== '' && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {lookupError}
        </p>
      )}
      {lookupError === null && trimmed !== '' && answeredQuery === trimmed && optionCount === 0 && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          No matching node.
        </p>
      )}
    </div>
  );
}
