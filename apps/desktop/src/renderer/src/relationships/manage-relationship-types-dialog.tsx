/**
 * Manage relationship types (PRD §4.2, §5.5): create custom types, rename, archive/restore, and
 * change direction while a type is unused. Archived types keep their relationships but are not
 * offered for new ones. Direction cannot change for a type in use; the dialog says why and
 * suggests creating a new type instead.
 */

import type { RelationshipTypeViewDto } from '@mmap/contracts';
import { Archive, ArchiveRestore, Check, Pencil } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';

type Directionality = 'directed' | 'undirected';

export function ManageRelationshipTypesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [types, setTypes] = useState<readonly RelationshipTypeViewDto[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newDirectionality, setNewDirectionality] = useState<Directionality>('directed');
  const [error, setError] = useState<string | null>(null);
  const newLabelId = useId();

  const reload = useCallback(async () => {
    setTypes((await unwrap(window.mmap.relationshipTypes.list())).items);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    unwrap(window.mmap.relationshipTypes.list()).then(
      ({ items }) => {
        if (!cancelled) setTypes(items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await unwrap(
        window.mmap.relationshipTypes.create({
          label: newLabel,
          directionality: newDirectionality,
        }),
      );
      setNewLabel('');
    });
  };

  const saveRename = (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    void run(async () => {
      await unwrap(
        window.mmap.relationshipTypes.rename({ typeId: editing.id, label: editing.label }),
      );
      setEditing(null);
    });
  };

  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 bg-black/50" />
        <Primitive.Content className="fixed left-1/2 top-1/2 flex max-h-[85vh] w-full max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border bg-background p-6 shadow-lg focus:outline-none">
          <Primitive.Title className="text-lg font-semibold">Relationship types</Primitive.Title>
          <Primitive.Description className="mt-1 text-sm text-muted-foreground">
            Directed types (→) have a source and a target; undirected types (—) do not. Archived
            types keep their relationships but are not offered for new ones.
          </Primitive.Description>

          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex-1 overflow-auto">
            {types === null ? (
              <p role="status">Loading…</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {types.map((type) => (
                  <li key={type.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    {editing?.id === type.id ? (
                      <form onSubmit={saveRename} className="flex flex-1 items-center gap-2">
                        <Input
                          aria-label={`New name for ${type.label}`}
                          autoFocus
                          dir="auto"
                          value={editing.label}
                          maxLength={60}
                          onChange={(event) =>
                            setEditing({ id: type.id, label: event.target.value })
                          }
                          className="h-8"
                        />
                        <Button type="submit" size="icon" aria-label="Save type name">
                          <Check aria-hidden="true" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <span
                          dir="auto"
                          className={type.isArchived ? 'text-muted-foreground line-through' : ''}
                        >
                          {type.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {type.directionality === 'directed' ? '→ directed' : '— undirected'} ·{' '}
                          {type.usageCount} in use{type.isArchived ? ' · archived' : ''}
                        </span>
                        <span className="ml-auto flex items-center gap-1">
                          <DirectionSelect
                            type={type}
                            onChange={(directionality) =>
                              void run(() =>
                                unwrap(
                                  window.mmap.relationshipTypes.setDirectionality({
                                    typeId: type.id,
                                    directionality,
                                  }),
                                ),
                              )
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Rename ${type.label}`}
                            onClick={() => setEditing({ id: type.id, label: type.label })}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={
                              type.isArchived ? `Restore ${type.label}` : `Archive ${type.label}`
                            }
                            title={type.isArchived ? 'Restore' : 'Archive'}
                            onClick={() =>
                              void run(() =>
                                unwrap(
                                  window.mmap.relationshipTypes.setArchived({
                                    typeId: type.id,
                                    archived: !type.isArchived,
                                  }),
                                ),
                              )
                            }
                          >
                            {type.isArchived ? (
                              <ArchiveRestore aria-hidden="true" />
                            ) : (
                              <Archive aria-hidden="true" />
                            )}
                          </Button>
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
            <div className="flex-1 space-y-1">
              <label htmlFor={newLabelId} className="text-sm">
                New type
              </label>
              <Input
                id={newLabelId}
                dir="auto"
                value={newLabel}
                maxLength={60}
                placeholder="e.g. inspired by"
                onChange={(event) => setNewLabel(event.target.value)}
              />
            </div>
            <select
              aria-label="Direction of the new type"
              value={newDirectionality}
              onChange={(event) => setNewDirectionality(event.target.value as Directionality)}
              className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="directed">→ directed</option>
              <option value="undirected">— undirected</option>
            </select>
            <Button type="submit" disabled={newLabel.trim() === ''}>
              Create type
            </Button>
          </form>

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

/** Direction can change only while unused; otherwise the control explains why it is locked. */
function DirectionSelect({
  type,
  onChange,
}: {
  type: RelationshipTypeViewDto;
  onChange: (directionality: Directionality) => void;
}) {
  const locked = type.usageCount > 0;
  return (
    <select
      aria-label={`Direction of ${type.label}`}
      title={
        locked
          ? 'In use: direction cannot change. Create a new type with the other direction instead.'
          : 'Change direction'
      }
      disabled={locked}
      value={type.directionality}
      onChange={(event) => onChange(event.target.value as Directionality)}
      className="h-8 rounded-md border bg-background px-1 text-xs disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="directed">→</option>
      <option value="undirected">—</option>
    </select>
  );
}
