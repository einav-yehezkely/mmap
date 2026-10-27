/**
 * Choosing mind maps to add a node to ("Add to Mind Maps"), shared by the New node dialog and the
 * node panel. Each map is a checkbox; a chosen hierarchical map also asks where the node goes
 * ("Place under" an existing item, or the top level). Maps that already show the node are listed
 * as such and cannot be chosen again, because a node appears at most once per map.
 */

import type { MapSummaryDto, MapViewDto } from '@mmap/contracts';
import { useEffect, useId, useMemo, useState } from 'react';

import { Input } from '../components/ui/input';
import { unwrap } from '../lib/ipc';
import { parentChoices, type ParentChoice } from './map-model';

/** Above this many maps the list gets a search box. */
const SEARCH_THRESHOLD = 6;

/** Chosen maps, each with the parent placement to put the node under (null: top level). */
export type MapTargets = ReadonlyMap<string, string | null>;

export interface MapTargetsPickerProps {
  readonly legend: string;
  /** All maps of the workspace; null while loading. */
  readonly maps: readonly MapSummaryDto[] | null;
  readonly chosen: MapTargets;
  readonly onChange: (chosen: MapTargets) => void;
  /** Maps that already show the node. */
  readonly alreadyOn?: ReadonlySet<string>;
}

export function MapTargetsPicker({
  legend,
  maps,
  chosen,
  onChange,
  alreadyOn = new Set(),
}: MapTargetsPickerProps) {
  const [parents, setParents] = useState<ReadonlyMap<string, readonly ParentChoice[]>>(new Map());
  const [filter, setFilter] = useState('');
  const baseId = useId();

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
      if (!cancelled) setParents((current) => new Map([...current, ...loaded]));
    });
    return () => {
      cancelled = true;
    };
  }, [chosen, hierarchical, parents]);

  const toggle = (mapId: string) => {
    const next = new Map(chosen);
    if (next.has(mapId)) next.delete(mapId);
    else next.set(mapId, null);
    onChange(next);
  };

  const query = filter.trim().toLocaleLowerCase();
  const visibleMaps = (maps ?? []).filter(
    (map) => query === '' || chosen.has(map.id) || map.title.toLocaleLowerCase().includes(query),
  );

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm">{legend}</legend>
      {maps === null && <p className="text-sm text-muted-foreground">Loading maps…</p>}
      {maps !== null && maps.length === 0 && (
        <p className="text-sm text-muted-foreground">There are no mind maps yet.</p>
      )}
      {maps !== null && maps.length > SEARCH_THRESHOLD && (
        <div>
          <label htmlFor={`${baseId}-filter`} className="sr-only">
            Find a map
          </label>
          <Input
            id={`${baseId}-filter`}
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
            const isOn = alreadyOn.has(map.id);
            const checked = isOn || chosen.has(map.id);
            const checkboxId = `${baseId}-${map.id}`;
            const parentId = `${checkboxId}-parent`;
            const choices = parents.get(map.id);
            return (
              <li key={map.id} className="rounded px-2 py-1.5 hover:bg-accent/40">
                <label htmlFor={checkboxId} className="flex items-center gap-2 text-sm">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={checked}
                    disabled={isOn}
                    onChange={() => toggle(map.id)}
                  />
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {map.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {isOn
                      ? 'Already on this map'
                      : `${map.mode === 'hierarchical' ? 'Hierarchy' : 'Freeform'} · ${
                          map.placementCount === 1 ? '1 item' : `${map.placementCount} items`
                        }`}
                  </span>
                </label>
                {!isOn && chosen.has(map.id) && map.mode === 'hierarchical' && (
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
                        onChange(
                          new Map(chosen).set(
                            map.id,
                            event.target.value === '' ? null : event.target.value,
                          ),
                        )
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
  );
}

/** Loads the workspace's maps once (for the pickers). */
export function useMapList(): { maps: readonly MapSummaryDto[] | null; error: string | null } {
  const [maps, setMaps] = useState<readonly MapSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.maps.list()).then(
      (result) => {
        if (!cancelled) setMaps(result.items);
      },
      (caught: unknown) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : 'Maps could not be loaded.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return { maps, error };
}
