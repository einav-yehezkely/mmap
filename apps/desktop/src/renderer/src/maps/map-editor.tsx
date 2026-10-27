/**
 * Editor for one map (PRD §5.6): toolbar, canvas and outline. All changes go through
 * `useMapDocument`, which sends them to the main process one at a time with the current revision.
 *
 * Opening an item opens its node in the shared detail panel, the same editor used everywhere
 * else (PRD §6); edits there show up on every map because maps only place nodes.
 */

import type { MapViewDto } from '@mmap/contracts';
import { ArrowLeft, GitFork, Move } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';

import { Button } from '../components/ui/button';
import { notifyNodesChanged } from '../nodes/node-events';
import { AddToMapDialog } from './add-to-map-dialog';
import { MapCanvas } from './map-canvas';
import { nextFreeformPosition, planKeyboardMove } from './map-model';
import { MapOutline } from './map-outline';
import { PLACEMENT_COLOR_OPTIONS, type PlacementColor } from './placement-colors';
import { SwitchToHierarchyDialog } from './switch-to-hierarchy-dialog';
import { useMapDocument } from './use-map-document';

export interface MapEditorProps {
  readonly mapId: string;
  readonly onBack: () => void;
  readonly onOpenNode: (nodeId: string) => void;
}

export function MapEditor({ mapId, onBack, onOpenNode }: MapEditorProps) {
  const document = useMapDocument(mapId);
  const { view } = document;

  if (view === null) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          All maps
        </Button>
        {document.loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {document.loadError}
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Opening map…
          </p>
        )}
      </div>
    );
  }
  return (
    <LoadedMapEditor view={view} document={document} onBack={onBack} onOpenNode={onOpenNode} />
  );
}

