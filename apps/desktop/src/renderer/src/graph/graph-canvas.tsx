/**
 * Cytoscape canvas of the knowledge graph (PRD §5.7).
 *
 * Behavior:
 * - Positions are stable. Elements are synchronized incrementally: new nodes arrive with a
 *   position chosen by the view (see `graph-layout.ts`), existing nodes are never moved by a data
 *   change, selection or filter. Only the explicit Rearrange action lays out the whole graph.
 * - Dragging a node is reported (debounced) so the view can save the position. Positions are
 *   graph-only visual state and never touch mind map placements.
 * - The view opens fitted to the graph and fits again when asked (`fitRequest`: after a filter
 *   change or entering/leaving Focus), never because of edits made elsewhere.
 * - Emphasis (a selected node's neighborhood, or a highlighted map) dims everything else; Focus
 *   mode hides everything outside the focus set. Both are classes, not removals.
 * - Relationship labels appear on hover and for the emphasized edges; "show all labels" shows
 *   every label. Node labels are truncated with an ellipsis; the full title (and map membership)
 *   appears in a tooltip on hover.
 * - Automatic zoom (fit) is capped, so a single node or a small graph keeps a normal size.
 *
 * Map regions (optional) are drawn on an SVG layer behind the graph: a soft, padded outline
 * around each shown map's visible members, labeled with the map title. Regions may overlap, so a
 * node shared by several maps sits inside each of their regions while remaining one node. The
 * layer is redrawn whenever Cytoscape renders (pan, zoom, drag).
 *
 * Maps as drawn (optional, see `graph-map-groups.ts`): maps are compound "group" nodes and a node
 * on several maps has copies. A copy acts as its node (`nodeId`) for selection, opening, emphasis
 * and Focus; double-clicking a group opens the map. In this mode positions come from the maps
 * (`followPositions`), so existing nodes move when a map changed.
 *
 * The canvas itself is not keyboard-operable; the List view presents the same information and
 * actions (PRD §6).
 */

import cytoscape from 'cytoscape';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

import type { CytoscapeElement, Emphasis } from './graph-model';
import { nodeKeyOf } from './graph-map-groups';
import { convexHull, type RegionSpec } from './graph-regions';

/** Largest zoom used when fitting automatically (Fit to View, Rearrange, first visit). */
const MAX_AUTO_ZOOM = 1.2;
/** Largest margin kept around the graph when fitting; smaller canvases get proportionally less. */
const FIT_PADDING = 50;

/** Fit margin for the current canvas: 8% of its shorter side, at most FIT_PADDING. */
function fitPadding(cy: cytoscape.Core): number {
  return Math.min(FIT_PADDING, Math.round(Math.min(cy.width(), cy.height()) * 0.08));
}
const SAVE_DELAY_MS = 500;

/** The knowledge node a canvas node stands for (a copy's node, or the node itself). */
function keyOf(node: cytoscape.NodeSingular): string {
  return nodeKeyOf(node.data() as Record<string, unknown>);
}
const BADGE_SLICES = 7;

export interface GraphCanvasHandle {
  zoomBy(factor: number): void;
  fit(): void;
  rearrange(): void;
  center(nodeId: string): void;
  /** Re-measures the container (after it was hidden, e.g. while the List view was shown). */
  resize(): void;
}

export interface GraphCanvasProps {
  readonly ref?: Ref<GraphCanvasHandle>;
  readonly elements: readonly CytoscapeElement[];
  readonly emphasis: Emphasis;
  /** Focus mode: only these nodes (and edges among them) are shown; null shows everything. */
  readonly focusNodeIds: ReadonlySet<string> | null;
  readonly selectedNodeId: string | null;
  readonly showAllLabels: boolean;
  /** Map regions to draw behind the graph; empty for none. */
  readonly regions: readonly RegionSpec[];
  /** Changing this number fits the visible graph to the view. */
  readonly fitRequest: number;
  /** Lay out the whole graph once after loading (first visit: nothing saved yet). */
  readonly arrangeOnLoad: boolean;
  /** Maps as drawn: existing nodes move to the positions given (they come from the maps). */
  readonly followPositions?: boolean;
  /** Double-click on a map group. */
  readonly onOpenMap?: (mapId: string) => void;
  readonly onSelect: (nodeId: string | null) => void;
  readonly onOpenNode: (nodeId: string) => void;
  readonly onPositionsChanged: (
    positions: readonly { nodeId: string; x: number; y: number }[],
  ) => void;
}

