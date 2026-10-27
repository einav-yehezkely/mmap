# ADR-0009: Mind map editing

- Status: Accepted
- Date: 2026-10-27

## Context

PRD §4.4 and §5.6 require several mind maps per workspace that place canonical nodes (never
copies), with a freeform mode (drag, pan, zoom, fit to view, selection, connectors that may form
cycles) and a hierarchical mode (several roots, one parent per item, sibling order, collapse,
deterministic tree layout, no cycles). Viewport, coordinates, styling and hierarchy must survive
restarts. Switching to hierarchical mode requires a reviewed parent assignment when connectors are
ambiguous, and the previous freeform coordinates must be kept for switching back. PRD §5.6 names
React Flow for map interaction and asks for keyboard alternatives for adding, opening and moving
items. PRD §14 requires revision checks for map structure, and warns against confusing visual
structure with meaning: map hierarchy must never create `part of` relationships (PRD §4.4).

Migration 1 already contains the tables (`mind_maps`, `map_placements`, `map_connections`), the
cycle trigger and a parent foreign key that refuses to orphan children. The renderer is untrusted
and sandboxed; all persistent state is owned by the main process ([ADR-0003](0003-electron-version-and-security-baseline.md)).

## Decision

1. **React Flow for interaction, the main process for state.** The canvas uses React Flow
   (`@xyflow/react` 12.12.0, bundled). It holds only transient UI state: selection and an item's
   position while it is being dragged. Every lasting change (positions, parents, order, collapse,
   color, connectors, mode, viewport) is sent through a `maps:*` channel to `MapService`, and the
   canvas is rebuilt from the map view that the main process returns.
2. **One map revision for every structural change, and a queue in the renderer.** Each structural
   request names the map revision the renderer last saw. `MapService` checks it, applies the
   change and stores the next revision in one write transaction; a stale revision is
   `REVISION_CONFLICT` and changes nothing. The viewport is visual state and is saved without a
   revision. The renderer (`use-map-document.ts`) sends changes one at a time, each with the
   revision of the latest view, so its own quick edits never conflict with each other. On a
   conflict it reloads the map and tells the user that the last change was not applied.
3. **Hierarchical layout is computed, never stored.** `layoutTree`
   (`packages/domain/src/maps/tree-layout.ts`) derives positions from parent, sibling order and
   collapse state only, deterministically and independent of input order. It is a pure domain
   function, run in the renderer each time the map is shown. Placements store only freeform
   coordinates, which hierarchical mode never changes.
4. **Reviewed freeform → hierarchy conversion.** If the map was a hierarchy before, the stored
   parents (kept while in freeform mode) are proposed unchanged, so a round trip gives back the
   same tree. Otherwise `proposeHierarchy` suggests parents with simple rules that the user can
   predict: a connector A → B suggests A as the parent of B; an item with no incoming connector
   becomes a root; an item with connectors from several items, or whose connector would close a
   loop, is ambiguous and is not guessed. The dialog requires a decision for every ambiguous
   item. The main process validates the complete assignment again (one entry per item, known
   parents, no cycle) before switching. Switching to freeform changes only the mode.
5. **An outline as the keyboard alternative.** Next to the canvas, `map-outline.tsx` shows the
   map's items as a WAI-ARIA tree with keys to add, open, remove, collapse, reorder, indent and
   outdent. Hierarchy changes are made there (as `maps:reparent` with a planned target), not by
   dragging on the canvas.
6. **Map structure never creates meaning.** No map operation writes relationships. A connector may
   reference an existing relationship only when that relationship connects exactly the same two
   nodes. Hierarchy lines and connectors are drawn differently (solid lines vs. dashed arrows)
   and explained in a legend.

## Consequences

- One source of truth: closing the window or crashing loses at most the change that was being
  sent, never a whole layout held in the renderer.
- Every change returns the complete map view. That is simple and keeps the canvas consistent, but
  costs a full reload of the map per change; it is fast enough for the PRD's map sizes (the
  packaged smoke test opens a 200-item map in well under the 2-second target), but not yet
  measured for 500 items on the reference machine.
- Changes are serialized per map in the renderer, so a slow request delays the next one instead of
  causing a conflict.
- Switching modes, duplicating a map and a future import never have to convert or recompute
  stored hierarchical positions, and switching back to freeform always restores the previous
  positions exactly. In exchange, items cannot be dragged in hierarchical mode, and the user cannot
  fine-tune a tree layout.
- The layout runs on every view change in the renderer. It is iterative and near-linear (tested
  with 10,000 items), so it does not need a worker today.
- Connectors drawn while a map is freeform do not change a hierarchy it had before; once a map has
  stored parents, the connectors are no longer used for the proposal. The user can still change
  any proposed parent in the dialog or afterwards in the outline.
- Keyboard users can do everything through the outline, but moving an item under a distant parent
  takes several indent and outdent steps; a "move to…" picker is follow-up work.
- The CSP keeps `style-src 'unsafe-inline'`, which React Flow needs like Tiptap and KaTeX; inline
  scripts stay forbidden.
- Linking a connector to a relationship and labelling a connector are supported by the service and
  channel but have no UI yet.

## Alternatives considered

- **Keeping map state in the renderer and saving it periodically.** Fewer requests, but the main
  process would no longer be the authority, a crash could lose layout work, and revision checks
  would cover whole snapshots instead of single changes. Rejected.
- **No revisions, last write wins.** Simpler, but PRD §14 requires revision checks for map
  structure, and a second window (PRD §5.1) would silently overwrite changes. Rejected.
- **Storing hierarchical positions.** Would allow manual tweaks of the tree, but every reparent,
  reorder, collapse or removal would have to rewrite subtrees, the picture would depend on stored
  pixels instead of the hierarchy, and freeform and hierarchical positions would need two sets of
  columns. Rejected.
- **A layout library (for example dagre or ELK).** More layout options, but another dependency,
  less control over determinism, and nothing the simple left-to-right tree needs. Rejected for
  now.
- **Converting automatically without review**, for example by taking the first connector. That
  would choose parents the user never chose, against PRD §5.6 and the PRD's ban on inferred
  structure (§1). Rejected.
- **Drag-and-drop reparenting as the only way to change the hierarchy.** Not usable from the
  keyboard (PRD §6) and harder to make precise. The outline is the primary way; canvas drag
  reparenting can be added later on top of the same `maps:reparent` channel.