function LoadedMapEditor({
  view,
  document,
  onBack,
  onOpenNode,
}: {
  view: MapViewDto;
  document: ReturnType<typeof useMapDocument>;
  onBack: () => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const { apply } = document;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Open "add" dialog: `parentId` is the hierarchy parent (null = top level / freeform). */
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null);
  const [reviewingHierarchy, setReviewingHierarchy] = useState(false);
  const colorSelectId = useId();

  const selected = view.placements.find((placement) => placement.id === selectedId) ?? null;
  const isHierarchy = view.map.mode === 'hierarchical';
  const nodeIdsOnMap = useMemo(() => view.placements.map((placement) => placement.nodeId), [view]);

  const addPlacement = async (item: { nodeId: string } | { newNodeTitle: string }) => {
    const parentPlacementId = adding?.parentId ?? null;
    const position = nextFreeformPosition(view);
    const ok = await apply((mapId, expectedRevision) =>
      window.mmap.maps.addPlacement({
        mapId,
        expectedRevision,
        ...item,
        ...position,
        parentPlacementId,
      }),
    );
    if (ok) {
      setAdding(null);
      if ('newNodeTitle' in item) notifyNodesChanged();
    }
  };

  const onMove = useCallback(
    (changes: readonly { placementId: string; x: number; y: number }[]) =>
      void apply((mapId, expectedRevision) =>
        window.mmap.maps.movePlacements({ mapId, expectedRevision, changes: [...changes] }),
      ),
    [apply],
  );

  const onToggleCollapse = useCallback(
    (placementId: string, collapsed: boolean) =>
      void apply((mapId, expectedRevision) =>
        window.mmap.maps.setCollapsed({ mapId, expectedRevision, placementId, collapsed }),
      ),
    [apply],
  );

  const onRemove = useCallback(
    (placementIds: readonly string[], connectionIds: readonly string[]) => {
      for (const connectionId of connectionIds) {
        void apply((mapId, expectedRevision) =>
          window.mmap.maps.removeConnection({ mapId, expectedRevision, connectionId }),
        );
      }
      for (const placementId of placementIds) {
        void apply((mapId, expectedRevision) =>
          window.mmap.maps.removePlacement({ mapId, expectedRevision, placementId }),
        );
      }
      setSelectedId(null);
    },
    [apply],
  );

  const onConnect = useCallback(
    (sourcePlacementId: string, targetPlacementId: string) =>
      void apply((mapId, expectedRevision) =>
        window.mmap.maps.addConnection({
          mapId,
          expectedRevision,
          sourcePlacementId,
          targetPlacementId,
        }),
      ),
    [apply],
  );

  const switchToHierarchy = async (
    parents: readonly { placementId: string; parentPlacementId: string | null }[],
  ) => {
    const ok = await apply((mapId, expectedRevision) =>
      window.mmap.maps.switchMode({
        mapId,
        expectedRevision,
        mode: 'hierarchical',
        parents: [...parents],
      }),
    );
    if (ok) setReviewingHierarchy(false);
  };

  const switchToFreeform = () =>
    void apply((mapId, expectedRevision) =>
      window.mmap.maps.switchMode({ mapId, expectedRevision, mode: 'freeform' }),
    );

  return (
    <div className="flex h-full min-h-[520px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          All maps
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold" dir="auto">
          {view.map.title}
        </h1>
        <div role="group" aria-label="Map mode" className="flex rounded-md border p-0.5">
          <Button
            size="sm"
            variant={isHierarchy ? 'ghost' : 'outline'}
            aria-pressed={!isHierarchy}
            onClick={() => isHierarchy && switchToFreeform()}
          >
            <Move aria-hidden="true" />
            Freeform
          </Button>
          <Button
            size="sm"
            variant={isHierarchy ? 'outline' : 'ghost'}
            aria-pressed={isHierarchy}
            onClick={() => {
              if (!isHierarchy) {
                document.dismissChangeError();
                setReviewingHierarchy(true);
              }
            }}
          >
            <GitFork aria-hidden="true" />
            Hierarchy
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <label htmlFor={colorSelectId} className="text-sm text-muted-foreground">
            Color
          </label>
          <select
            id={colorSelectId}
            className="h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
            disabled={selected === null}
            value={selected?.color ?? ''}
            onChange={(event) => {
              if (selected === null) return;
              const color =
                event.target.value === '' ? null : (event.target.value as PlacementColor);
              void apply((mapId, expectedRevision) =>
                window.mmap.maps.setPlacementColor({
                  mapId,
                  expectedRevision,
                  placementId: selected.id,
                  color,
                }),
              );
            }}
          >
            <option value="">Default</option>
            {PLACEMENT_COLOR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {document.changeError && !reviewingHierarchy && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm"
        >
          <p className="flex-1 text-destructive">{document.changeError}</p>
          <Button size="sm" variant="ghost" onClick={document.dismissChangeError}>
            Dismiss
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1 rounded-md border">
          <MapCanvas
            view={view}
            selectedPlacementId={selectedId}
            onSelect={setSelectedId}
            onOpenNode={onOpenNode}
            onMove={onMove}
            onConnect={onConnect}
            onToggleCollapse={onToggleCollapse}
            onRemove={onRemove}
            onViewportChange={document.saveViewport}
          />
        </div>
        <aside className="flex w-72 shrink-0 flex-col gap-3">
          <MapOutline
            view={view}
            selectedPlacementId={selectedId}
            onSelect={setSelectedId}
            onOpenNode={onOpenNode}
            onMove={(placementId, direction) =>
              // Planned when the move runs, against the latest structure, so quick successive
              // moves build on each other instead of on the view shown when the key was pressed.
              void apply((mapId, expectedRevision, current) => {
                const target = planKeyboardMove(current, placementId, direction);
                return target === null
                  ? null
                  : window.mmap.maps.reparent({ mapId, expectedRevision, ...target });
              })
            }
            onToggleCollapse={onToggleCollapse}
            onAdd={(parentId) => setAdding({ parentId })}
            onRemove={(placementId) => onRemove([placementId], [])}
          />
          <MapLegend isHierarchy={isHierarchy} />
        </aside>
      </div>

      {adding !== null && (
        <AddToMapDialog
          parentTitle={
            adding.parentId === null
              ? null
              : (view.placements.find((placement) => placement.id === adding.parentId)?.nodeTitle ??
                null)
          }
          excludeNodeIds={nodeIdsOnMap}
          onAddExisting={(nodeId) => void addPlacement({ nodeId })}
          onCreateNew={(title) => void addPlacement({ newNodeTitle: title })}
          onClose={() => setAdding(null)}
        />
      )}
      {reviewingHierarchy && (
        <SwitchToHierarchyDialog
          view={view}
          submitError={document.changeError}
          onCancel={() => {
            setReviewingHierarchy(false);
            document.dismissChangeError();
          }}
          onConfirm={(parents) => void switchToHierarchy(parents)}
        />
      )}
    </div>
  );
}

/** Explains the two kinds of lines (PRD §14: keep visual structure and meaning distinct). */
function MapLegend({ isHierarchy }: { isHierarchy: boolean }) {
  return (
    <div className="space-y-1 rounded-md border p-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">On this map</p>
      {isHierarchy && (
        <p>
          <span aria-hidden="true">── </span>Solid lines: hierarchy. It organizes this map only and
          does not create relationships.
        </p>
      )}
      <p>
        <span aria-hidden="true">- → </span>Dashed arrows: map connectors. They are visual only; a
        type in brackets means the connector shows an existing relationship.
      </p>
      <p>
        {isHierarchy
          ? 'Use the outline to add, reorder, indent and outdent items.'
          : 'Drag from the right edge of an item to another item to draw a connector. Double-click an item to open it.'}
      </p>
    </div>
  );
}
