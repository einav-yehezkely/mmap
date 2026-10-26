/**
 * Tags of one node: shows them as removable chips and adds new ones by label, suggesting existing
 * workspace tags (PRD §5.8). Tag changes are saved immediately and do not go through autosave,
 * because they never conflict with note edits.
 */

import type { TagSummaryView } from '@mmap/contracts';
import { X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { notifyNodesChanged, useNodesChanged } from './node-events';

export function NodeTagsEditor({
  nodeId,
  initialTags,
}: {
  nodeId: string;
  initialTags: readonly TagSummaryView[];
}) {
  const [tags, setTags] = useState<readonly TagSummaryView[]>(initialTags);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const listId = useId();

  const loadSuggestions = useCallback(() => {
    unwrap(window.mmap.tags.list()).then(
      ({ items }) => setSuggestions(items.map((tag) => tag.label)),
      () => setSuggestions([]),
    );
  }, []);

  useEffect(loadSuggestions, [loadSuggestions]);

  // A tag renamed or deleted elsewhere (Manage tags) must be reflected here.
  useNodesChanged(
    useCallback(() => {
      unwrap(window.mmap.nodes.get({ nodeId })).then(
        (node) => setTags(node.tags),
        () => undefined,
      );
      loadSuggestions();
    }, [nodeId, loadSuggestions]),
  );

  const run = async (action: () => Promise<readonly TagSummaryView[]>) => {
    setError(null);
    try {
      setTags(await action());
      notifyNodesChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const label = draft.trim();
    if (label === '') return;
    void run(async () => {
      const result = await unwrap(window.mmap.nodes.addTag({ nodeId, label }));
      setDraft('');
      return result.tags;
    });
  };

  return (
    <div className="space-y-2">
      <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <li
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-sm"
          >
            <span dir="auto">{tag.label}</span>
            <button
              type="button"
              aria-label={`Remove tag ${tag.label}`}
              onClick={() =>
                void run(async () => {
                  const result = await unwrap(
                    window.mmap.nodes.removeTag({ nodeId, tagId: tag.id }),
                  );
                  return result.tags;
                })
              }
              className="rounded-full p-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          Add a tag
        </label>
        <Input
          id={inputId}
          list={listId}
          dir="auto"
          value={draft}
          maxLength={60}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a tag and press Enter"
          className="h-8 max-w-64"
        />
        <datalist id={listId}>
          {suggestions
            .filter((label) => !tags.some((tag) => tag.label === label))
            .map((label) => (
              <option key={label} value={label} />
            ))}
        </datalist>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
