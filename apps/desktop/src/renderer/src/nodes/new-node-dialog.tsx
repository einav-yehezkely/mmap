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

import { useId, useState } from 'react';

import { FormDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { MapTargetsPicker, useMapList, type MapTargets } from '../maps/map-targets-picker';
import { notifyNodesChanged } from './node-events';

export interface NewNodeDialogProps {
  /** Map to preselect, when the dialog was opened from inside that map. */
  readonly preselectedMapId: string | null;
  readonly onCreated: (nodeId: string) => void;
  readonly onClose: () => void;
}

export function NewNodeDialog({ preselectedMapId, onCreated, onClose }: NewNodeDialogProps) {
  const [title, setTitle] = useState('');
  const { maps, error: mapsError } = useMapList();
  const [chosen, setChosen] = useState<MapTargets>(
    () => new Map(preselectedMapId === null ? [] : [[preselectedMapId, null]]),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

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

  const shownError = error ?? mapsError;
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="New node"
      description="A node is one idea. You can add it to mind maps now, or later from the node panel or any map."
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
      <MapTargetsPicker
        legend="Add to Mind Maps (optional)"
        maps={maps}
        chosen={chosen}
        onChange={setChosen}
      />
      {maps !== null && maps.length === 0 && (
        <p className="text-xs text-muted-foreground">The node will be in the Library.</p>
      )}
      {shownError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      )}
    </FormDialog>
  );
}
