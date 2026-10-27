/**
 * Node panel › Mind maps: the maps that show this node (each opens the map) and "Add to mind
 * maps…", which places the node on further maps (PRD §5.6: one canonical node, reused on any
 * number of maps). Adding never copies the node; every map shows the same node, and its
 * relationships with nodes already on a map appear there.
 */

import type { IpcResponse } from '@mmap/contracts';
import { Plus, Workflow } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { FormDialog } from '../components/ui/dialog';
import { errorMessage, unwrap } from '../lib/ipc';
import { MapTargetsPicker, useMapList, type MapTargets } from '../maps/map-targets-picker';
import { notifyNodesChanged, useNodesChanged } from './node-events';

type MapsOfNode = IpcResponse<'maps:list-for-node'>['items'];

export interface NodeMapsProps {
  readonly nodeId: string;
  readonly nodeTitle: string;
  /** Opens a map in the Mind Maps view; the list shows plain names when not given. */
  readonly onOpenMap?: (mapId: string) => void;
}

export function NodeMaps({ nodeId, nodeTitle, onOpenMap }: NodeMapsProps) {
  const [items, setItems] = useState<MapsOfNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.maps.listForNode({ nodeId })).then(
      (result) => {
        if (!cancelled) setItems(result.items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, reloadToken]);

  // Placements change on maps too (added or removed there); keep the list current.
  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  const headingId = `node-maps-${nodeId}`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          Mind maps
        </h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          Add to mind maps…
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="text-sm text-muted-foreground">This node is not on any mind map yet.</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((map) => (
            <li key={map.id}>
              {onOpenMap === undefined ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm">
                  <Workflow aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  <span dir="auto">{map.title}</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenMap(map.id)}
                  title="Open this map"
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Workflow aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  <span dir="auto">{map.title}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddToMapsDialog
          nodeId={nodeId}
          nodeTitle={nodeTitle}
          alreadyOn={new Set((items ?? []).map((map) => map.id))}
          onClose={() => setAdding(false)}
          onAdded={(next) => {
            setItems(next);
            setAdding(false);
            // Open maps reload and show the node (and its relationships) right away.
            notifyNodesChanged();
          }}
        />
      )}
    </section>
  );
}

function AddToMapsDialog({
  nodeId,
  nodeTitle,
  alreadyOn,
  onClose,
  onAdded,
}: {
  nodeId: string;
  nodeTitle: string;
  alreadyOn: ReadonlySet<string>;
  onClose: () => void;
  onAdded: (maps: MapsOfNode) => void;
}) {
  const { maps, error: mapsError } = useMapList();
  const [chosen, setChosen] = useState<MapTargets>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const available = (maps ?? []).filter((map) => !alreadyOn.has(map.id)).length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await unwrap(
        window.mmap.maps.addNode({
          nodeId,
          targets: [...chosen].map(([mapId, parentPlacementId]) => ({ mapId, parentPlacementId })),
        }),
      );
      onAdded(result.items);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  const shownError = error ?? mapsError;
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Add “${nodeTitle}” to mind maps`}
      description="The same node appears on every map you choose; editing it updates them all."
      submitLabel={
        chosen.size === 0 ? 'Add' : `Add to ${chosen.size === 1 ? '1 map' : `${chosen.size} maps`}`
      }
      submitDisabled={busy || chosen.size === 0}
      onSubmit={() => void submit()}
    >
      <MapTargetsPicker
        legend="Mind maps"
        maps={maps}
        chosen={chosen}
        onChange={setChosen}
        alreadyOn={alreadyOn}
      />
      {maps !== null && maps.length > 0 && available === 0 && (
        <p className="text-sm text-muted-foreground">This node is already on every map.</p>
      )}
      {shownError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      )}
    </FormDialog>
  );
}
