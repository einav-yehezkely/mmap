/**
 * "New node": a title, and optionally the mind maps to add the node to.
 *
 * - Choosing maps is optional: without any, the node is only in the Library.
 * - When the dialog is opened while a map is open, that map is preselected.
 * - One canonical node is created and placed on every chosen map (the main process does both in
 *   one transaction), at a free spot near the map's other items. In a hierarchical map the user
 *   chooses the parent, or "Top level".
 * - Semantic relationships of the node to nodes already on a map appear there automatically,
 *   because maps show the relationships between their nodes.
 */

import type { MapSummaryDto, MapViewDto } from '@mmap/contracts';
import { useEffect, useId, useMemo, useState } from 'react';

import { FormDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { parentChoices, type ParentChoice } from '../maps/map-model';
import { notifyNodesChanged } from './node-events';

/** Above this many maps the list gets a search box. */
const SEARCH_THRESHOLD = 6;

export interface NewNodeDialogProps {
  /** Map to preselect, when the dialog was opened from inside that map. */
  readonly preselectedMapId: string | null;
  readonly onCreated: (nodeId: string) => void;
  readonly onClose: () => void;
}

export function NewNodeDialog({ preselectedMapId, onCreated, onClose }: NewNodeDialogProps) {
  const [title, setTitle] = useState('');
  const [maps, setMaps] = useState<readonly MapSummaryDto[] | null>(null);
  /** Chosen maps, each with its parent placement (null: top level / freeform). */
  const [chosen, setChosen] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(preselectedMapId === null ? [] : [[preselectedMapId, null]]),
  );
  const [parents, setParents] = useState<ReadonlyMap<string, readonly ParentChoice[]>>(new Map());
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const filterId = useId();

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.maps.list()).then(
      (result) => {
        if (!cancelled) setMaps(result.items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Parent choices for each chosen hierarchical map, loaded once per map.
  const hierarchical = useMemo(
    () => new Set((maps ?? []).filter((map) => map.mode === 'hierarchical').map((map) => map.id)),
    [maps],
  );
  useEffect(() => {
    const missing = [...chosen.keys()].filter((id) => hierarchical.has(id) && !parents.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map((mapId) =>
        unwrap(window.mmap.maps.get({ mapId })).then(
          (view: MapViewDto) => [mapId, parentChoices(view)] as const,
          () => [mapId, [] as ParentChoice[]] as const,
        ),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      setParents((current) => new Map([...current, ...loaded]));
    });
    return () => {
      cancelled = true;
    };
  }, [chosen, hierarchical, parents]);

  const toggle = (mapId: string) =>
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(mapId)) next.delete(mapId);
      else next.set(mapId, null);
      return next;
    });

  const setParent = (mapId: string, parentPlacementId: string | null) =>
    setChosen((current) => new Map(current).set(mapId, parentPlacementId));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const node = await unwrap(
        window.mmap.nodes.create({
          title: title.trim() === '' ? 'Untitled node' : title,
          addToMaps: [...chosen].map(([mapId, parentPlacementId]) => ({
            mapId,
            parentPlacementId,
          })),
        }),
      );
      notifyNodesChanged();
      onCreated(node.id);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  const visibleMaps = (maps ?? []).filter(
    (map) =>
      filter.trim() === '' ||
      chosen.has(map.id) ||
      map.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New node"
      description="A node is one idea. You can add it to mind maps now, or later from any map."
      submitLabel={
        chosen.size === 0
          ? 'Create node'
          : `Create and add to ${chosen.size === 1 ? '1 map' : `${chosen.size} maps`}`
      }
      submitDisabled={busy}
      onSubmit={() => void submit()}
    >
      <div className="space-y-1">
        <label htmlFor={titleId} className="text-sm">
          Title
        </label>
        <Input
          id={titleId}
          autoFocus
          dir="auto"
          maxLength={300}
          placeholder="Untitled node"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm">Add to Mind Maps (optional)</legend>
        {maps === null && error === null && (
          <p className="text-sm text-muted-foreground">Loading maps…</p>
        )}
        {maps !== null && maps.length === 0 && (
          <p className="text-sm text-muted-foreground">
            There are no mind maps yet. The node will be in the Library.
          </p>
        )}
        {maps !== null && maps.length > SEARCH_THRESHOLD && (
          <div>
            <label htmlFor={filterId} className="sr-only">
              Find a map
            </label>
            <Input
              id={filterId}
              type="search"
              placeholder="Find a map"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        )}
        {maps !== null && maps.length > 0 && (
          <ul className="max-h-64 space-y-1 overflow-auto rounded-md border p-1">
            {visibleMaps.map((map) => {
              const checked = chosen.has(map.id);
              const checkboxId = `${filterId}-${map.id}`;
              const parentId = `${checkboxId}-parent`;
              const choices = parents.get(map.id);
              return (
                <li key={map.id} className="rounded px-2 py-1.5 hover:bg-accent/40">
                  <label htmlFor={checkboxId} className="flex items-center gap-2 text-sm">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(map.id)}
                    />
                    <span className="min-w-0 flex-1 truncate" dir="auto">
                      {map.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {map.mode === 'hierarchical' ? 'Hierarchy' : 'Freeform'} ·{' '}
                      {map.placementCount === 1 ? '1 item' : `${map.placementCount} items`}
                    </span>
                  </label>
                  {checked && map.mode === 'hierarchical' && (
                    <div className="mt-1.5 flex items-center gap-2 pl-6 text-sm">
                      <label htmlFor={parentId} className="shrink-0 text-muted-foreground">
                        Place under
                      </label>
                      <select
                        id={parentId}
                        className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        value={chosen.get(map.id) ?? ''}
                        disabled={choices === undefined}
                        onChange={(event) =>
                          setParent(map.id, event.target.value === '' ? null : event.target.value)
                        }
                      >
                        <option value="">Top level (a new root)</option>
                        {(choices ?? []).map((choice) => (
                          <option key={choice.placementId} value={choice.placementId}>
                            {`${'  '.repeat(choice.depth)}${choice.title}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </li>
              );
            })}
            {visibleMaps.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">No map matches.</li>
            )}
          </ul>
        )}
      </fieldset>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </FormDialog>
  );
}
