/**
 * Relationships of one node (PRD §5.5): list, add, reverse, change type, describe, delete.
 *
 * Direction is always shown explicitly (PRD §4.2): directed relationships read as
 * "source → type → target" with an arrow; undirected ones use a plain dash and no arrow. The
 * current node is marked "this node", so the meaning is clear whichever end it is on, and the
 * arrow is accompanied by text so meaning never depends on a symbol alone.
 */

import type { RelationshipTypeViewDto, RelationshipViewDto } from '@mmap/contracts';
import { ArrowLeftRight, Plus, Settings2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { notifyNodesChanged, useNodesChanged } from '../nodes/node-events';
import { NodePicker, type PickedNode } from '../nodes/node-picker';
import { ManageRelationshipTypesDialog } from './manage-relationship-types-dialog';

export interface NodeRelationshipsProps {
  readonly nodeId: string;
  readonly onOpenNode: (nodeId: string) => void;
}

export function NodeRelationships({ nodeId, onOpenNode }: NodeRelationshipsProps) {
  const [items, setItems] = useState<readonly RelationshipViewDto[] | null>(null);
  const [types, setTypes] = useState<readonly RelationshipTypeViewDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [manageTypesOpen, setManageTypesOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RelationshipViewDto | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      unwrap(window.mmap.relationships.listForNode({ nodeId })),
      unwrap(window.mmap.relationshipTypes.list()),
    ]).then(
      ([relationships, typeList]) => {
        if (cancelled) return;
        setItems(relationships.items);
        setTypes(typeList.items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, reloadToken]);

  // Titles of related nodes change when they are renamed elsewhere.
  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const activeTypes = types.filter((type) => !type.isArchived);

  return (
    <section aria-labelledby={`relationships-${nodeId}`} className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 id={`relationships-${nodeId}`} className="mr-auto text-sm font-medium">
          Relationships
        </h3>
        <Button variant="ghost" size="sm" onClick={() => setManageTypesOpen(true)}>
          <Settings2 aria-hidden="true" />
          Types
        </Button>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {adding && (
        <AddRelationshipForm
          nodeId={nodeId}
          types={activeTypes}
          onCancel={() => setAdding(false)}
          onCreate={(input) =>
            run(async () => {
              await unwrap(window.mmap.relationships.create(input));
              setAdding(false);
              notifyNodesChanged();
            })
          }
        />
      )}

      {items !== null && items.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">
          No relationships yet. Relationships are created only when you add them here.
        </p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="divide-y rounded-md border">
          {items.map((item) => (
            <RelationshipRow
              key={item.id}
              item={item}
              currentNodeId={nodeId}
              types={types}
              onOpenNode={onOpenNode}
              onReverse={() =>
                void run(() =>
                  unwrap(
                    window.mmap.relationships.update({
                      relationshipId: item.id,
                      changes: { reverseDirection: true },
                    }),
                  ),
                )
              }
              onChangeType={(typeId) =>
                void run(() =>
                  unwrap(
                    window.mmap.relationships.update({
                      relationshipId: item.id,
                      changes: { typeId },
                    }),
                  ),
                )
              }
              onDelete={() => setConfirmDelete(item)}
              onSaveDescription={(description) =>
                run(() =>
                  unwrap(
                    window.mmap.relationships.update({
                      relationshipId: item.id,
                      changes: { description },
                    }),
                  ),
                )
              }
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title="Delete this relationship?"
        confirmLabel="Delete relationship"
        onConfirm={() =>
          void run(async () => {
            if (confirmDelete === null) return;
            await unwrap(window.mmap.relationships.delete({ relationshipId: confirmDelete.id }));
            setConfirmDelete(null);
            notifyNodesChanged();
          })
        }
      >
        {confirmDelete && (
          <p>
            “{confirmDelete.source.title}” {confirmDelete.typeLabel} “{confirmDelete.target.title}”.
            Both nodes stay.
          </p>
        )}
      </ConfirmDialog>

      <ManageRelationshipTypesDialog
        open={manageTypesOpen}
        onOpenChange={(open) => {
          setManageTypesOpen(open);
          if (!open) setReloadToken((token) => token + 1);
        }}
      />
    </section>
  );
}

function RelationshipRow({
  item,
  currentNodeId,
  types,
  onOpenNode,
  onReverse,
  onChangeType,
  onSaveDescription,
  onDelete,
}: {
  item: RelationshipViewDto;
  currentNodeId: string;
  types: readonly RelationshipTypeViewDto[];
  onOpenNode: (nodeId: string) => void;
  onReverse: () => void;
  onChangeType: (typeId: string) => void;
  onSaveDescription: (description: string | null) => Promise<void>;
  onDelete: () => void;
}) {
  const typeSelectId = useId();
  const descriptionFieldId = useId();
  /** The description being edited, or null when not editing. */
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const directed = item.directionality === 'directed';
  const end = (node: { id: string; title: string }) =>
    node.id === currentNodeId ? (
      <span className="font-medium">this node</span>
    ) : (
      <button
        type="button"
        dir="auto"
        className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenNode(node.id)}
      >
        {node.title}
      </button>
    );
  // The current type stays selectable even if archived; other archived types are hidden.
  const selectableTypes = types.filter((type) => !type.isArchived || type.id === item.typeId);

  return (
    <li className="space-y-1 px-3 py-2 text-sm">
      <p className="flex flex-wrap items-center gap-x-1.5">
        {end(item.source)}
        <span className="text-muted-foreground">
          {directed ? `— ${item.typeLabel} →` : `— ${item.typeLabel} —`}
        </span>
        {end(item.target)}
        <span className="sr-only">{directed ? '(directed)' : '(undirected, no direction)'}</span>
      </p>
      {descriptionDraft === null ? (
        item.description && (
          <p dir="auto" className="text-xs text-muted-foreground">
            {item.description}
          </p>
        )
      ) : (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaveDescription(descriptionDraft.trim() || null).then(() =>
              setDescriptionDraft(null),
            );
          }}
        >
          <label htmlFor={descriptionFieldId} className="sr-only">
            Why are they related?
          </label>
          <Input
            id={descriptionFieldId}
            dir="auto"
            autoFocus
            value={descriptionDraft}
            maxLength={1_000}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm">
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDescriptionDraft(null)}>
            Cancel
          </Button>
        </form>
      )}
      <div className="flex items-center gap-1">
        <label htmlFor={typeSelectId} className="sr-only">
          Relationship type
        </label>
        <select
          id={typeSelectId}
          value={item.typeId}
          onChange={(event) => onChangeType(event.target.value)}
          className="h-7 rounded-md border bg-background px-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {selectableTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
              {type.directionality === 'directed' ? ' (→)' : ' (—)'}
            </option>
          ))}
        </select>
        {descriptionDraft === null && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDescriptionDraft(item.description ?? '')}
          >
            {item.description ? 'Edit note' : 'Add note'}
          </Button>
        )}
        {directed && (
          <Button variant="ghost" size="sm" onClick={onReverse} title="Swap source and target">
            <ArrowLeftRight aria-hidden="true" />
            Reverse
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete relationship"
          onClick={onDelete}
          className="ml-auto"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

export interface AddRelationshipFormProps {
  readonly nodeId: string;
  readonly types: readonly RelationshipTypeViewDto[];
  readonly onCancel: () => void;
  readonly onCreate: (input: {
    sourceNodeId: string;
    targetNodeId: string;
    typeId: string;
    description: string | null;
  }) => Promise<void>;
  /**
   * A node chosen outside the form (the knowledge graph: clicking a node while the form is open).
   * Each new value becomes the other end; the type, direction and text typed so far are kept.
   */
  readonly pickedOther?: PickedNode | null;
  /** Shown under the node picker, e.g. that a node can also be clicked on the graph. */
  readonly pickerHint?: string;
}

/** Form for a new relationship of `nodeId`; also used by the knowledge graph's side panel. */
export function AddRelationshipForm({
  nodeId,
  types,
  onCancel,
  onCreate,
  pickedOther = null,
  pickerHint,
}: AddRelationshipFormProps) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [thisIsSource, setThisIsSource] = useState(true);
  const [other, setOther] = useState<PickedNode | null>(pickedOther);
  // Adopts a node picked outside the form (state adjusted during render, as React recommends
  // instead of an effect).
  const [adoptedPick, setAdoptedPick] = useState<PickedNode | null>(pickedOther);
  if (pickedOther !== adoptedPick) {
    setAdoptedPick(pickedOther);
    if (pickedOther !== null) setOther(pickedOther);
  }
  const [description, setDescription] = useState('');
  const typeFieldId = useId();
  const descriptionId = useId();
  const type = types.find((candidate) => candidate.id === typeId);
  const directed = type?.directionality === 'directed';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (other === null || type === undefined) return;
    const [sourceNodeId, targetNodeId] =
      !directed || thisIsSource ? [nodeId, other.id] : [other.id, nodeId];
    void onCreate({ sourceNodeId, targetNodeId, typeId, description: description.trim() || null });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {directed && !thisIsSource ? (
          <OtherSlot other={other} onClear={() => setOther(null)} />
        ) : (
          <span className="font-medium">This node</span>
        )}
        <label htmlFor={typeFieldId} className="sr-only">
          Relationship type
        </label>
        <select
          id={typeFieldId}
          value={typeId}
          onChange={(event) => setTypeId(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {types.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
              {candidate.directionality === 'directed' ? ' →' : ' —'}
            </option>
          ))}
        </select>
        {directed && !thisIsSource ? (
          <span className="font-medium">this node</span>
        ) : (
          <OtherSlot other={other} onClear={() => setOther(null)} />
        )}
        {directed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setThisIsSource((value) => !value)}
            title="Swap which node is the source"
          >
            <ArrowLeftRight aria-hidden="true" />
            Swap
          </Button>
        )}
      </div>

      {other === null && (
        <NodePicker
          label="Choose the related node"
          excludeNodeIds={[nodeId]}
          onPick={setOther}
          autoFocus
        />
      )}
      {other === null && pickerHint !== undefined && (
        <p className="text-xs text-muted-foreground">{pickerHint}</p>
      )}

      <div className="space-y-1">
        <label htmlFor={descriptionId} className="text-xs text-muted-foreground">
          Why are they related? (optional)
        </label>
        <Input
          id={descriptionId}
          dir="auto"
          value={description}
          maxLength={1_000}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={other === null || type === undefined}>
          Add relationship
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function OtherSlot({ other, onClear }: { other: PickedNode | null; onClear: () => void }) {
  if (other === null) {
    return <span className="italic text-muted-foreground">(choose a node below)</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5">
      <span dir="auto" className="font-medium">
        {other.title}
      </span>
      <button
        type="button"
        aria-label={`Choose a different node instead of ${other.title}`}
        onClick={onClear}
        className="text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </span>
  );
}
