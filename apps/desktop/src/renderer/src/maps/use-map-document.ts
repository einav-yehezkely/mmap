/**
 * State of one open map in the renderer.
 *
 * The main process owns the map; this hook keeps the last view it returned. Structural changes
 * run one at a time through a queue, and each one sends the revision from the latest view, so
 * quick successive edits (dragging two items, then reordering) never conflict with each other.
 * A `REVISION_CONFLICT` means the map changed elsewhere: the map is reloaded and the user is told
 * that the last change was not applied (PRD §14 "user-visible resolution flow").
 *
 * The viewport is visual state: it is saved after panning or zooming stops, without a revision.
 */

import type { IpcResult, MapViewDto } from '@mmap/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage, IpcFailure, unwrap } from '../lib/ipc';
import { useNodesChanged } from '../nodes/node-events';

const VIEWPORT_SAVE_DELAY_MS = 600;

/**
 * A structural change. It runs when its turn in the queue comes and receives the map as it is
 * then (ID, revision and the whole view), so changes that depend on the current structure, such
 * as keyboard moves, are planned against the same state they are applied to. Returning null
 * means there is nothing to do (for example, the first item cannot move up).
 */
export type MapChange = (
  mapId: string,
  expectedRevision: number,
  current: MapViewDto,
) => Promise<IpcResult<MapViewDto>> | null;

export interface MapDocument {
  readonly view: MapViewDto | null;
  readonly loadError: string | null;
  /** Problem with the last change, shown until the next change or dismissal. */
  readonly changeError: string | null;
  readonly dismissChangeError: () => void;
  /** Queues a structural change; resolves to true when it was applied. */
  readonly apply: (change: MapChange) => Promise<boolean>;
  readonly saveViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  readonly reload: () => Promise<void>;
}

export function useMapDocument(mapId: string): MapDocument {
  const [view, setView] = useState<MapViewDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const latest = useRef<MapViewDto | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingViewport = useRef<{ x: number; y: number; zoom: number } | null>(null);

  const show = useCallback((next: MapViewDto) => {
    latest.current = next;
    setView(next);
  }, []);

  const reload = useCallback(async () => {
    try {
      show(await unwrap(window.mmap.maps.get({ mapId })));
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorMessage(caught));
    }
  }, [mapId, show]);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.maps.get({ mapId })).then(
      (loaded) => {
        if (!cancelled) show(loaded);
      },
      (caught: unknown) => {
        if (!cancelled) setLoadError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mapId, show]);

  // Node titles are shown on the map; re-query when nodes change anywhere in the app. Queued
  // behind pending changes so a reload never overwrites a newer result.
  const onNodesChanged = useCallback(() => {
    queue.current = queue.current.then(reload);
  }, [reload]);
  useNodesChanged(onNodesChanged);

  const apply = useCallback(
    (change: MapChange): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const current = latest.current;
        if (current === null) return false;
        const call = change(current.map.id, current.map.revision, current);
        if (call === null) return false;
        setChangeError(null);
        try {
          show(await unwrap(call));
          return true;
        } catch (caught) {
          if (caught instanceof IpcFailure && caught.code === 'REVISION_CONFLICT') {
            await reload();
            setChangeError(
              'This map was changed elsewhere, so your last change was not applied. The latest version is shown; please try again.',
            );
          } else {
            setChangeError(errorMessage(caught));
          }
          return false;
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result;
      return result;
    },
    [reload, show],
  );

  const flushViewport = useCallback(() => {
    if (viewportTimer.current !== null) clearTimeout(viewportTimer.current);
    viewportTimer.current = null;
    const viewport = pendingViewport.current;
    pendingViewport.current = null;
    // Failure to remember the viewport is not worth interrupting the user for.
    if (viewport !== null) void window.mmap.maps.setViewport({ mapId, viewport });
  }, [mapId]);

  const saveViewport = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      pendingViewport.current = viewport;
      if (viewportTimer.current !== null) clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(flushViewport, VIEWPORT_SAVE_DELAY_MS);
    },
    [flushViewport],
  );

  // Leaving the map saves a viewport change that is still waiting for its delay.
  useEffect(() => flushViewport, [flushViewport]);

  return {
    view,
    loadError,
    changeError,
    dismissChangeError: () => setChangeError(null),
    apply,
    saveViewport,
    reload,
  };
}
