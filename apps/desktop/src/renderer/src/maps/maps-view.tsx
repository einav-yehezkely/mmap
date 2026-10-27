/**
 * Mind Maps area (PRD §5.6): the list of maps (create, rename, duplicate, delete) and the editor
 * for the open map. Deleting a map removes only the map; its nodes stay in the library (PRD §13
 * acceptance criterion 8), and the confirmation says so.
 */

import type { MapSummaryDto } from '@mmap/contracts';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { FormDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { formatDateTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import { MapEditor } from './map-editor';

type MapMode = MapSummaryDto['mode'];

export interface MapsViewProps {
  readonly timeZone: string;
  readonly onOpenNode: (nodeId: string) => void;
}

export function MapsView({ timeZone, onOpenNode }: MapsViewProps) {
  const [openMapId, setOpenMapId] = useState<string | null>(null);
  if (openMapId !== null) {
    return (
      <MapEditor
        key={openMapId}
        mapId={openMapId}
        onBack={() => setOpenMapId(null)}
        onOpenNode={onOpenNode}
      />
    );
  }
  return <MapList timeZone={timeZone} onOpenMap={setOpenMapId} />;
}

function MapList({
  timeZone,
  onOpenMap,
}: {
  timeZone: string;
  onOpenMap: (mapId: string) => void;
}) {
  const [maps, setMaps] = useState<readonly MapSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<MapSummaryDto | null>(null);
  const [deleting, setDeleting] = useState<MapSummaryDto | null>(null);

  const reload = useCallback(async () => {
    setMaps((await unwrap(window.mmap.maps.list())).items);
  }, []);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.maps.list()).then(
      ({ items }) => {
        if (!cancelled) setMaps(items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      // Shows the current state (for example after a conflict), so a retry uses it.
      reload().catch(() => undefined);
      return false;
    }
  };

  return (
    <section aria-labelledby="maps-heading" className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 id="maps-heading" className="flex-1 text-2xl font-semibold tracking-tight">
          Mind Maps
        </h1>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          New map
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Maps arrange nodes from your library. A node can appear on many maps; its title and note are
        the same everywhere.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {maps === null && error === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading maps…
        </p>
      )}
      {maps !== null && maps.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No maps yet. Create one to start arranging your nodes.
        </p>
      )}
      {maps !== null && maps.length > 0 && (
        <ul className="divide-y rounded-md border">
          {maps.map((map) => (
            <li key={map.id} className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => onOpenMap(map.id)}
              >
                <span className="block truncate font-medium" dir="auto">
                  {map.title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {map.mode === 'hierarchical' ? 'Hierarchy' : 'Freeform'} ·{' '}
                  {map.placementCount === 1 ? '1 item' : `${map.placementCount} items`} · Updated{' '}
                  {formatDateTime(map.updatedAt, timeZone)}
                </span>
              </button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Rename ${map.title}`}
                title="Rename"
                onClick={() => setRenaming(map)}
              >
                <Pencil aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Duplicate ${map.title}`}
                title="Duplicate"
                onClick={() =>
                  void run(() => unwrap(window.mmap.maps.duplicate({ mapId: map.id })))
                }
              >
                <Copy aria-hidden="true" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${map.title}`}
                title="Delete"
                onClick={() => setDeleting(map)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateMapDialog
          onClose={() => setCreating(false)}
          onCreate={async (title, mode) => {
            let createdId: string | null = null;
            const ok = await run(async () => {
              createdId = (await unwrap(window.mmap.maps.create({ title, mode }))).map.id;
            });
            if (ok && createdId !== null) {
              setCreating(false);
              onOpenMap(createdId);
            }
          }}
        />
      )}
      {renaming && (
        <RenameMapDialog
          map={renaming}
          onClose={() => setRenaming(null)}
          onRename={async (title) => {
            const ok = await run(() =>
              // The revision shown in the list: if the map changed since, the rename is refused
              // with a conflict instead of silently overwriting the other change.
              unwrap(
                window.mmap.maps.rename({
                  mapId: renaming.id,
                  expectedRevision: renaming.revision,
                  title,
                }),
              ),
            );
            if (ok) setRenaming(null);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.title ?? ''}”?`}
        confirmLabel="Delete map"
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) void run(() => unwrap(window.mmap.maps.delete({ mapId: target.id })));
        }}
      >
        <p>
          The map and its layout and connectors are deleted. The{' '}
          {deleting?.placementCount === 1 ? 'node' : `${deleting?.placementCount ?? 0} nodes`} on it
          stay in your library, with their notes, tags and relationships.
        </p>
      </ConfirmDialog>
    </section>
  );
}

function CreateMapDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (title: string, mode: MapMode) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<MapMode>('freeform');
  const titleId = useId();
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New map"
      submitLabel="Create map"
      submitDisabled={title.trim() === ''}
      onSubmit={() => void onCreate(title, mode)}
    >
      <div className="space-y-1">
        <label htmlFor={titleId} className="text-sm">
          Title
        </label>
        <Input
          id={titleId}
          autoFocus
          dir="auto"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm">Layout</legend>
        {(
          [
            ['freeform', 'Freeform', 'Place items anywhere and draw connectors.'],
            ['hierarchical', 'Hierarchy', 'Arrange items as an outline with automatic layout.'],
          ] as const
        ).map(([value, label, description]) => (
          <label key={value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="map-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
              className="mt-1"
            />
            <span>
              {label}
              <span className="block text-xs text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}

function RenameMapDialog({
  map,
  onClose,
  onRename,
}: {
  map: MapSummaryDto;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(map.title);
  const titleId = useId();
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Rename map"
      submitLabel="Rename"
      submitDisabled={title.trim() === ''}
      onSubmit={() => void onRename(title)}
    >
      <div className="space-y-1">
        <label htmlFor={titleId} className="text-sm">
          Title
        </label>
        <Input
          id={titleId}
          autoFocus
          dir="auto"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
    </FormDialog>
  );
}
