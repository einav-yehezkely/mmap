/**
 * Knowledge Graph screen (PRD §5.7, §13 criteria 9 and 14).
 *
 * Layout: a compact toolbar (find, zoom, fit, rearrange, map badges, labels, note links, filters,
 * graph/list), a one-line completeness statement, an optional collapsible filter panel, and the
 * canvas filling the rest, with a side panel for the selected node.
 *
 * Positions: the graph keeps where nodes were (saved per workspace, apart from mind map layouts).
 * Only nodes without a saved position are placed, next to their neighbors; the whole graph is laid
 * out only on the first visit and when the user asks (Rearrange).
 *
 * Map membership is shown on nodes (badges) and in the side panel, list and tooltip. It is never
 * drawn as an edge, and a node appears once however many maps place it.
 */

import type { GraphSliceDto, RelationshipTypeViewDto } from '@mmap/contracts';
import {
  Focus,
  Info,
  LayoutGrid,
  Link2,
  Maximize,
  Minus,
  Plus,
  SlidersHorizontal,
  Tags,
  SquareDashed,
  Workflow,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { cn } from '../lib/utils';
import { useNodesChanged } from '../nodes/node-events';
import type { PickedNode } from '../nodes/node-picker';
import { TagFilterBar, type TagOption } from '../nodes/tag-filter-bar';
import { GraphCanvas, type GraphCanvasHandle } from './graph-canvas';
import { placeNodes, type Point } from './graph-layout';
import { GraphMapFilter } from './graph-map-filter';
import {
  buildGraphList,
  computeEmphasis,
  describeCompleteness,
  findNodes,
  focusNodeIds,
  isPartial,
  mapColors,
  mergeNeighborhood,
  stateFromOverview,
  toCytoscapeElements,
  type GraphState,
} from './graph-model';
import { GraphNodePanel } from './graph-node-panel';
import { collapseMaps, isSummaryId, regionSpecs, SUMMARY_PREFIX } from './graph-regions';

/** Most regions drawn at once; beyond that overlapping outlines stop being readable. */
const MAX_REGIONS = 12;

interface Filters {
  readonly text: string;
  readonly tagIds: readonly string[];
  readonly relationshipTypeIds: readonly string[];
  readonly mapIds: readonly string[];
  readonly includeReferences: boolean;
}

const NO_FILTERS: Filters = {
  text: '',
  tagIds: [],
  relationshipTypeIds: [],
  mapIds: [],
  includeReferences: false,
};

const SAVE_BATCH = 5_000;
/**
 * Largest graph laid out automatically on the first visit. Bigger graphs keep the stable placement
 * (already free of overlaps) so the first view appears quickly; Rearrange is one click away.
 */
const AUTO_ARRANGE_LIMIT = 300;

function filterRequest(filters: Filters) {
  return {
    text: filters.text.trim() === '' ? null : filters.text,
    tagIds: [...filters.tagIds],
    relationshipTypeIds: [...filters.relationshipTypeIds],
    mapIds: [...filters.mapIds],
    includeReferences: filters.includeReferences,
  };
}

function activeFilterCount(filters: Filters): number {
  return (
    (filters.text.trim() === '' ? 0 : 1) +
    filters.tagIds.length +
    filters.relationshipTypeIds.length +
    filters.mapIds.length
  );
}

function linksOf(state: GraphState): { source: string; target: string }[] {
  return [
    ...[...state.edges.values()].map((edge) => ({
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
    })),
    ...[...state.references.values()].map((reference) => ({
      source: reference.sourceNodeId,
      target: reference.targetNodeId,
    })),
  ];
}

/** Saves positions in batches; failures are not worth interrupting the user for. */
function savePositions(positions: readonly { nodeId: string; x: number; y: number }[]): void {
  for (let start = 0; start < positions.length; start += SAVE_BATCH) {
    void window.mmap.graph.savePositions({ positions: positions.slice(start, start + SAVE_BATCH) });
  }
}

export interface GraphViewProps {
  readonly onOpenNode: (nodeId: string) => void;
  readonly onOpenMap: (mapId: string) => void;
}

export function GraphView({ onOpenNode, onOpenMap }: GraphViewProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [textInput, setTextInput] = useState('');
  const [state, setState] = useState<GraphState | null>(null);
  const [positions, setPositions] = useState<ReadonlyMap<string, Point>>(new Map());
  const [canvasSetup, setCanvasSetup] = useState<{ arrangeOnLoad: boolean } | null>(null);
  /** Incremented to fit the graph to the view: after filter changes and Focus changes. */
  const [fitRequest, setFitRequest] = useState(0);
  /** Filters of the last load, to tell a filter change (fit) from a reload after an edit (no fit). */
  const loadedFilters = useRef<Filters | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'graph' | 'list'>('graph');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showMaps, setShowMaps] = useState(false);
  const [showAllLabels, setShowAllLabels] = useState(false);
  /** Map regions drawn behind the graph, and maps collapsed into summary nodes. */
  const [showRegions, setShowRegions] = useState(false);
  const [collapsedMapIds, setCollapsedMapIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The node whose side panel has the "Add relationship" form open. While it matches the
   * selection, clicking another node chooses it as the other end instead of selecting it.
   */
  const [relatingFor, setRelatingFor] = useState<string | null>(null);
  const [graphPick, setGraphPick] = useState<{ forNodeId: string; node: PickedNode } | null>(null);
  const [highlightedMapId, setHighlightedMapId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ centerId: string; expanded: readonly string[] } | null>(
    null,
  );
  const [findText, setFindText] = useState('');
  const [tagOptions, setTagOptions] = useState<readonly TagOption[]>([]);
  const [types, setTypes] = useState<readonly RelationshipTypeViewDto[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const canvas = useRef<GraphCanvasHandle>(null);
  /** Latest known position of every node seen (including drags), so reloads never move nodes. */
  const knownPositions = useRef(new Map<string, Point>());
  /** Neighborhoods the user expanded; re-applied after reloads so expansions are not lost. */
  const expandedIds = useRef<string[]>([]);
  const findId = useId();
  const textId = useId();

  // Typing filters after a short pause. Keeps the same object when nothing changed, so the graph
  // is not loaded twice.
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setFilters((current) =>
          current.text === textInput ? current : { ...current, text: textInput },
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [textInput]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      unwrap(window.mmap.tags.list()),
      unwrap(window.mmap.relationshipTypes.list()),
    ]).then(
      ([tags, relationshipTypes]) => {
        if (cancelled) return;
        setTagOptions(tags.items);
        setTypes(relationshipTypes.items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Loads the slice, re-applies expansions, then positions: saved ones are reused and only nodes
  // without one are placed. Nothing already on screen moves.
  useEffect(() => {
    let cancelled = false;
    const request = filterRequest(filters);
    const load = async () => {
      let next = stateFromOverview(await unwrap(window.mmap.graph.overview(request)));
      for (const nodeId of expandedIds.current) {
        if (!next.nodes.has(nodeId)) continue;
        const slice: GraphSliceDto = await unwrap(
          window.mmap.graph.neighborhood({ nodeId, ...request }),
        );
        next = mergeNeighborhood(next, nodeId, slice);
      }
      const ids = [...next.nodes.keys()];
      const stored = await unwrap(window.mmap.graph.getPositions({ nodeIds: ids }));
      if (cancelled) return;
      const saved = new Map(knownPositions.current);
      for (const position of stored.positions) {
        if (!saved.has(position.nodeId)) saved.set(position.nodeId, position);
      }
      const firstVisit = stored.positions.length === 0 && knownPositions.current.size === 0;
      // Laid out on opening when nothing was saved yet, or when most nodes on screen are new
      // (placed one by one they spread out); saved arrangements are otherwise kept as they are.
      const mostlyNew = ids.filter((id) => !saved.has(id)).length * 2 > ids.length;
      const arrangeOnLoad = (firstVisit || mostlyNew) && ids.length <= AUTO_ARRANGE_LIMIT;
      const placed = placeNodes(ids, linksOf(next), saved);
      const newlyPlaced = ids
        .filter((id) => !saved.has(id))
        .map((id) => ({ nodeId: id, ...(placed.get(id) ?? { x: 0, y: 0 }) }));
      for (const [id, point] of placed) knownPositions.current.set(id, point);
      // New nodes keep the spot they got, so the next visit shows them in the same place. When the
      // first visit lays out the graph, Rearrange saves everything once it has finished.
      if (!arrangeOnLoad && newlyPlaced.length > 0) savePositions(newlyPlaced);
      setState(next);
      setPositions(placed);
      setCanvasSetup((current) => current ?? { arrangeOnLoad });
      if (loadedFilters.current !== null && loadedFilters.current !== filters) {
        setFitRequest((value) => value + 1);
      }
      loadedFilters.current = filters;
      setError(null);
    };
    load().catch((caught: unknown) => {
      if (!cancelled) setError(errorMessage(caught));
    });
    return () => {
      cancelled = true;
    };
  }, [filters, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  useNodesChanged(reload);

  const expand = async (nodeId: string) => {
    try {
      const slice = await unwrap(
        window.mmap.graph.neighborhood({ nodeId, ...filterRequest(filters) }),
      );
      if (!expandedIds.current.includes(nodeId)) expandedIds.current.push(nodeId);
      if (state === null) return;
      const next = mergeNeighborhood(state, nodeId, slice);
      const ids = [...next.nodes.keys()];
      const placed = placeNodes(ids, linksOf(next), knownPositions.current);
      const added = ids
        .filter((id) => !knownPositions.current.has(id))
        .map((id) => ({ nodeId: id, ...(placed.get(id) ?? { x: 0, y: 0 }) }));
      for (const [id, point] of placed) knownPositions.current.set(id, point);
      if (added.length > 0) savePositions(added);
      setState(next);
      setPositions(placed);
      if (focus !== null && !focus.expanded.includes(nodeId)) {
        changeFocus({ ...focus, expanded: [...focus.expanded, nodeId] });
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const onPositionsChanged = useCallback(
    (changed: readonly { nodeId: string; x: number; y: number }[]) => {
      // Summary nodes of collapsed maps are not knowledge nodes: their place is derived.
      const nodes = changed.filter((position) => !isSummaryId(position.nodeId));
      for (const { nodeId, x, y } of nodes) knownPositions.current.set(nodeId, { x, y });
      if (nodes.length > 0) savePositions(nodes);
    },
    [],
  );
  /** Enters, changes or leaves Focus mode, and fits the view to what is then visible. */
  const changeFocus = (next: { centerId: string; expanded: readonly string[] } | null) => {
    setFocus(next);
    setFitRequest((value) => value + 1);
  };

  const colors = useMemo(() => mapColors(state?.maps ?? []), [state]);
  const collapse = useMemo(
    () => (state === null ? null : collapseMaps(state, collapsedMapIds)),
    [state, collapsedMapIds],
  );
  const elements = useMemo(
    () =>
      state === null
        ? []
        : toCytoscapeElements(state, positions, { showMaps, collapse: collapse ?? undefined }),
    [state, positions, showMaps, collapse],
  );
  const regionView = useMemo(
    () =>
      state === null || !showRegions
        ? { regions: [], omitted: 0 }
        : regionSpecs(
            state,
            colors,
            collapsedMapIds,
            collapse?.hidden ?? new Set(),
            filters.mapIds,
            MAX_REGIONS,
          ),
    [state, showRegions, colors, collapsedMapIds, collapse, filters.mapIds],
  );
  const toggleCollapsed = (mapId: string) =>
    setCollapsedMapIds((current) => {
      const next = new Set(current);
      if (next.has(mapId)) next.delete(mapId);
      else next.add(mapId);
      return next;
    });
  /**
   * Selecting a collapsed map's summary expands it; selecting a node selects it, except while the
   * selected node's "Add relationship" form is open: then the clicked node becomes the other end
   * (a click on the empty canvas changes nothing).
   */
  const onCanvasSelect = useCallback(
    (id: string | null) => {
      if (id !== null && isSummaryId(id)) {
        const mapId = id.slice(SUMMARY_PREFIX.length);
        setCollapsedMapIds((current) => new Set([...current].filter((item) => item !== mapId)));
        return;
      }
      if (relatingFor !== null && relatingFor === selectedId) {
        const node = id === null ? undefined : state?.nodes.get(id);
        if (id !== null && id !== relatingFor && node !== undefined) {
          setGraphPick({ forNodeId: relatingFor, node: { id, title: node.title } });
        }
        return;
      }
      setSelectedId(id);
    },
    [relatingFor, selectedId, state],
  );
  const emphasis = useMemo(
    () =>
      state === null
        ? { nodes: null, edges: null }
        : computeEmphasis(state, selectedId, highlightedMapId),
    [state, selectedId, highlightedMapId],
  );
  const focusIds = useMemo(
    () =>
      state === null || focus === null ? null : focusNodeIds(state, focus.centerId, focus.expanded),
    [state, focus],
  );
  const listItems = useMemo(() => {
    if (state === null) return [];
    const items = buildGraphList(state);
    return focusIds === null ? items : items.filter((item) => focusIds.has(item.id));
  }, [state, focusIds]);
  const matches = useMemo(
    () => (state === null ? [] : findNodes(state, findText, 8)),
    [state, findText],
  );
  const selected = selectedId === null ? null : (state?.nodes.get(selectedId) ?? null);
  const visibleTypes = types.filter(
    (type) => !type.isArchived || filters.relationshipTypeIds.includes(type.id),
  );
  const filterCount = activeFilterCount(filters);
  const highlightedMap = state?.maps.find((map) => map.id === highlightedMapId) ?? null;

  /** Find: selects and centers a node, or, while adding a relationship, chooses it as the other end. */
  const select = (nodeId: string) => {
    const node = state?.nodes.get(nodeId);
    if (relatingFor !== null && relatingFor === selectedId && nodeId !== relatingFor) {
      if (node !== undefined)
        setGraphPick({ forNodeId: relatingFor, node: { id: nodeId, title: node.title } });
    } else {
      setSelectedId(nodeId);
    }
    canvas.current?.center(nodeId);
  };

  const toggleType = (typeId: string) =>
    setFilters((current) => ({
      ...current,
      relationshipTypeIds: current.relationshipTypeIds.includes(typeId)
        ? current.relationshipTypeIds.filter((id) => id !== typeId)
        : [...current.relationshipTypeIds, typeId],
    }));

  const showGraph = () => {
    setTab('graph');
    // The canvas was hidden; let Cytoscape measure it again once it is visible.
    requestAnimationFrame(() => canvas.current?.resize());
  };

  return (
    <section aria-labelledby="graph-heading" className="flex h-full min-h-[560px] flex-col gap-2">
      <h1 id="graph-heading" className="sr-only">
        Knowledge Graph
      </h1>

      <div
        role="toolbar"
        aria-label="Graph tools"
        className="flex flex-wrap items-center gap-1.5 rounded-md border bg-background p-1.5"
      >
        <div className="relative">
          <label htmlFor={findId} className="sr-only">
            Find a node in the graph
          </label>
          <Input
            id={findId}
            type="search"
            dir="auto"
            className="h-8 w-56"
            placeholder="Find in graph"
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            onKeyDown={(event) => {
              const first = matches[0];
              if (event.key === 'Enter' && first !== undefined) {
                select(first.id);
                setFindText('');
              }
            }}
            // Only while the list exists: a reference to a missing element is invalid ARIA.
            aria-controls={matches.length > 0 ? `${findId}-results` : undefined}
          />
          {matches.length > 0 && (
            <ul
              id={`${findId}-results`}
              className="absolute left-0 top-9 z-20 w-72 rounded-md border bg-background p-1 shadow-md"
            >
              {matches.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    dir="auto"
                    onClick={() => {
                      select(node.id);
                      setFindText('');
                    }}
                  >
                    {node.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => canvas.current?.zoomBy(1 / 1.25)}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => canvas.current?.zoomBy(1.25)}
        >
          <Plus aria-hidden="true" />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => canvas.current?.fit()} title="Fit to view">
          <Maximize aria-hidden="true" />
          Fit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => canvas.current?.rearrange()}
          title="Lay out the visible graph again (your current arrangement is replaced)"
        >
          <LayoutGrid aria-hidden="true" />
          Rearrange
        </Button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant={showMaps ? 'outline' : 'ghost'}
          aria-pressed={showMaps}
          onClick={() => setShowMaps((value) => !value)}
          title="Show which mind maps each node belongs to"
        >
          <Workflow aria-hidden="true" />
          Show Maps
        </Button>
        <Button
          size="sm"
          variant={showRegions ? 'outline' : 'ghost'}
          aria-pressed={showRegions}
          onClick={() => setShowRegions((value) => !value)}
          title="Outline the members of each mind map (maps can overlap)"
        >
          <SquareDashed aria-hidden="true" />
          Regions
        </Button>
        <Button
          size="sm"
          variant={showAllLabels ? 'outline' : 'ghost'}
          aria-pressed={showAllLabels}
          onClick={() => setShowAllLabels((value) => !value)}
          title="Show every relationship label (otherwise on hover and selection)"
        >
          <Tags aria-hidden="true" />
          All labels
        </Button>
        <Button
          size="sm"
          variant={filters.includeReferences ? 'outline' : 'ghost'}
          aria-pressed={filters.includeReferences}
          onClick={() =>
            setFilters((current) => ({ ...current, includeReferences: !current.includeReferences }))
          }
          title="Show note links (wikilinks) as dashed lines"
        >
          <Link2 aria-hidden="true" />
          Note links
        </Button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant={filtersOpen || filterCount > 0 ? 'outline' : 'ghost'}
          aria-expanded={filtersOpen}
          aria-controls="graph-filters"
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <SlidersHorizontal aria-hidden="true" />
          Filters{filterCount > 0 ? ` (${filterCount})` : ''}
        </Button>
        <div
          role="tablist"
          aria-label="Graph presentation"
          className="ml-auto flex rounded-md border p-0.5"
        >
          <Button
            role="tab"
            size="sm"
            variant={tab === 'graph' ? 'outline' : 'ghost'}
            aria-selected={tab === 'graph'}
            onClick={showGraph}
          >
            Graph
          </Button>
          <Button
            role="tab"
            size="sm"
            variant={tab === 'list' ? 'outline' : 'ghost'}
            aria-selected={tab === 'list'}
            onClick={() => setTab('list')}
          >
            List
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div id="graph-filters" className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label htmlFor={textId} className="text-sm text-muted-foreground">
                Text
              </label>
              <Input
                id={textId}
                type="search"
                dir="auto"
                className="h-8"
                placeholder="Only nodes whose title, summary or note contains…"
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
              />
            </div>
            <TagFilterBar
              options={tagOptions}
              selected={filters.tagIds}
              onChange={(tagIds) => setFilters((current) => ({ ...current, tagIds }))}
            />
            {visibleTypes.length > 0 && (
              <div
                role="group"
                aria-label="Filter by relationship type"
                className="flex flex-wrap gap-1.5"
              >
                <span className="mr-1 text-sm text-muted-foreground">Types:</span>
                {visibleTypes.map((type) => {
                  const isSelected = filters.relationshipTypeIds.includes(type.id);
                  return (
                    <button
                      key={type.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleType(type.id)}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'hover:bg-accent',
                      )}
                    >
                      <span dir="auto">{type.label}</span>
                      {type.directionality === 'directed' && <span aria-hidden="true"> →</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <p className="mb-1 text-sm text-muted-foreground">Mind maps</p>
            <GraphMapFilter
              maps={state?.maps ?? []}
              selected={filters.mapIds}
              colors={colors}
              highlightedMapId={highlightedMapId}
              onChange={(mapIds) => setFilters((current) => ({ ...current, mapIds }))}
              onHighlight={(mapId) => {
                setHighlightedMapId(mapId);
                // A map highlight replaces the selection emphasis so the map's members stand out.
                if (mapId !== null) setSelectedId(null);
              }}
              collapsed={collapsedMapIds}
              onToggleCollapsed={toggleCollapsed}
              onOpenMap={onOpenMap}
            />
          </div>
          {filterCount > 0 && (
            <div className="md:col-span-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTextInput('');
                  setFilters((current) => ({
                    ...NO_FILTERS,
                    includeReferences: current.includeReferences,
                  }));
                }}
              >
                Clear all filters
              </Button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {state !== null && (
        <div
          role="status"
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground',
            isPartial(state) && 'text-amber-700 dark:text-amber-400',
          )}
        >
          <Info aria-hidden="true" className="size-3.5" />
          {describeCompleteness(state).map((line) => (
            <span key={line}>{line}</span>
          ))}
          {filterCount > 0 && <span>Filters active ({filterCount}).</span>}
          {focus !== null && (
            <span className="flex items-center gap-1 text-foreground">
              Focus mode: {state.nodes.get(focus.centerId)?.title ?? 'node'} and its connections.
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                onClick={() => changeFocus(null)}
              >
                Exit focus
              </Button>
            </span>
          )}
          {collapsedMapIds.size > 0 && (
            <span className="flex items-center gap-1 text-foreground">
              {collapsedMapIds.size === 1
                ? '1 map collapsed.'
                : `${collapsedMapIds.size} maps collapsed.`}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                onClick={() => setCollapsedMapIds(new Set())}
              >
                Expand all
              </Button>
            </span>
          )}
          {regionView.omitted > 0 && (
            <span>Regions shown for {MAX_REGIONS} maps; choose maps in Filters to see others.</span>
          )}
          {highlightedMap !== null && (
            <span className="flex items-center gap-1 text-foreground">
              Highlighting map “{highlightedMap.title}”.
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                aria-label="Stop highlighting the map"
                onClick={() => setHighlightedMapId(null)}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-md border">
          <div className={cn('h-full', tab !== 'graph' && 'hidden')}>
            {canvasSetup !== null && (
              <GraphCanvas
                ref={canvas}
                elements={elements}
                emphasis={emphasis}
                focusNodeIds={focusIds}
                selectedNodeId={selectedId}
                showAllLabels={showAllLabels}
                regions={regionView.regions}
                fitRequest={fitRequest}
                arrangeOnLoad={canvasSetup.arrangeOnLoad}
                onSelect={onCanvasSelect}
                onOpenNode={(id) => {
                  if (!isSummaryId(id)) onOpenNode(id);
                }}
                onPositionsChanged={onPositionsChanged}
              />
            )}
            {state !== null && state.nodes.size === 0 && (
              <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {filterCount > 0
                  ? 'No nodes match the current filters.'
                  : 'Your graph is empty. Create nodes and relationships to see them here.'}
              </p>
            )}
          </div>
          {tab === 'list' && (
            <ul aria-label="Nodes and their connections" className="h-full divide-y overflow-auto">
              {listItems.map((item) => (
                <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium" dir="auto">
                      {item.title}
                    </p>
                    {item.maps.length > 0 && (
                      <p className="text-xs text-muted-foreground" dir="auto">
                        Maps: {item.maps.join(', ')}
                      </p>
                    )}
                    {item.connections.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No connections shown.</p>
                    ) : (
                      <ul className="text-xs text-muted-foreground">
                        {item.connections.map((connection) => (
                          <li key={connection} dir="auto">
                            {connection}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Open ${item.title}`}
                    onClick={() => onOpenNode(item.id)}
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Focus on ${item.title}`}
                    onClick={() => {
                      setSelectedId(item.id);
                      changeFocus({ centerId: item.id, expanded: [] });
                    }}
                  >
                    <Focus aria-hidden="true" />
                    Focus
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Expand neighbors of ${item.title}`}
                    onClick={() => void expand(item.id)}
                  >
                    Expand
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected !== null && (
          <GraphNodePanel
            key={selected.id}
            nodeId={selected.id}
            maps={state?.maps ?? []}
            memberships={selected.mapIds}
            mapColors={colors}
            highlightedMapId={highlightedMapId}
            isFocused={focus?.centerId === selected.id}
            onClose={() => setSelectedId(null)}
            onOpenNote={() => onOpenNode(selected.id)}
            onFocus={() =>
              changeFocus(
                focus?.centerId === selected.id ? null : { centerId: selected.id, expanded: [] },
              )
            }
            onExpand={() => void expand(selected.id)}
            onHighlightMap={(mapId) => {
              setHighlightedMapId(mapId);
              // A map highlight replaces the selection emphasis so the map's members stand out.
              if (mapId !== null) setSelectedId(null);
            }}
            onOpenMap={onOpenMap}
            onRelatingChange={(relating) => {
              setRelatingFor(relating ? selected.id : null);
              setGraphPick(null);
            }}
            graphPick={graphPick?.forNodeId === selected.id ? graphPick.node : null}
          />
        )}
      </div>
      <GraphLegend showMaps={showMaps} state={state} colors={colors} />
    </section>
  );
}

/** Explains the visual language in words (PRD §6: no color-only meaning). */
function GraphLegend({
  showMaps,
  state,
  colors,
}: {
  showMaps: boolean;
  state: GraphState | null;
  colors: ReadonlyMap<string, string>;
}) {
  const maps = state?.maps ?? [];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-xs text-muted-foreground">
      <p>
        <span aria-hidden="true">→ </span>directed relationship · <span aria-hidden="true">— </span>
        undirected · <span aria-hidden="true">┄ </span>note link
      </p>
      {showMaps && maps.length > 0 && (
        <ul aria-label="Map colors" className="flex flex-wrap gap-x-2 gap-y-0.5">
          {maps.slice(0, 8).map((map) => (
            <li key={map.id} className="flex max-w-[9rem] items-center gap-1">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: colors.get(map.id) }}
              />
              <span className="truncate" dir="auto">
                {map.title}
              </span>
            </li>
          ))}
          {maps.length > 8 && <li>+{maps.length - 8} more (see Filters)</li>}
        </ul>
      )}
      {showMaps && <p>Hover a node for the names of its maps.</p>}
    </div>
  );
}