/**
 * Converts any CSS color (the theme uses `oklch()`, which Cytoscape cannot parse) to `rgb()` by
 * painting one pixel. Falls back when the variable is missing.
 */
function themeColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (value === '') return fallback;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${red ?? 0}, ${green ?? 0}, ${blue ?? 0})`;
}

function graphStyle(): cytoscape.StylesheetJson {
  const foreground = themeColor('--foreground', '#e5e7eb');
  const muted = themeColor('--muted-foreground', '#9ca3af');
  const background = themeColor('--background', '#0b0d12');
  const primary = themeColor('--primary', '#60a5fa');
  const card = themeColor('--card', '#16181d');
  const pie: Record<string, string> = {};
  for (let index = 1; index <= BADGE_SLICES; index += 1) {
    pie[`pie-${index}-background-color`] = `data(pie${index}Color)`;
    pie[`pie-${index}-background-size`] = `data(pie${index}Size)`;
  }
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 11,
        'font-family': 'inherit',
        color: foreground,
        // An outline in the canvas color keeps labels readable over lines without a box.
        'text-outline-color': background,
        'text-outline-width': 2,
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'text-max-width': '130px',
        'text-wrap': 'ellipsis',
        'min-zoomed-font-size': 7,
        'background-color': muted,
        'border-width': 1.5,
        'border-color': background,
        width: 'mapData(degree, 0, 12, 10, 22)',
        height: 'mapData(degree, 0, 12, 10, 22)',
        'transition-property': 'opacity',
        'transition-duration': 120,
      },
    },
    { selector: 'node.in-maps', style: { 'pie-size': '100%', ...pie } },
    { selector: 'node.expanded', style: { 'border-color': foreground, 'border-width': 2 } },
    {
      selector: 'node:selected',
      style: {
        'background-color': primary,
        'border-color': foreground,
        'border-width': 2,
        'font-weight': 'bold',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.2,
        'line-color': muted,
        'line-opacity': 0.55,
        'curve-style': 'bezier',
        label: '',
        'font-size': 10,
        color: foreground,
        'text-outline-color': background,
        'text-outline-width': 2,
        'text-rotation': 'autorotate',
        'transition-property': 'opacity',
        'transition-duration': 120,
      },
    },
    // Direction is shown by the arrowhead, never by color alone (PRD §6).
    {
      selector: 'edge.directed',
      style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': muted, 'arrow-scale': 0.9 },
    },
    {
      selector: 'edge.reference',
      style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4], width: 1, 'line-opacity': 0.7 },
    },
    {
      // Map connectors: dotted with an arrow, unlike relationships (solid) and note links (dashed).
      selector: 'edge.connector',
      style: {
        'line-style': 'dotted',
        width: 1.5,
        'line-opacity': 0.8,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': muted,
        'arrow-scale': 0.8,
      },
    },
    {
      // A collapsed mind map: its name and node count in a rounded box of the map's color.
      selector: 'node.summary',
      style: {
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        padding: '8px',
        'background-color': 'data(color)',
        'background-opacity': 0.25,
        'border-color': 'data(color)',
        'border-width': 2,
        'text-valign': 'center',
        'text-margin-y': 0,
        'font-weight': 'bold',
        'text-max-width': '200px',
      },
    },
    {
      // Several relationships to members of a collapsed map, drawn as one line with a count.
      selector: 'edge.aggregate',
      style: { width: 3, 'line-opacity': 0.6, label: 'data(label)' },
    },
    {
      // Maps as drawn: a map is a framed group named after the map, in the map's color.
      selector: 'node.map-group',
      style: {
        shape: 'round-rectangle',
        'background-color': 'data(color)',
        'background-opacity': 0.06,
        'border-color': 'data(color)',
        'border-width': 1.5,
        'border-opacity': 0.7,
        padding: '28px',
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -6,
        'font-size': 13,
        'font-weight': 'bold',
        color: 'data(color)',
        'text-max-width': '400px',
      },
    },
    {
      // An item of a map group: a box with its title, like on the map.
      selector: 'node.map-item',
      style: {
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        padding: '9px',
        'background-color': card,
        'background-opacity': 1,
        'border-color': muted,
        'border-width': 1,
        'text-valign': 'center',
        'text-margin-y': 0,
        'text-max-width': '220px',
        'font-size': 12,
      },
    },
    { selector: 'node.map-item.in-maps', style: { 'pie-size': '30%' } },
    { selector: 'node.copy', style: { 'border-style': 'dashed' } },
    {
      selector: 'node.map-item:selected, node.selected-copy',
      style: { 'border-color': primary, 'border-width': 2.5, 'font-weight': 'bold' },
    },
    { selector: 'edge.map-line', style: { 'line-opacity': 0.85, width: 1.5 } },
    {
      selector: 'edge.map-line.tree',
      style: { 'line-style': 'solid', 'target-arrow-shape': 'none' },
    },
    {
      selector: 'edge.taxi-downward',
      style: { 'curve-style': 'taxi', 'taxi-direction': 'downward' },
    },
    { selector: 'edge.taxi-upward', style: { 'curve-style': 'taxi', 'taxi-direction': 'upward' } },
    {
      selector: 'edge.taxi-rightward',
      style: { 'curve-style': 'taxi', 'taxi-direction': 'rightward' },
    },
    {
      selector: 'edge.taxi-leftward',
      style: { 'curve-style': 'taxi', 'taxi-direction': 'leftward' },
    },
    {
      // The same node on another map: a faint line between its copy and the node.
      selector: 'edge.same-node',
      style: {
        'curve-style': 'straight',
        'line-style': 'dashed',
        'line-dash-pattern': [2, 6],
        'line-opacity': 0.3,
        width: 1,
      },
    },
    { selector: 'edge.show-label', style: { label: 'data(label)' } },
    { selector: 'edge.emphasized', style: { 'line-opacity': 1, width: 1.8 } },
    { selector: '.dimmed', style: { opacity: 0.15 } },
    { selector: '.focus-hidden', style: { display: 'none' } },
  ];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Draws the regions into `svg` in rendered (screen) coordinates. Uses DOM APIs only: map titles
 * are user content and must never be interpreted as markup.
 */
function drawRegions(svg: SVGSVGElement, cy: cytoscape.Core, regions: readonly RegionSpec[]): void {
  svg.replaceChildren();
  const pad = Math.min(40, Math.max(12, 30 * cy.zoom()));
  for (const region of regions) {
    const points = region.memberIds
      .map((id) => cy.getElementById(id))
      .filter((node) => !node.empty() && node.visible())
      .map((node) => node.renderedPosition());
    if (points.length === 0) continue;
    const hull = convexHull(points);
    const first = hull[0];
    if (first === undefined) continue;
    // One point becomes a dot and two a capsule: the thick round stroke pads every shape.
    const path =
      hull.length === 1
        ? `M ${first.x} ${first.y} L ${first.x + 0.01} ${first.y}`
        : `M ${hull.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('opacity', '0.13');
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute('d', path);
    shape.setAttribute('fill', region.color);
    shape.setAttribute('stroke', region.color);
    shape.setAttribute('stroke-width', String(pad * 2));
    shape.setAttribute('stroke-linejoin', 'round');
    shape.setAttribute('stroke-linecap', 'round');
    group.append(shape);
    svg.append(group);
    // The label sits just above the region's topmost point, so it stays next to the region
    // even when the region is a long diagonal.
    const highest = hull.reduce((best, point) => (point.y < best.y ? point : best), first);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(highest.x));
    label.setAttribute('y', String(highest.y - pad - 4));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', region.color);
    label.setAttribute('font-size', '11');
    label.setAttribute('font-weight', '600');
    label.textContent = region.title;
    svg.append(label);
  }
}

