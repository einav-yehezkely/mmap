/**
 * Workspace tag management: rename and delete (PRD §5.8). Deleting a tag removes it from every
 * node but never deletes nodes, and the dialog says so before confirming.
 */

import { Check, Pencil, Trash2 } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { notifyNodesChanged } from './node-events';

interface TagRow {
  readonly id: string;
  readonly label: string;
  readonly nodeCount: number;
}

export function ManageTagsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tags, setTags] = useState<readonly TagRow[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TagRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setTags((await unwrap(window.mmap.tags.list())).items);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    unwrap(window.mmap.tags.list()).then(
      ({ items }) => {
        if (!cancelled) setTags(items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      await reload();
      notifyNodesChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const saveRename = (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    void run(async () => {
      await unwrap(window.mmap.tags.rename({ tagId: editing.id, label: editing.label }));
      setEditing(null);
    });
  };

  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 bg-black/50" />
        <Primitive.Content className="fixed left-1/2 top-1/2 flex max-h-[80vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border bg-background p-6 shadow-lg focus:outline-none">
          <Primitive.Title className="text-lg font-semibold">Manage tags</Primitive.Title>
          <Primitive.Description className="mt-1 text-sm text-muted-foreground">
            Renaming a tag updates it on every node. Deleting a tag removes it from nodes but never
            deletes the nodes themselves.
          </Primitive.Description>

          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex-1 overflow-auto">
            {tags === null && <p role="status">Loading…</p>}
            {tags !== null && tags.length === 0 && (
              <p className="text-sm text-muted-foreground">No tags yet. Add tags from a node.</p>
            )}
            {tags !== null && tags.length > 0 && (
              <ul className="divide-y rounded-md border">
                {tags.map((tag) => (
                  <li key={tag.id} className="flex items-center gap-2 px-3 py-2">
                    {editing?.id === tag.id ? (
                      <form onSubmit={saveRename} className="flex flex-1 items-center gap-2">
                        <Input
                          aria-label={`New name for ${tag.label}`}
                          dir="auto"
                          autoFocus
                          value={editing.label}
                          maxLength={60}
                          onChange={(event) =>
                            setEditing({ id: tag.id, label: event.target.value })
                          }
                          className="h-8"
                        />
                        <Button type="submit" size="icon" aria-label="Save tag name">
                          <Check aria-hidden="true" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span dir="auto" className="min-w-0 flex-1 truncate">
                          {tag.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {tag.nodeCount} {tag.nodeCount === 1 ? 'node' : 'nodes'}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Rename ${tag.label}`}
                          onClick={() => setEditing({ id: tag.id, label: tag.label })}
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${tag.label}`}
                          onClick={() => setConfirmDelete(tag)}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {confirmDelete && (
            <div
              role="alertdialog"
              aria-label="Confirm tag deletion"
              className="mt-4 rounded-md border border-destructive p-3 text-sm"
            >
              <p>
                Delete the tag “{confirmDelete.label}”? It will be removed from{' '}
                {confirmDelete.nodeCount} {confirmDelete.nodeCount === 1 ? 'node' : 'nodes'}. The
                nodes stay.
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    void run(async () => {
                      await unwrap(window.mmap.tags.delete({ tagId: confirmDelete.id }));
                      setConfirmDelete(null);
                    })
                  }
                >
                  Delete tag
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Primitive.Close asChild>
              <Button variant="outline">Done</Button>
            </Primitive.Close>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
