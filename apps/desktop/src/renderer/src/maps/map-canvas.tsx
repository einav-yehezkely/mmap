/**
 * The map canvas (React Flow, PRD §5.6): pan, zoom, fit-to-view, selection, dragging in freeform
 * mode, connectors drawn between item handles, and collapse toggles in hierarchical mode.
 *
 * React Flow only holds transient UI state (selection, positions while dragging). Every change
 * that should last is sent to the main process through the callbacks, and the canvas is then
 * rebuilt from the returned map view.
 *
 * Keyboard: items are focusable; arrow keys move selected items in freeform mode (saved like a
 * drag); Delete removes the selection from the map while focus is in the canvas. The outline next to the canvas offers the full keyboard workflow.
 *
 * Connectors (freeform mode): drag from either dot of an item to another item to draw one; a
 * dashed line follows the cursor. A connector is easy to hit (wide invisible stroke); a selected one shows a remove button.
 * Dragging either end of a connector onto another item moves it there; dropping the end on empty
 * canvas removes it. The editor offers Undo for all of these.
 */

import '@xyflow/react/dist/style.css';

import type { MapViewDto, PlacementViewDto } from '@mmap/contracts';
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BaseEdge,
  ConnectionLineType,
  ConnectionMode,
  EdgeLabelRenderer,
  getBezierPath,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnSelectionChangeParams,
  useReactFlow,
} from '@xyflow/react';
import type { RelationshipTypeViewDto, RelationshipViewDto } from '@mmap/contracts';
import { ChevronDown, ChevronRight, Link2, MessageSquareText, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { errorMessage, unwrap } from '../lib/ipc';
import { notifyNodesChanged } from '../nodes/node-events';
import { cn } from '../lib/utils';
import { buildCanvasModel, facingSides, type ItemBox } from './map-model';
import { placementColorClass } from './placement-colors';

/** Positions changed by dragging or arrow keys are saved together after this pause. */
const POSITION_SAVE_DELAY_MS = 300;

interface PlacementNodeData extends Record<string, unknown> {
  readonly placement: PlacementViewDto;
  readonly childCount: number;
  readonly mode: MapViewDto['map']['mode'];
  readonly onToggleCollapse: (placementId: string, collapsed: boolean) => void;
}

type PlacementFlowNode = Node<PlacementNodeData, 'placement'>;

interface ConnectorEdgeData extends Record<string, unknown> {
  readonly connectionId: string;
  /** Text shown on the line: the note and the linked relationship's type. */
  readonly label: string | null;
  /** The connector's own note (what the note box edits). */
  readonly note: string | null;
  readonly relationshipId: string | null;
  /** Nodes at the two ends, to offer the relationships between them. */
  readonly sourceNodeId: string | null;
  readonly targetNodeId: string | null;
  /** Links the connector to a relationship between the same nodes, or unlinks it (null). */
  readonly onLinkRelationship: (connectionId: string, relationshipId: string | null) => void;
  readonly onRemove: (connectionId: string) => void;
  /** Saves the connector's note; null removes it. */
  readonly onEditLabel: (connectionId: string, label: string | null) => void;
}

type ConnectorFlowEdge = Edge<ConnectorEdgeData, 'connector'>;

/** Longest connector note (the map service enforces the same limit). */
const MAX_CONNECTOR_NOTE_LENGTH = 200;

/**
 * A map connector: dashed line with its note and, while selected, buttons to write the note and
 * to remove the connector. The invisible interaction stroke is wide so the thin line is easy to
 * click. The note is written in a small box on the line: Enter or clicking elsewhere saves,
 * Escape cancels, and a blank note removes it. Double-clicking a note edits it. The link button
 * lists the relationships between the two nodes; choosing one shows its type on the connector
 * (PRD §4.4). The same panel can also create a relationship between the two nodes, in the
 * connector's direction, and link it: the way to add a relationship without leaving the map.
 */
const ConnectorEdge = memo(function ConnectorEdge(props: EdgeProps<ConnectorFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const { data, selected } = props;
  const [editing, setEditing] = useState(false);
  const noteInput = useRef<HTMLInputElement | null>(null);
  /** Set once the edit is saved or cancelled, so the blur that follows does not save again. */
  const finished = useRef(false);
  useEffect(() => {
    if (!editing) return;
    finished.current = false;
    noteInput.current?.focus();
    noteInput.current?.select();
  }, [editing]);
  const finish = (text: string | null) => {
    if (finished.current) return;
    finished.current = true;
    setEditing(false);
    if (text === null || data === undefined) return;
    const note = text.trim();
    if (note !== (data.note ?? '')) data.onEditLabel(data.connectionId, note === '' ? null : note);
  };
  /** Relationships between the two nodes, while the link list is open ('loading' meanwhile). */
  const [linkOptions, setLinkOptions] = useState<readonly RelationshipViewDto[] | 'loading' | null>(
    null,
  );
  const openLinks = () => {
    if (data === undefined || data.sourceNodeId === null || data.targetNodeId === null) return;
    const ends = new Set([data.sourceNodeId, data.targetNodeId]);
    setLinkOptions('loading');
    unwrap(window.mmap.relationships.listForNode({ nodeId: data.sourceNodeId })).then(
      (result) =>
        setLinkOptions(
          result.items.filter((item) => ends.has(item.source.id) && ends.has(item.target.id)),
        ),
      () => setLinkOptions([]),
    );
  };
  const chooseLink = (relationshipId: string | null) => {
    setLinkOptions(null);
    if (data !== undefined && relationshipId !== data.relationshipId) {
      data.onLinkRelationship(data.connectionId, relationshipId);
    }
  };
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} interactionWidth={24} />
      {(data?.label !== null || selected === true || editing || linkOptions !== null) &&
        data !== undefined && (
          <EdgeLabelRenderer>
            <div
              className="nodrag nopan absolute flex items-center gap-1"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                pointerEvents: 'all',
              }}
            >
              {editing ? (
                <input
                  ref={noteInput}
                  aria-label="Note on this connector"
                  placeholder="Write a note…"
                  dir="auto"
                  defaultValue={data.note ?? ''}
                  maxLength={MAX_CONNECTOR_NOTE_LENGTH}
                  className="h-7 w-48 rounded-md border bg-background px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      finish(event.currentTarget.value);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      finish(null);
                    }
                  }}
                  onBlur={(event) => finish(event.currentTarget.value)}
                />
              ) : (
                data.label !== null && (
                  <span
                    className="max-w-48 rounded bg-background px-1 text-xs text-muted-foreground"
                    dir="auto"
                    title="Double-click to edit the note"
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setEditing(true);
                    }}
                  >
                    {data.label}
                  </span>
                )
              )}
              {selected === true && !editing && (
                <button
                  type="button"
                  aria-label={
                    data.relationshipId === null
                      ? 'Link this connector to a relationship'
                      : 'Change the linked relationship'
                  }
                  aria-expanded={linkOptions !== null}
                  title="Show a relationship on this connector"
                  onClick={() => (linkOptions === null ? openLinks() : setLinkOptions(null))}
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full border bg-background text-foreground shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    data.relationshipId !== null && 'border-primary text-primary',
                  )}
                >
                  <Link2 aria-hidden="true" className="size-3.5" />
                </button>
              )}
              {linkOptions !== null && (
                <div
                  role="dialog"
                  aria-label="Show a relationship on this connector"
                  className="absolute left-1/2 top-8 z-10 w-72 -translate-x-1/2 space-y-1 rounded-md border bg-background p-2 text-xs shadow-md"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      setLinkOptions(null);
                    }
                  }}
                >
                  <p className="font-medium">Show a relationship on this connector</p>
                  {linkOptions === 'loading' ? (
                    <p className="text-muted-foreground">Loading…</p>
                  ) : linkOptions.length === 0 ? (
                    <p className="text-muted-foreground">
                      These two notes have no relationship yet.
                    </p>
                  ) : (
                    <ul className="space-y-0.5">
                      {linkOptions.map((relationship) => (
                        <li key={relationship.id}>
                          <button
                            type="button"
                            aria-pressed={relationship.id === data.relationshipId}
                            onClick={() => chooseLink(relationship.id)}
                            className={cn(
                              'w-full rounded px-2 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              relationship.id === data.relationshipId && 'bg-accent font-medium',
                            )}
                          >
                            <span dir="auto">{relationship.source.title}</span>{' '}
                            {relationship.typeLabel}
                            {relationship.directionality === 'directed' ? ' → ' : ' — '}
                            <span dir="auto">{relationship.target.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.sourceNodeId !== null && data.targetNodeId !== null && (
                    <NewRelationshipForm
                      sourceNodeId={data.sourceNodeId}
                      targetNodeId={data.targetNodeId}
                      onCreated={(relationshipId) => chooseLink(relationshipId)}
                    />
                  )}
                  <div className="flex justify-end gap-1 pt-1">
                    {data.relationshipId !== null && (
                      <button
                        type="button"
                        onClick={() => chooseLink(null)}
                        className="rounded px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Remove the link
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setLinkOptions(null)}
                      className="rounded px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
              {selected === true && !editing && (
                <button
                  type="button"
                  aria-label={data.note === null ? 'Add a note to this connector' : 'Edit the note'}
                  title={data.note === null ? 'Add a note' : 'Edit the note'}
                  onClick={() => setEditing(true)}
                  className="flex size-6 items-center justify-center rounded-full border bg-background text-foreground shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MessageSquareText aria-hidden="true" className="size-3.5" />
                </button>
              )}
              {selected === true && !editing && (
                <button
                  type="button"
                  aria-label="Remove connector"
                  title="Remove connector (Delete)"
                  onClick={() => data.onRemove(data.connectionId)}
                  className="flex size-6 items-center justify-center rounded-full border bg-background text-foreground shadow-sm hover:bg-destructive hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              )}
            </div>
          </EdgeLabelRenderer>
        )}
    </>
  );
});

/**
 * Creates a relationship between a connector's two nodes, from the connector's start to its end,
 * and hands back its ID to be linked. The relationship belongs to the notes (it appears in their
 * Relationships sections, the graph and every map), not to this map.
 */
function NewRelationshipForm({
  sourceNodeId,
  targetNodeId,
  onCreated,
}: {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly onCreated: (relationshipId: string) => void;
}) {
  const [types, setTypes] = useState<readonly RelationshipTypeViewDto[] | null>(null);
  const [typeId, setTypeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const typeFieldId = useId();

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.relationshipTypes.list()).then(
      (result) => {
        if (cancelled) return;
        const active = result.items.filter((type) => !type.isArchived);
        setTypes(active);
        setTypeId(active[0]?.id ?? '');
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (types === null || types.length === 0) return null;
  const create = () => {
    setSaving(true);
    setError(null);
    unwrap(
      window.mmap.relationships.create({ sourceNodeId, targetNodeId, typeId, description: null }),
    ).then(
      (relationship) => {
        notifyNodesChanged();
        onCreated(relationship.id);
      },
      (caught: unknown) => {
        setError(errorMessage(caught));
        setSaving(false);
      },
    );
  };

  return (
    <form
      className="space-y-1 border-t pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <p className="font-medium">Create a relationship</p>
      <div className="flex items-center gap-1">
        <label htmlFor={typeFieldId} className="sr-only">
          Relationship type
        </label>
        <select
          id={typeFieldId}
          value={typeId}
          onChange={(event) => setTypeId(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded border bg-background px-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
              {type.directionality === 'directed' ? ' →' : ' —'}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={saving || typeId === ''}
          className="rounded border px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          Create
        </button>
      </div>
      <p className="text-muted-foreground">
        In the connector&apos;s direction, between the two notes; it then appears in both notes, the
        graph and every map.
      </p>
      {error !== null && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

const EDGE_TYPES = { connector: ConnectorEdge };

const PlacementNode = memo(function PlacementNode({
  data,
  selected,
}: NodeProps<PlacementFlowNode>) {
  const { placement, childCount, mode, onToggleCollapse } = data;
  const showToggle = mode === 'hierarchical' && childCount > 0;
  return (
    <div
      className={cn(
        'flex max-w-60 items-center gap-1 rounded-md border-2 bg-background px-3 py-2 text-sm shadow-sm',
        placementColorClass(placement.color),
        selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
      )}
    >
      {/* A dot on every side: connectors can start and end at any of them (loose mode, so all
          are source handles), and each line attaches to the sides that face each other. */}
      <Handle id="left" type="source" position={Position.Left} />
      <Handle id="top" type="source" position={Position.Top} />
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <span dir="auto" className="min-w-0 break-words">
        {placement.nodeTitle}
      </span>
      {showToggle && (
        <button
          type="button"
          // `nodrag` keeps React Flow from treating the click as the start of a drag.
          className="nodrag ml-1 inline-flex items-center rounded px-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={
            placement.isCollapsed
              ? `Expand ${placement.nodeTitle} (${childCount} hidden)`
              : `Collapse ${placement.nodeTitle}`
          }
          aria-expanded={!placement.isCollapsed}
          onClick={() => onToggleCollapse(placement.id, !placement.isCollapsed)}
        >
          {placement.isCollapsed ? (
            <>
              <ChevronRight aria-hidden="true" className="size-3" />
              {childCount}
            </>
          ) : (
            <ChevronDown aria-hidden="true" className="size-3" />
          )}
        </button>
      )}
      <Handle id="right" type="source" position={Position.Right} />
    </div>
  );
});

const NODE_TYPES = { placement: PlacementNode };

/** A map whose viewport was never saved still has the default; it opens fitted to its items. */
function isDefaultViewport(viewport: MapViewDto['map']['viewport']): boolean {
  return viewport.x === 0 && viewport.y === 0 && viewport.zoom === 1;
}

/**
 * Switching modes moves every item (tree layout vs. stored positions), so the view is fitted to
 * the items again. Rendered inside React Flow to reach its instance.
 */
function FitViewOnModeChange({ mode }: { mode: MapViewDto['map']['mode'] }) {
  const { fitView } = useReactFlow();
  const fittedMode = useRef(mode);
  useEffect(() => {
    if (mode === fittedMode.current) return;
    fittedMode.current = mode;
    // Waits a frame so React Flow has measured the items at their new positions.
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [mode, fitView]);
  return null;
}

export interface MapCanvasProps {
  readonly view: MapViewDto;
  readonly selectedPlacementId: string | null;
  readonly onSelect: (placementId: string | null) => void;
  readonly onOpenNode: (nodeId: string) => void;
  readonly onMove: (changes: readonly { placementId: string; x: number; y: number }[]) => void;
  readonly onConnect: (sourcePlacementId: string, targetPlacementId: string) => void;
  readonly onToggleCollapse: (placementId: string, collapsed: boolean) => void;
  readonly onRemove: (placementIds: readonly string[], connectionIds: readonly string[]) => void;
  /** A connector's end was dragged to another item. */
  readonly onReconnect: (
    connectionId: string,
    sourcePlacementId: string,
    targetPlacementId: string,
  ) => void;
  readonly onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  /** Saves a connector's note; null removes it. */
  readonly onConnectorLabel: (connectionId: string, label: string | null) => void;
  /** Links a connector to a relationship between the same nodes; null removes the link. */
  readonly onConnectorRelationship: (connectionId: string, relationshipId: string | null) => void;
}

export function MapCanvas({
  view,
  selectedPlacementId,
  onSelect,
  onOpenNode,
  onMove,
  onConnect,
  onToggleCollapse,
  onRemove,
  onReconnect,
  onViewportChange,
  onConnectorLabel,
  onConnectorRelationship,
}: MapCanvasProps) {
  // Stable for the edge data (rebuilding every edge on each render would loop), while still
  // calling the latest handler.
  const latestOnRemove = useRef(onRemove);
  useEffect(() => {
    latestOnRemove.current = onRemove;
  }, [onRemove]);
  const removeConnector = useCallback(
    (connectionId: string) => latestOnRemove.current([], [connectionId]),
    [],
  );
  const latestOnLabel = useRef(onConnectorLabel);
  useEffect(() => {
    latestOnLabel.current = onConnectorLabel;
  }, [onConnectorLabel]);
  const editConnectorLabel = useCallback(
    (connectionId: string, label: string | null) => latestOnLabel.current(connectionId, label),
    [],
  );
  const latestOnLink = useRef(onConnectorRelationship);
  useEffect(() => {
    latestOnLink.current = onConnectorRelationship;
  }, [onConnectorRelationship]);
  const linkConnector = useCallback(
    (connectionId: string, relationshipId: string | null) =>
      latestOnLink.current(connectionId, relationshipId),
    [],
  );
  /** Item a new connector is being drawn from (see onConnect). */
  const connectFrom = useRef<string | null>(null);
  /** Whether the connector end being dragged landed on an item (see onReconnectEnd). */
  const reconnected = useRef(true);
  const model = useMemo(() => buildCanvasModel(view), [view]);
  const nodeIdOf = useMemo(
    () => new Map(view.placements.map((placement) => [placement.id, placement.nodeId])),
    [view],
  );
  const isFreeform = view.map.mode === 'freeform';

  // Finished position changes (drag end, arrow keys) waiting to be saved together.
  const pendingMoves = useRef(new Map<string, { x: number; y: number }>());
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const derivedNodes = useMemo<PlacementFlowNode[]>(
    () =>
      model.items.map(({ placement, position, childCount }) => ({
        id: placement.id,
        type: 'placement',
        position,
        ariaLabel: placement.nodeTitle,
        data: { placement, childCount, mode: view.map.mode, onToggleCollapse },
      })),
    [model, view.map.mode, onToggleCollapse],
  );
  const derivedEdges = useMemo<Edge[]>(
    () =>
      model.lines.map((line): Edge => {
        if (line.kind === 'relationship') {
          // Semantic relationships: shown, never edited or removed here (edit them on the node).
          // A curved line keeps them apart from straight-cornered hierarchy lines.
          return {
            id: line.id,
            source: line.source,
            target: line.target,
            type: 'default',
            label: line.label ?? undefined,
            ariaLabel: `Relationship: ${line.label ?? ''}${line.directed === true ? '' : ' (no direction)'}`,
            selectable: false,
            deletable: false,
            className: 'mmap-relationship-line',
            ...(line.directed === true
              ? { markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--relationship-line)' } }
              : {}),
          };
        }
        return line.kind === 'hierarchy'
          ? {
              id: line.id,
              source: line.source,
              target: line.target,
              type: 'smoothstep',
              // The tree grows from left to right.
              sourceHandle: 'right',
              targetHandle: 'left',
              selectable: false,
              deletable: false,
              className: 'mmap-hierarchy-line',
            }
          : {
              id: line.id,
              source: line.source,
              target: line.target,
              type: 'connector',
              ariaLabel: line.label === null ? 'Connector' : `Connector: ${line.label}`,
              markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)' },
              className: 'mmap-connector-line',
              reconnectable: isFreeform,
              data: {
                connectionId: line.id.slice('connector:'.length),
                label: line.label,
                note: line.connection?.label ?? null,
                relationshipId: line.connection?.relationshipId ?? null,
                sourceNodeId: nodeIdOf.get(line.source) ?? null,
                targetNodeId: nodeIdOf.get(line.target) ?? null,
                onRemove: removeConnector,
                onEditLabel: editConnectorLabel,
                onLinkRelationship: linkConnector,
              },
            };
      }),
    [model, isFreeform, removeConnector, editConnectorLabel, linkConnector, nodeIdOf],
  );

  // React Flow works on local copies (selection, measured sizes, positions while dragging). When
  // a new map view arrives the copies are rebuilt from it, keeping what React Flow already knows:
  // which items are selected, their measured sizes (so 500 items are not measured again), and
  // positions of moves that are still waiting to be saved (so they do not jump back).
  const [nodes, setNodes] = useState<PlacementFlowNode[]>(derivedNodes);
  const [edges, setEdges] = useState<Edge[]>(derivedEdges);
  const [nodesFrom, setNodesFrom] = useState(derivedNodes);
  const [edgesFrom, setEdgesFrom] = useState(derivedEdges);
  if (nodesFrom !== derivedNodes) {
    setNodesFrom(derivedNodes);
    setNodes((current) => {
      const previous = new Map(current.map((node) => [node.id, node]));
      return derivedNodes.map((node) => {
        const old = previous.get(node.id);
        if (old === undefined) return node;
        return {
          ...node,
          selected: old.selected,
          measured: old.measured,
          position: pendingMoves.current.get(node.id) ?? node.position,
        };
      });
    });
  }
  if (edgesFrom !== derivedEdges) {
    setEdgesFrom(derivedEdges);
    setEdges((current) => {
      const selected = new Set(current.filter((edge) => edge.selected).map((edge) => edge.id));
      return derivedEdges.map((edge) =>
        selected.has(edge.id) ? { ...edge, selected: true } : edge,
      );
    });
  }

  // Selection made outside the canvas (the outline) is shown here. A selection that came from the
  // canvas itself is already present, which keeps multi-selection intact.
  const [shownSelection, setShownSelection] = useState(selectedPlacementId);
  if (shownSelection !== selectedPlacementId) {
    setShownSelection(selectedPlacementId);
    setNodes((current) => {
      const fromCanvas = current.some(
        (node) => node.id === selectedPlacementId && node.selected === true,
      );
      if (fromCanvas) return current;
      return current.map((node) => {
        const selected = node.id === selectedPlacementId;
        return Boolean(node.selected) === selected ? node : { ...node, selected };
      });
    });
  }

  const flushMoves = useCallback(() => {
    moveTimer.current = null;
    const changes = [...pendingMoves.current].map(([placementId, position]) => ({
      placementId,
      x: Math.round(position.x),
      y: Math.round(position.y),
    }));
    pendingMoves.current.clear();
    if (changes.length > 0) onMove(changes);
  }, [onMove]);
  useEffect(
    () => () => {
      if (moveTimer.current !== null) {
        clearTimeout(moveTimer.current);
        flushMoves();
      }
    },
    [flushMoves],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<PlacementFlowNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          pendingMoves.current.set(change.id, change.position);
        }
      }
      if (pendingMoves.current.size > 0) {
        if (moveTimer.current !== null) clearTimeout(moveTimer.current);
        moveTimer.current = setTimeout(flushMoves, POSITION_SAVE_DELAY_MS);
      }
    },
    [flushMoves],
  );

  // Connectors and relationship lines attach to the sides of their items that face each other,
  // following the items while they are dragged; hierarchy lines keep their fixed sides.
  const shownEdges = useMemo(() => {
    const boxes = new Map<string, ItemBox>(
      nodes.map((node) => [
        node.id,
        {
          x: node.position.x,
          y: node.position.y,
          width: node.measured?.width ?? 160,
          height: node.measured?.height ?? 40,
        },
      ]),
    );
    return edges.map((edge) => {
      if (edge.sourceHandle !== undefined && edge.sourceHandle !== null) return edge;
      const from = boxes.get(edge.source);
      const to = boxes.get(edge.target);
      if (from === undefined || to === undefined) return edge;
      const sides = facingSides(from, to);
      return { ...edge, sourceHandle: sides.from, targetHandle: sides.to };
    });
  }, [nodes, edges]);

  // Only selection changes apply to edges; edges otherwise always come from the map view.
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) =>
      applyEdgeChanges(
        changes.filter((change) => change.type === 'select'),
        current,
      ),
    );
  }, []);

  // React Flow requires a stable callback here. The last selected item becomes the selection
  // used by the toolbar and the outline.
  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams<PlacementFlowNode, Edge>) => {
      onSelect(selectedNodes.at(-1)?.id ?? null);
    },
    [onSelect],
  );

  // Delete/Backspace remove the selected items from this map (never their nodes) and the
  // selected connectors, but only while focus is inside the canvas, so the keys keep their usual
  // meaning everywhere else in the app.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]') !== null) return;
    const placementIds = nodes.filter((node) => node.selected).map((node) => node.id);
    const connectionIds = edges
      .filter((edge) => edge.selected && edge.id.startsWith('connector:'))
      .map((edge) => edge.id.slice('connector:'.length));
    if (placementIds.length === 0 && connectionIds.length === 0) return;
    event.preventDefault();
    onRemove(placementIds, connectionIds);
  };

  // Double-clicking an item opens it. Caught on the way down: in hierarchy mode items cannot be
  // dragged, so React Flow lets its double-click zoom take the event first, and onNodeDoubleClick
  // never fired. Stopping it here also keeps the map from zooming in under the open item.
  const onDoubleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, .react-flow__handle') !== null) return;
    const id = target.closest('.react-flow__node')?.getAttribute('data-id');
    const node = id ? nodes.find((candidate) => candidate.id === id) : undefined;
    if (node === undefined) return;
    event.stopPropagation();
    onOpenNode(node.data.placement.nodeId);
  };

  return (
    <div className="h-full" onKeyDown={onKeyDown} onDoubleClickCapture={onDoubleClickCapture}>
      <ReactFlow<PlacementFlowNode, Edge>
        nodes={nodes}
        edges={shownEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        // The line that follows the cursor while drawing or moving a connector: dashed like a
        // connector, in the accent color so it stands out; dropping near an item's dot snaps to it.
        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={{ stroke: 'var(--primary)', strokeWidth: 2.5, strokeDasharray: '6 4' }}
        connectionRadius={40}
        // Either dot of an item starts or ends a connector (the left one used to do nothing when
        // dragged), and a connector's end can be grabbed from a little way off.
        connectionMode={ConnectionMode.Loose}
        reconnectRadius={18}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onConnectStart={(_event, { nodeId }) => {
          connectFrom.current = nodeId;
        }}
        onConnect={(connection: Connection) => {
          if (connection.source === connection.target) return;
          // A connector always points away from the item the drag started on, whichever of its
          // dots was used (with either dot allowed, a drag from the left dot reports that item as
          // the target).
          if (connectFrom.current === connection.target) {
            onConnect(connection.target, connection.source);
          } else {
            onConnect(connection.source, connection.target);
          }
        }}
        onReconnectStart={() => {
          reconnected.current = false;
        }}
        onReconnect={(oldEdge, connection) => {
          reconnected.current = true;
          if (!oldEdge.id.startsWith('connector:') || connection.source === connection.target)
            return;
          if (connection.source === oldEdge.source && connection.target === oldEdge.target) return;
          onReconnect(oldEdge.id.slice('connector:'.length), connection.source, connection.target);
        }}
        onReconnectEnd={(_event, edge) => {
          // Dropped on empty canvas: the user dragged the line away, so it is removed (undoable).
          if (!reconnected.current && edge.id.startsWith('connector:')) {
            removeConnector(edge.id.slice('connector:'.length));
          }
          reconnected.current = true;
        }}
        deleteKeyCode={null}
        nodesDraggable={isFreeform}
        nodesConnectable={isFreeform}
        defaultViewport={view.map.viewport}
        fitView={isDefaultViewport(view.map.viewport) && view.placements.length > 0}
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        onMoveEnd={(_event, viewport) => onViewportChange(viewport)}
        minZoom={0.1}
        maxZoom={4}
        colorMode="system"
        // Attribution would be a link leaving the app; mmap never navigates to the web from here.
        proOptions={{ hideAttribution: true }}
        aria-label={`Map canvas: ${view.map.title}`}
      >
        <Background />
        <Controls showInteractive={false} />
        <FitViewOnModeChange mode={view.map.mode} />
      </ReactFlow>
    </div>
  );
}
