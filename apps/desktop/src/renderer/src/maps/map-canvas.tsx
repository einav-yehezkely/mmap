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
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '../lib/utils';
import { buildCanvasModel } from './map-model';
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
  readonly label: string | null;
  readonly onRemove: (connectionId: string) => void;
}

type ConnectorFlowEdge = Edge<ConnectorEdgeData, 'connector'>;

/**
 * A map connector: dashed line with its label and, while selected, a button that removes it.
 * The invisible interaction stroke is wide so the thin line is easy to click.
 */
const ConnectorEdge = memo(function ConnectorEdge(props: EdgeProps<ConnectorFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath(props);
  const { data, selected } = props;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} interactionWidth={24} />
      {(data?.label !== null || selected === true) && data !== undefined && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex items-center gap-1"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            {data.label !== null && (
              <span className="rounded bg-background px-1 text-xs text-muted-foreground" dir="auto">
                {data.label}
              </span>
            )}
            {selected === true && (
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
      <Handle id="in" type="target" position={Position.Left} />
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
      <Handle id="out" type="source" position={Position.Right} />
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
  /** Item a new connector is being drawn from (see onConnect). */
  const connectFrom = useRef<string | null>(null);
  /** Whether the connector end being dragged landed on an item (see onReconnectEnd). */
  const reconnected = useRef(true);
  const model = useMemo(() => buildCanvasModel(view), [view]);
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
                onRemove: removeConnector,
              },
            };
      }),
    [model, isFreeform, removeConnector],
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

  return (
    <div className="h-full" onKeyDown={onKeyDown}>
      <ReactFlow<PlacementFlowNode, Edge>
        nodes={nodes}
        edges={edges}
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
        onNodeDoubleClick={(_event, node) => onOpenNode(node.data.placement.nodeId)}
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
