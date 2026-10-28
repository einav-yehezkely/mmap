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
 * The canvas itself is not keyboard-operable; the List view presents the same information and
 * actions (PRD §6).
 */

import cytoscape from 'cytoscape';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

import type { CytoscapeElement, Emphasis } from './graph-model';
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
    onPositionsChanged,
    showAllLabels,
  });
  useEffect(() => {
    latest.current = { onSelect, onOpenNode, onPositionsChanged, showAllLabels };
  }, [onSelect, onOpenNode, onPositionsChanged, showAllLabels]);

  /**
   * True while the view shows the graph fitted (after opening, Fit, filter or Focus changes). A
   * pan or zoom by the user ends it; while it lasts, a change of the canvas size (filter panel,
   * side panel, window) fits again so the graph stays fully in view.
   */
  const autoFit = useRef(true);

  /** Fits the visible elements, never zooming in beyond MAX_AUTO_ZOOM. */
  const fitCapped = (cy: cytoscape.Core) => {
    autoFit.current = true;
    // Cytoscape caches the container size; refresh it so the fit uses the current size.
    cy.resize();
    const visible = cy.elements(':visible');
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
        container.current.dataset.renderedNodes = String(cy.nodes(':visible').length);
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
      if (instance.current !== null) fitCapped(instance.current);
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
      latest.current.onSelect((event.target as cytoscape.NodeSingular).id());
    });
    cy.on('tap', (event) => {
      if (event.target === cy) latest.current.onSelect(null);
    });
    cy.on('dbltap', 'node', (event) => {
      latest.current.onOpenNode((event.target as cytoscape.NodeSingular).id());
    });
    cy.on('mouseover', 'node', (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const position = node.renderedPosition();
      setTooltip({
        x: position.x,
        y: position.y,
        title: String(node.data('label')),
        maps: String(node.data('mapsText') ?? ''),
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
          existing.data({ ...element.data });
          existing.classes(element.classes ?? '');
        }
      }
      // Nodes first, so edges always find their endpoints.
      cy.add(additions.filter((item) => item.group === 'nodes'));
      cy.add(additions.filter((item) => item.group === 'edges'));
    });

    if (!loaded.current && elements.length > 0) {
      loaded.current = true;
      // The graph always opens fitted to view (laid out first on a first visit).
      if (arrangeOnLoad) {
        rearrange(cy);
      } else {
        fitCapped(cy);
        if (container.current !== null) {
          container.current.dataset.renderedNodes = String(cy.nodes().length);
        }
      }
    } else if (container.current !== null) {
      container.current.dataset.renderedNodes = String(cy.nodes(':visible').length);
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
      if (focusNodeIds !== null) {
        cy.nodes().forEach((node) => {
          if (!focusNodeIds.has(node.id())) node.addClass('focus-hidden');
        });
      }
      if (emphasis.nodes !== null) {
        cy.nodes().forEach((node) => {
          if (!emphasis.nodes?.has(node.id())) node.addClass('dimmed');
        });
        cy.edges().forEach((edge) => {
          if (emphasis.edges?.has(edge.id())) edge.addClass('emphasized');
          else edge.addClass('dimmed');
        });
      }
      cy.edges().forEach((edge) => {
        if (showAllLabels || edge.hasClass('emphasized')) edge.addClass('show-label');
        else edge.removeClass('show-label');
      });
      cy.nodes(':selected').unselect();
      if (selectedNodeId !== null) cy.getElementById(selectedNodeId).select();
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
