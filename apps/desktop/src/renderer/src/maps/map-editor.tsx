/**
 * Editor for one map (PRD §5.6): toolbar, canvas and outline. All changes go through
 * `useMapDocument`, which sends them to the main process one at a time with the current revision.
 *
 * Opening an item opens its node in the shared detail panel, the same editor used everywhere
 * else (PRD §6); edits there show up on every map because maps only place nodes.
 *
 * Connector changes (drawing, removing, moving an end), region changes (adding, moving, resizing,
 * renaming, coloring, removing) and automatic layouts can be undone: a notice with "Undo" appears
 * after each one, and Ctrl+Z undoes them one by one, most recent first.
 *
 * Regions group items by subject on freeform maps: "Add region" puts one around the selected
 * items, or in the middle of the view when nothing is selected.
 *
 * Freeform maps have "Auto layout" (ADR-0012): it arranges the items by their connections in the
 * chosen direction only when asked, never after an edit; locked items stay where they are.
 */

import type { MapViewDto } from '@mmap/contracts';
import {
  ArrowLeft,
  GitFork,
  LayoutDashboard,
  Lock,
  LockOpen,
  Move,
  SquareDashed,
  Undo2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { Button } from '../components/ui/button';
import { notifyNodesChanged } from '../nodes/node-events';
import { AddToMapDialog } from './add-to-map-dialog';
import type { LayoutDirection } from './auto-layout';
import { MapCanvas, type RegionChange } from './map-canvas';
import { nextFreeformPosition, planKeyboardMove } from './map-model';
import { MapOutline } from './map-outline';
import { PLACEMENT_COLOR_OPTIONS, type PlacementColor } from './placement-colors';
import { SwitchToHierarchyDialog } from './switch-to-hierarchy-dialog';
import { useMapDocument } from './use-map-document';

/** What is needed to draw a connector again. */
interface ConnectorSnapshot {
  readonly sourcePlacementId: string;
  readonly targetPlacementId: string;
  readonly label: string | null;
  readonly relationshipId: string | null;
}

/** What is needed to put a region back. */
interface RegionSnapshot {
  readonly title: string;
  readonly color: PlacementColor | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Position = { readonly placementId: string; readonly x: number; readonly y: number };

/** A change that can be undone. */
type MapChange =
  | { readonly kind: 'region-added'; readonly regionId: string }
  | { readonly kind: 'region-removed'; readonly regionId: string; readonly region: RegionSnapshot }
  | {
      readonly kind: 'region-changed';
      readonly regionId: string;
      readonly previous: RegionSnapshot;
      /** Where the items carried along were before. */
      readonly moves: readonly Position[];
    }
  | { readonly kind: 'added'; readonly connectionId: string }
  | { readonly kind: 'removed'; readonly connectors: readonly ConnectorSnapshot[] }
  | { readonly kind: 'moved'; readonly connectionId: string; readonly previous: ConnectorSnapshot }
  | { readonly kind: 'noted'; readonly connectionId: string; readonly previous: string | null }
  | { readonly kind: 'linked'; readonly connectionId: string; readonly previous: string | null }
  | {
      readonly kind: 'arranged';
      readonly previous: readonly Position[];
      readonly previousRegions: readonly RegionChange[];
    };

const UNDO_LIMIT = 20;
/** How long the "Undo" notice stays; Ctrl+Z keeps working afterwards. */
const UNDO_NOTICE_MS = 10_000;

const CHANGE_TEXT: Record<MapChange['kind'], string> = {
  'region-added': 'Region added.',
  'region-removed': 'Region removed.',
  'region-changed': 'Region changed.',
  added: 'Connector added.',
  removed: 'Connector removed.',
  moved: 'Connector moved.',
  noted: 'Connector note saved.',
  linked: 'Connector link changed.',
  arranged: 'Map arranged.',
};

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
  const directionSelectId = useId();
  const [direction, setDirection] = useState<LayoutDirection>('right');
  /** Each click on "Auto layout" is a new request for the canvas. */
  const [layoutRequest, setLayoutRequest] = useState<{
    readonly id: number;
    readonly direction: LayoutDirection;
  } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  /** The region selected on the canvas (only when no item is selected). */
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  /** Each click on "Add region" is a new request for the canvas. */
  const [regionRequest, setRegionRequest] = useState<{ readonly id: number } | null>(null);
  /** The region the user just added; its title opens for editing. */
  const [newRegionId, setNewRegionId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<readonly MapChange[]>([]);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const remember = useCallback((change: MapChange) => {
    setUndoStack((stack) => [...stack.slice(-(UNDO_LIMIT - 1)), change]);
    setNoticeVisible(true);
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNoticeVisible(false), UNDO_NOTICE_MS);
  }, []);

  /** Draws a connector; resolves with its ID, or null when it was not added. */
  const createConnector = useCallback(
    async (connector: ConnectorSnapshot): Promise<string | null> => {
      let createdId: string | null = null;
      const ok = await apply(async (mapId, expectedRevision, current) => {
        const result = await window.mmap.maps.addConnection({
          mapId,
          expectedRevision,
          ...connector,
        });
        if (result.ok) {
          createdId =
            result.data.connections.find(
              (connection) => !current.connections.some((old) => old.id === connection.id),
            )?.id ?? null;
        }
        return result;
      });
      return ok ? createdId : null;
    },
    [apply],
  );

  const deleteConnector = useCallback(
    (connectionId: string) =>
      apply((mapId, expectedRevision) =>
        window.mmap.maps.removeConnection({ mapId, expectedRevision, connectionId }),
      ),
    [apply],
  );

  const writeConnectorNote = useCallback(
    (connectionId: string, label: string | null) =>
      apply((mapId, expectedRevision) =>
        window.mmap.maps.setConnectionLabel({ mapId, expectedRevision, connectionId, label }),
      ),
    [apply],
  );

  const linkConnector = useCallback(
    (connectionId: string, relationshipId: string | null) =>
      apply((mapId, expectedRevision) =>
        window.mmap.maps.setConnectionRelationship({
          mapId,
          expectedRevision,
          connectionId,
          relationshipId,
        }),
      ),
    [apply],
  );

  const snapshotOf = (connectionId: string): ConnectorSnapshot | null => {
    const connection = view.connections.find((item) => item.id === connectionId);
    return connection === undefined
      ? null
      : {
          sourcePlacementId: connection.sourcePlacementId,
          targetPlacementId: connection.targetPlacementId,
          label: connection.label,
          relationshipId: connection.relationshipId,
        };
  };

  const snapshotOfRegion = (regionId: string): RegionSnapshot | null => {
    const region = view.regions.find((item) => item.id === regionId);
    return region === undefined
      ? null
      : {
          title: region.title,
          color: region.color,
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        };
  };

  /** Adds a region; resolves with its ID, or null when it was not added. */
  const createRegion = useCallback(
    async (region: RegionSnapshot): Promise<string | null> => {
      let createdId: string | null = null;
      const ok = await apply(async (mapId, expectedRevision, current) => {
        const result = await window.mmap.maps.addRegion({ mapId, expectedRevision, ...region });
        if (result.ok) {
          createdId =
            result.data.regions.find((item) => !current.regions.some((old) => old.id === item.id))
              ?.id ?? null;
        }
        return result;
      });
      return ok ? createdId : null;
    },
    [apply],
  );

  const changeRegion = useCallback(
    (regionId: string, changes: Partial<RegionSnapshot>, moves: readonly Position[]) =>
      apply((mapId, expectedRevision, current) =>
        window.mmap.maps.updateRegion({
          mapId,
          expectedRevision,
          regionId,
          changes,
          // Only items still on the map (one removed since would fail the change).
          moves: moves.filter((move) =>
            current.placements.some((placement) => placement.id === move.placementId),
          ),
        }),
      ),
    [apply],
  );

  const deleteRegion = useCallback(
    (regionId: string) =>
      apply((mapId, expectedRevision) =>
        window.mmap.maps.removeRegion({ mapId, expectedRevision, regionId }),
      ),
    [apply],
  );

  /** Reverses the most recent change. */
  const undo = useCallback(async () => {
    const change = undoStack.at(-1);
    if (change === undefined) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setNoticeVisible(false);
    switch (change.kind) {
      case 'region-added':
        await deleteRegion(change.regionId);
        break;
      case 'region-removed': {
        const restored = await createRegion(change.region);
        // The region comes back with a new ID; older entries about it follow.
        if (restored !== null) {
          setUndoStack((stack) =>
            stack.map((entry) =>
              'regionId' in entry && entry.regionId === change.regionId
                ? { ...entry, regionId: restored }
                : entry,
            ),
          );
        }
        break;
      }
      case 'region-changed':
        await changeRegion(change.regionId, change.previous, change.moves);
        break;
      case 'added':
        await deleteConnector(change.connectionId);
        break;
      case 'removed':
        for (const connector of change.connectors) await createConnector(connector);
        break;
      case 'moved':
        if (await deleteConnector(change.connectionId)) await createConnector(change.previous);
        break;
      case 'noted':
        await writeConnectorNote(change.connectionId, change.previous);
        break;
      case 'linked':
        await linkConnector(change.connectionId, change.previous);
        break;
      case 'arranged': {
        // Regions go back first, the first one carrying the items; without regions the items
        // move back on their own. Only items still on the map are moved.
        const [first, ...others] = change.previousRegions;
        if (first === undefined) {
          await apply((mapId, expectedRevision, current) =>
            window.mmap.maps.movePlacements({
              mapId,
              expectedRevision,
              changes: change.previous.filter((move) =>
                current.placements.some((placement) => placement.id === move.placementId),
              ),
            }),
          );
          break;
        }
        const bounds = (region: RegionChange) => ({
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        });
        await changeRegion(first.regionId, bounds(first), change.previous);
        for (const region of others) await changeRegion(region.regionId, bounds(region), []);
        break;
      }
    }
  }, [
    undoStack,
    createConnector,
    deleteConnector,
    writeConnectorNote,
    linkConnector,
    createRegion,
    changeRegion,
    deleteRegion,
    apply,
  ]);

  /** Ctrl+Z anywhere in the editor, except while typing in a field. */
  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.shiftKey) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return;
    if (undoStack.length === 0) return;
    event.preventDefault();
    void undo();
  };

  const selected = view.placements.find((placement) => placement.id === selectedId) ?? null;
  const selectedRegion =
    selected === null
      ? (view.regions.find((region) => region.id === selectedRegionId) ?? null)
      : null;
  const isHierarchy = view.map.mode === 'hierarchical';
  const placementOfNode = useMemo(
    () => new Map(view.placements.map((placement) => [placement.nodeId, placement.id])),
    [view],
  );

  /** Moves an item that is already on the map under `parentId`, as its last child. */
  const moveUnder = async (placementId: string, parentId: string) => {
    const index = view.placements.filter(
      (placement) => placement.parentPlacementId === parentId && placement.id !== placementId,
    ).length;
    const ok = await apply((mapId, expectedRevision) =>
      window.mmap.maps.reparent({
        mapId,
        expectedRevision,
        placementId,
        parentPlacementId: parentId,
        index,
      }),
    );
    if (ok) setAdding(null);
  };

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

  const onRemove = (placementIds: readonly string[], connectionIds: readonly string[]) => {
    const removed = connectionIds
      .map(snapshotOf)
      .filter((connector): connector is ConnectorSnapshot => connector !== null);
    void (async () => {
      let allRemoved = true;
      for (const connectionId of connectionIds) {
        allRemoved = (await deleteConnector(connectionId)) && allRemoved;
      }
      if (removed.length > 0 && allRemoved) remember({ kind: 'removed', connectors: removed });
    })();
    for (const placementId of placementIds) {
      void apply((mapId, expectedRevision) =>
        window.mmap.maps.removePlacement({ mapId, expectedRevision, placementId }),
      );
    }
    if (placementIds.length > 0) setSelectedId(null);
  };

  const onConnect = (sourcePlacementId: string, targetPlacementId: string) =>
    void createConnector({
      sourcePlacementId,
      targetPlacementId,
      label: null,
      relationshipId: null,
    }).then((connectionId) => {
      if (connectionId !== null) remember({ kind: 'added', connectionId });
    });

  /**
   * Moves a connector's end to another item: the old connector is replaced by one with the same
   * label. A link to a relationship is kept only while the connector still joins the same nodes.
   */
  const onReconnect = (
    connectionId: string,
    sourcePlacementId: string,
    targetPlacementId: string,
  ) => {
    const previous = snapshotOf(connectionId);
    if (previous === null) return;
    const nodeOf = (placementId: string) =>
      view.placements.find((placement) => placement.id === placementId)?.nodeId;
    const sameNodes =
      new Set([nodeOf(sourcePlacementId), nodeOf(targetPlacementId)]).size === 2 &&
      [nodeOf(sourcePlacementId), nodeOf(targetPlacementId)].every((node) =>
        [nodeOf(previous.sourcePlacementId), nodeOf(previous.targetPlacementId)].includes(node),
      );
    void (async () => {
      if (!(await deleteConnector(connectionId))) return;
      const createdId = await createConnector({
        sourcePlacementId,
        targetPlacementId,
        label: previous.label,
        relationshipId: sameNodes ? previous.relationshipId : null,
      });
      if (createdId !== null) remember({ kind: 'moved', connectionId: createdId, previous });
      else await createConnector(previous);
    })();
  };

  const onConnectorLabel = (connectionId: string, label: string | null) => {
    const previous = view.connections.find((item) => item.id === connectionId)?.label ?? null;
    void writeConnectorNote(connectionId, label).then((ok) => {
      if (ok) remember({ kind: 'noted', connectionId, previous });
    });
  };

  const onConnectorRelationship = (connectionId: string, relationshipId: string | null) => {
    const previous =
      view.connections.find((item) => item.id === connectionId)?.relationshipId ?? null;
    void linkConnector(connectionId, relationshipId).then((ok) => {
      if (ok) remember({ kind: 'linked', connectionId, previous });
    });
  };

  /**
   * Saves an automatic layout (positions and routes) in one request; Undo puts every item back,
   * and the stored routes then no longer match, so lines return to curves.
   */
  const onArranged = (
    arrangement: NonNullable<MapViewDto['map']['arrangement']>,
    previous: readonly Position[],
    regions: readonly RegionChange[],
    previousRegions: readonly RegionChange[],
  ) => {
    void apply((mapId, expectedRevision) =>
      window.mmap.maps.saveArrangement({
        mapId,
        expectedRevision,
        arrangement,
        ...(regions.length > 0 ? { regions: [...regions] } : {}),
      }),
    ).then((ok) => {
      if (ok) remember({ kind: 'arranged', previous, previousRegions });
    });
  };

  const onAddRegion = useCallback(
    (bounds: { x: number; y: number; width: number; height: number }) =>
      void createRegion({ title: 'New region', color: null, ...bounds }).then((regionId) => {
        if (regionId === null) return;
        setNewRegionId(regionId);
        remember({ kind: 'region-added', regionId });
      }),
    [createRegion, remember],
  );

  const onRegionChange = (
    regionId: string,
    changes: Partial<RegionSnapshot>,
    moves: readonly Position[],
  ) => {
    const previous = snapshotOfRegion(regionId);
    if (previous === null) return;
    const before = moves.flatMap((move) => {
      const placement = view.placements.find((item) => item.id === move.placementId);
      return placement === undefined
        ? []
        : [{ placementId: placement.id, x: placement.x, y: placement.y }];
    });
    void changeRegion(regionId, changes, moves).then((ok) => {
      if (ok) remember({ kind: 'region-changed', regionId, previous, moves: before });
    });
  };

  const onRemoveRegion = (regionId: string) => {
    const region = snapshotOfRegion(regionId);
    if (region === null) return;
    void deleteRegion(regionId).then((ok) => {
      if (!ok) return;
      if (selectedRegionId === regionId) setSelectedRegionId(null);
      remember({ kind: 'region-removed', regionId, region });
    });
  };

  const setPinned = (placementId: string, pinned: boolean) =>
    void apply((mapId, expectedRevision) =>
      window.mmap.maps.setPlacementPinned({ mapId, expectedRevision, placementId, pinned }),
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
    <div
      className="@container flex h-full min-h-[520px] flex-col gap-3"
      onKeyDown={onEditorKeyDown}
    >
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
            disabled={selected === null && selectedRegion === null}
            title={
              selectedRegion !== null
                ? 'Color of the selected region'
                : 'Color of the selected item'
            }
            value={(selected ?? selectedRegion)?.color ?? ''}
            onChange={(event) => {
              const color =
                event.target.value === '' ? null : (event.target.value as PlacementColor);
              if (selectedRegion !== null) {
                onRegionChange(selectedRegion.id, { color }, []);
                return;
              }
              if (selected === null) return;
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
        {!isHierarchy && (
          <Button
            size="sm"
            variant="ghost"
            title="Add a region around the selected items (or in the middle of the view), to group them by subject"
            onClick={() => setRegionRequest((current) => ({ id: (current?.id ?? 0) + 1 }))}
          >
            <SquareDashed aria-hidden="true" />
            Add region
          </Button>
        )}
        {!isHierarchy && (
          <div role="group" aria-label="Automatic layout" className="flex items-center gap-1">
            <Button
              size="sm"
              variant={selected?.pinned === true ? 'outline' : 'ghost'}
              aria-pressed={selected?.pinned === true}
              disabled={selected === null}
              title="Locked items keep their place when the map is arranged automatically"
              onClick={() => selected !== null && setPinned(selected.id, !selected.pinned)}
            >
              {selected?.pinned === true ? (
                <Lock aria-hidden="true" />
              ) : (
                <LockOpen aria-hidden="true" />
              )}
              {selected?.pinned === true ? 'Locked' : 'Lock'}
            </Button>
            <label htmlFor={directionSelectId} className="sr-only">
              Layout direction
            </label>
            <select
              id={directionSelectId}
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={direction}
              onChange={(event) => setDirection(event.target.value as LayoutDirection)}
            >
              <option value="right">Left to right</option>
              <option value="down">Top to bottom</option>
              <option value="left">Right to left</option>
              <option value="up">Bottom to top</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={view.placements.length < 2}
              title="Arrange the items by their connections. Locked items stay; Ctrl+Z undoes it."
              onClick={() => {
                setLayoutError(null);
                setLayoutRequest((current) => ({ id: (current?.id ?? 0) + 1, direction }));
              }}
            >
              <LayoutDashboard aria-hidden="true" />
              Auto layout
            </Button>
          </div>
        )}
      </div>

      {layoutError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {layoutError}
        </p>
      )}

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

      {/* When a panel beside the map leaves it narrow, the outline moves below the canvas. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 @3xl:flex-row">
        <div className="relative min-h-80 min-w-0 flex-1 rounded-md border">
          {noticeVisible && undoStack.length > 0 && (
            <div
              role="status"
              className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm shadow-md"
            >
              <span>{CHANGE_TEXT[undoStack.at(-1)!.kind]}</span>
              <Button size="sm" variant="outline" onClick={() => void undo()}>
                <Undo2 aria-hidden="true" />
                Undo
              </Button>
              <span className="text-xs text-muted-foreground">Ctrl+Z</span>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => setNoticeVisible(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          )}
          <MapCanvas
            view={view}
            selectedPlacementId={selectedId}
            onSelect={setSelectedId}
            onOpenNode={onOpenNode}
            onMove={onMove}
            onConnect={onConnect}
            onToggleCollapse={onToggleCollapse}
            onRemove={onRemove}
            onReconnect={onReconnect}
            onConnectorLabel={onConnectorLabel}
            onConnectorRelationship={onConnectorRelationship}
            layoutRequest={layoutRequest}
            onArranged={onArranged}
            onLayoutFailed={setLayoutError}
            onViewportChange={document.saveViewport}
            onSelectRegion={setSelectedRegionId}
            regionRequest={regionRequest}
            onAddRegion={onAddRegion}
            onRegionChange={onRegionChange}
            onRemoveRegion={onRemoveRegion}
            newRegionId={newRegionId}
          />
        </div>
        <aside className="flex w-full shrink-0 flex-col gap-3 @3xl:w-72">
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
          mapId={view.map.id}
          moveTargets={
            adding.parentId === null
              ? null
              : {
                  placementOfNode,
                  parentNodeId:
                    view.placements.find((placement) => placement.id === adding.parentId)?.nodeId ??
                    '',
                }
          }
          onMoveExisting={(placementId) =>
            adding.parentId !== null && void moveUnder(placementId, adding.parentId)
          }
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

/**
 * What the lines mean and how to edit them (PRD §14: keep visual structure and meaning distinct).
 * Collapsed by default, like the keyboard shortcuts, so the outline keeps the space.
 */
function MapLegend({ isHierarchy }: { isHierarchy: boolean }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">How this map works</summary>
      <ul className="mt-1 space-y-1">
        {isHierarchy && (
          <li>
            <span aria-hidden="true">└─ </span>Gray lines connect an item to the items placed under
            it.
          </li>
        )}
        <li>
          <span aria-hidden="true">- → </span>Dashed arrows are lines you drew here yourself. Other
          maps don&apos;t show them.
        </li>
        <li>
          <span aria-hidden="true" className="text-[var(--relationship-line)]">
            ⌒{' '}
          </span>
          Colored lines are relationships between notes (like &ldquo;depends on&rdquo;). Every map
          with both notes shows them; change them in the note.
        </li>
        {isHierarchy ? (
          <li>Use the outline to add, move and indent items.</li>
        ) : (
          <>
            <li>Drag from an item's dot to another item to connect them.</li>
            <li>
              Click a connector to write a note on it, remove it (× or Delete), or drag its round
              end to move it.
            </li>
            <li>
              Add region draws a named area around the selected items. Items inside move with it;
              drag an item in or out to change its region. Double-click a region&apos;s name to
              rename it.
            </li>
            <li>
              Ctrl+Z undoes connector, region and layout changes. Double-click an item to preview
              its note.
            </li>
          </>
        )}
      </ul>
    </details>
  );
}