interface Tooltip {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly maps: string;
}

export function GraphCanvas({
  ref,
  elements,
  emphasis,
  focusNodeIds,
  selectedNodeId,
  showAllLabels,
  regions,
  fitRequest,
  arrangeOnLoad,
  followPositions = false,
  onOpenMap,
  onSelect,
  onOpenNode,
  onPositionsChanged,
}: GraphCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const regionLayer = useRef<SVGSVGElement>(null);
  const latestRegions = useRef(regions);
  const instance = useRef<cytoscape.Core | null>(null);
  const loaded = useRef(false);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  // Latest callbacks and options, so listeners registered once always use the current ones.
  const latest = useRef({
    onSelect,
    onOpenNode,
    onOpenMap,
    onPositionsChanged,
    showAllLabels,
  });
  useEffect(() => {
    latest.current = { onSelect, onOpenNode, onOpenMap, onPositionsChanged, showAllLabels };
  }, [onSelect, onOpenNode, onOpenMap, onPositionsChanged, showAllLabels]);

  /**
   * True while the view shows the graph fitted (after opening, Fit, filter or Focus changes). A
   * pan or zoom by the user ends it; while it lasts, a change of the canvas size (filter panel,
   * side panel, window) fits again so the graph stays fully in view.
   */
  const autoFit = useRef(true);

  /**
   * Fits the visible elements, never zooming in beyond MAX_AUTO_ZOOM. When opening Maps as drawn
   * it fits the map groups instead, so many notes on no map do not make the maps tiny; that
   * choice holds for later automatic fits (resizes, filters) until Fit is pressed.
   */
  const fitMapsFirst = useRef(false);
  const fitCapped = (cy: cytoscape.Core, mapsFirst?: boolean) => {
    if (mapsFirst !== undefined) fitMapsFirst.current = mapsFirst;
    autoFit.current = true;
    // Cytoscape caches the container size; refresh it so the fit uses the current size.
    cy.resize();
    const groups = cy.nodes('.map-group:visible');
    const visible =
      fitMapsFirst.current && groups.nonempty()
        ? groups.union(groups.descendants())
        : cy.elements(':visible');
    if (visible.length === 0) return;
    cy.fit(visible, fitPadding(cy));
    if (cy.zoom() > MAX_AUTO_ZOOM) {
      cy.zoom(MAX_AUTO_ZOOM);
      cy.center(visible);
    }
  };

  const reportPositions = (nodes: cytoscape.NodeCollection) => {
    latest.current.onPositionsChanged(
      nodes.map((node) => ({
        nodeId: node.id(),
        x: Math.round(node.position('x')),
        y: Math.round(node.position('y')),
      })),
    );
  };

  const rearrange = (cy: cytoscape.Core) => {
    const visible = cy.elements(':visible');
    if (visible.nodes().length === 0) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Settings measured on a mixed sample graph in the app: compact, wider than tall (like the
    // canvas) and without label overlaps (labels count as part of each node). The layout animates
    // only from the old to the final positions ('end'); animating every iteration would report
    // intermediate, spread-out positions and fit to those.
    const layout = visible.layout({
      name: 'cose',
      randomize: false,
      // 'end' is supported by the cose layout but missing from Cytoscape's type definitions.
      animate: (!reducedMotion && visible.nodes().length < 400 ? 'end' : false) as boolean,
      animationDuration: 350,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: () => 70,
      nodeRepulsion: () => 4_000,
      nodeOverlap: 4,
      gravity: 3,
      componentSpacing: 40,
      padding: FIT_PADDING,
      fit: false,
    });
    layout.one('layoutstop', () => {
      fitCapped(cy);
      reportPositions(visible.nodes());
      if (container.current !== null) {
        container.current.dataset.renderedNodes = String(
          cy.nodes(':visible').not('.map-group, .copy').length,
        );
      }
    });
    layout.run();
  };

  useImperativeHandle(ref, () => ({
    zoomBy: (factor) => {
      const cy = instance.current;
      if (cy === null) return;
      autoFit.current = false;
      cy.zoom({
        level: Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor)),
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      });
    },
    fit: () => {
      if (instance.current !== null) fitCapped(instance.current, false);
    },
    rearrange: () => {
      if (instance.current !== null) rearrange(instance.current);
    },
    resize: () => instance.current?.resize(),
    center: (nodeId) => {
      const cy = instance.current;
      const node = cy?.getElementById(nodeId);
      if (cy === null || cy === undefined || node === undefined || node.empty()) return;
      autoFit.current = false;
      cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 250 });
    },
  }));

  useEffect(() => {
    if (container.current === null) return;
    const cy = cytoscape({
      container: container.current,
      style: graphStyle(),
      minZoom: 0.05,
      maxZoom: 3,
      selectionType: 'single',
      boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      // A map group is a frame, not a node: a click on it is like a click on the background.
      latest.current.onSelect(node.hasClass('map-group') ? null : keyOf(node));
    });
    cy.on('tap', (event) => {
      if (event.target === cy) latest.current.onSelect(null);
    });
    cy.on('dbltap', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      if (node.hasClass('map-group')) latest.current.onOpenMap?.(String(node.data('mapId')));
      else latest.current.onOpenNode(keyOf(node));
    });
    cy.on('mouseover', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const position = node.renderedPosition();
      setTooltip({
        x: position.x,
        y: position.y,
        title: String(node.data('label')),
        maps: node.hasClass('map-group') ? '' : String(node.data('mapsText') ?? ''),
      });
    });
    cy.on('mouseout', 'node', () => setTooltip(null));
    cy.on('mouseover', 'edge', (event) =>
      (event.target as cytoscape.EdgeSingular).addClass('show-label'),
    );
    cy.on('mouseout', 'edge', (event) => {
      const edge = event.target as cytoscape.EdgeSingular;
      if (!latest.current.showAllLabels && !edge.hasClass('emphasized'))
        edge.removeClass('show-label');
    });
    cy.on('pan zoom', () => setTooltip(null));
    // Regions follow every redraw (pan, zoom, drag, layout), at most once per frame.
    let regionFrame = 0;
    cy.on('render', () => {
      cancelAnimationFrame(regionFrame);
      regionFrame = requestAnimationFrame(() => {
        if (regionLayer.current !== null) {
          drawRegions(regionLayer.current, cy, latestRegions.current);
        }
      });
    });
    // The user moved the view: from now on a size change keeps their view instead of refitting.
    cy.on('dragpan scrollzoom pinchzoom', () => {
      autoFit.current = false;
    });

    let dragged = cy.collection();
    let dragTimer: ReturnType<typeof setTimeout> | null = null;
    cy.on('dragfree', 'node', (event) => {
      dragged = dragged.union(event.target as cytoscape.NodeSingular);
      if (dragTimer !== null) clearTimeout(dragTimer);
      dragTimer = setTimeout(() => {
        reportPositions(dragged.filter((node) => node.inside()));
        dragged = cy.collection();
      }, SAVE_DELAY_MS);
    });

    // Cytoscape caches its container size; follow size changes (filter panel, side panel,
    // window) so drawing and fitting always use the real size.
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        cy.resize();
        if (autoFit.current && loaded.current) fitCapped(cy);
      });
    });
    observer.observe(container.current);

    instance.current = cy;
    return () => {
      if (dragTimer !== null) clearTimeout(dragTimer);
      observer.disconnect();
      cancelAnimationFrame(regionFrame);
      cancelAnimationFrame(resizeFrame);
      cy.destroy();
      instance.current = null;
    };
  }, []);

  // Incremental synchronization: remove what is gone, add what is new (at its given position),
  // update data and classes of the rest. Existing nodes keep their positions.
  useEffect(() => {
    const cy = instance.current;
    if (cy === null) return;
    const wanted = new Map(elements.map((element) => [String(element.data.id), element]));
    cy.batch(() => {
      cy.elements().forEach((element) => {
        if (!wanted.has(element.id())) element.remove();
      });
      const additions: cytoscape.ElementDefinition[] = [];
      for (const [id, element] of wanted) {
        const existing = cy.getElementById(id);
        if (existing.empty()) {
          additions.push({
            group: element.group,
            data: { ...element.data },
            ...(element.position === undefined ? {} : { position: { ...element.position } }),
            classes: element.classes ?? '',
          });
        } else {
          // The parent cannot be changed through data(); a node that changed group is moved.
          const { parent, ...data } = element.data;
          existing.data(data);
          existing.classes(element.classes ?? '');
          if (existing.isNode()) {
            const currentParent = existing.parent().empty()
              ? undefined
              : existing.parent().first().id();
            const wantedParent = parent === undefined ? undefined : String(parent);
            if (currentParent !== wantedParent) existing.move({ parent: wantedParent ?? null });
            if (followPositions && element.position !== undefined && !existing.isParent()) {
              existing.position({ ...element.position });
            }
          }
        }
      }
      // Nodes first, so edges always find their endpoints.
      cy.add(additions.filter((item) => item.group === 'nodes'));
      cy.add(additions.filter((item) => item.group === 'edges'));
    });
    if (container.current !== null) {
      // Maps as drawn, for tests and diagnostics: how many maps and copies are drawn.
      container.current.dataset.mapGroups = String(cy.nodes('.map-group').length);
      container.current.dataset.mapCopies = String(cy.nodes('.copy').length);
    }

    if (!loaded.current && elements.length > 0) {
      loaded.current = true;
      // The graph always opens fitted to view (laid out first on a first visit).
      if (arrangeOnLoad) {
        rearrange(cy);
      } else {
        fitCapped(cy, followPositions);
        if (container.current !== null) {
          container.current.dataset.renderedNodes = String(
            cy.nodes().not('.map-group, .copy').length,
          );
        }
      }
    } else if (container.current !== null) {
      container.current.dataset.renderedNodes = String(
        cy.nodes(':visible').not('.map-group, .copy').length,
      );
    }
    // Only element changes trigger a synchronization; the other values are read once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements]);

  // Emphasis, focus, labels and selection: classes only, so nothing moves.
  useEffect(() => {
    const cy = instance.current;
    if (cy === null) return;
    cy.batch(() => {
      cy.elements().removeClass('dimmed emphasized focus-hidden');
      const items = cy.nodes().not('.map-group');
      if (focusNodeIds !== null) {
        items.forEach((node) => {
          if (!focusNodeIds.has(keyOf(node))) node.addClass('focus-hidden');
        });
        cy.nodes('.map-group').forEach((group) => {
          if (group.children().not('.focus-hidden').empty()) group.addClass('focus-hidden');
        });
      }
      if (emphasis.nodes !== null) {
        items.forEach((node) => {
          if (!emphasis.nodes?.has(keyOf(node))) node.addClass('dimmed');
        });
        cy.edges().forEach((edge) => {
          // Map lines are emphasized when both of their ends are.
          const mapLine = edge.hasClass('map-line') || edge.hasClass('same-node');
          const strong = mapLine
            ? emphasis.nodes?.has(keyOf(edge.source())) === true &&
              emphasis.nodes.has(keyOf(edge.target()))
            : emphasis.edges?.has(edge.id()) === true;
          edge.addClass(strong ? 'emphasized' : 'dimmed');
        });
      }
      cy.edges().forEach((edge) => {
        if (showAllLabels || edge.hasClass('emphasized')) edge.addClass('show-label');
        else edge.removeClass('show-label');
      });
      cy.nodes(':selected').unselect();
      cy.nodes('.selected-copy').removeClass('selected-copy');
      if (selectedNodeId !== null) {
        cy.getElementById(selectedNodeId).select();
        cy.nodes('.copy')
          .filter((node) => node.data('nodeId') === selectedNodeId)
          .addClass('selected-copy');
      }
    });
  }, [elements, emphasis, focusNodeIds, showAllLabels, selectedNodeId]);

  // Fits on request, after the class effect above so elements hidden by Focus mode are excluded.
  // The initial value belongs to the first load, which fits by itself.
  const fittedRequest = useRef(fitRequest);
  useEffect(() => {
    const cy = instance.current;
    if (cy === null || fitRequest === fittedRequest.current) return;
    fittedRequest.current = fitRequest;
    fitCapped(cy);
  }, [fitRequest, elements, focusNodeIds]);

  useEffect(() => {
    latestRegions.current = regions;
    const cy = instance.current;
    if (cy !== null && regionLayer.current !== null) drawRegions(regionLayer.current, cy, regions);
  }, [regions, elements, focusNodeIds]);

  return (
    <div className="relative h-full w-full">
      <svg
        ref={regionLayer}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      <div
        ref={container}
        className="relative h-full w-full"
        role="img"
        aria-label="Knowledge graph. Use the List view for a keyboard-accessible version of the same information."
      />
      {tooltip !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-xs -translate-x-1/2 rounded-md border bg-background px-2 py-1 text-xs text-foreground shadow-md"
          style={{ left: tooltip.x, top: tooltip.y + 18 }}
        >
          <p className="font-medium" dir="auto">
            {tooltip.title}
          </p>
          {tooltip.maps !== '' && <p className="text-muted-foreground">Maps: {tooltip.maps}</p>}
        </div>
      )}
    </div>
  );
}
