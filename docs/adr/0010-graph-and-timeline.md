# ADR-0010: Knowledge graph and learning timeline

- Status: Accepted
- Date: 2026-10-27

## Context

PRD §5.7 asks for a global graph of canonical nodes and semantic relationships, drawn with
Cytoscape, with directed arrows, relationship labels on demand, an optional and distinct
note-reference layer, deterministic layouts, filters by text, tags and relationship types, and
expansion of a node's neighborhood. Large workspaces must use bounded loading and visible result
limits; the view must "never silently imply that a partial view contains all nodes". PRD §9
caps the initial graph at 1,000 nodes and 3,000 edges, rendered within 3 seconds, on a dataset of
10,000 nodes and 30,000 relationships. PRD §6 and acceptance criterion 14 require graph
information to be available as an accessible list. PRD §14 asks for bounded neighborhoods,
debounced filters and isolated expensive layouts.

PRD §5.9 asks for a reverse-chronological timeline of node creation, grouped note edits,
relationship creation and user-triggered `reviewed` events with a short reflection, filtered by
date range, tag, event type and node. Timestamps are stored in UTC and dates are shown in the
user's selected timezone. The timeline represents recorded activity, not an inferred measure of
understanding, and imported history must be marked as imported (acceptance criterion 11).

A redesign of the graph screen within Phase 4 added mind map membership, saved positions, a
side panel and Focus mode; this record describes the redesigned graph and notes what it replaced.
A redesign of the timeline within Phase 4 replaced the day-grouped list with a visual learning
timeline (a horizontal time axis), added learning milestones and let the user say when learning
actually happened; decisions 10 to 14 describe it. The first list is kept as the List tab.

Migration 1 already has `timeline_events` (with `reflection`, `is_imported`, `import_origin`) and
`workspaces.timezone`. The renderer is untrusted ([ADR-0003](0003-electron-version-and-security-baseline.md));
all database work runs on the main process thread.

## Decision

1. **Cytoscape with stable, saved positions.** The graph uses Cytoscape 3.34.3 (bundled).
   _Revised by the graph redesign within Phase 4; the first version used the concentric layout by
   degree and stored nothing._ Positions are visual state, saved per workspace in
   `graph_node_positions` (migration 3), separate from mind map placements and never part of
   knowledge. Saved positions are reused; nodes without one are placed deterministically next to
   their placed neighbors (`graph-layout.ts`), so edits, selections and filter changes never move
   what is on screen. A full layout (`cose`, settings measured in the app, animated only to the
   end result) runs only on an explicit **Rearrange**, or automatically on opening when nothing is
   saved or most nodes are new, for up to 300 nodes. The viewport is not stored: the graph always
   opens fitted to view, and refits after filter and Focus changes, with automatic zoom capped at
   1.2. Directed relationships have arrows, undirected ones none; type labels appear on hover and
   selection, or always on request; note references are a separate dashed layer, off by default.
2. **Bounded slices with explicit totals.** The `GraphQuery` port returns slices, never the whole
   workspace: an overview of at most 1,000 nodes ranked by degree, then title, then ID, with at
   most 3,000 relationships (and 3,000 references) among them, and neighborhoods of at most 200
   neighbors. `GraphService` clamps every request to these caps. Every slice carries `totalNodes`
   and truncation flags, and the view always prints a completeness statement ("Partial view:
   showing X of Y…" or "Showing all N…"), plus a line for each truncated layer or partial
   expansion.
3. **Simple scans, ranking and joining in TypeScript.** `SqliteGraphQuery` runs one simple,
   indexed query per table (candidate nodes with tag and text conditions, relationships within the
   type filter, grouped note references), with bound parameters, and computes degrees, ranking,
   the cut and the edges among the shown nodes in TypeScript. Reason: earlier SQL-heavy versions
   depended on SQLite's plan choices on the PRD dataset. Timed during development with temporary
   instrumentation (not by the committed benchmark), node-ID lists expanded with
   `json_each` were re-evaluated per row (about 600 ms for the edges among 1,000 nodes), and
   correlated per-node degree counts with a type filter made SQLite pick the type index and took
   minutes. The simple scans are linear in the workspace size.
4. **A list as the accessible alternative.** The Cytoscape canvas is not keyboard-operable. A
   **List** tab next to it shows exactly the shown nodes, sorted by title, with their mind maps and
   every relationship and note link written out in words including direction, and Open, Focus and
   Expand buttons. The canvas is labelled as an image that points to the list.
5. **Recorded activity is immutable; reviews belong to the user.** `node_created`,
   `note_updated` and `relationship_created` are written by the services that make the change, in
   the same transaction, and no channel can edit or delete them (`INVARIANT_VIOLATION`). Only
   `reviewed` events can be created, have their reflection edited, or be deleted by the user.
   Nothing derives a score or level of understanding from the events. _Extended by the timeline
   redesign: milestones are user-owned too, and a learning date may be set on any event (decisions
   11 and 12)._
6. **Timezone-local date filters.** The workspace stores one IANA timezone, validated against the
   runtime's `Intl`. The renderer sends date filters as local calendar dates; the domain converts
   them into a half-open UTC range from the start of the first day to the start of the day after
   the last, handling 23- and 25-hour days and midnights that fall into a DST gap or occur twice.
   Grouping by day uses the same domain function. Stored timestamps stay UTC and never change.
7. **Map membership on the node, never as an edge** (graph redesign). Every graph node carries
   `mapIds` and every slice lists the workspace's maps (`id`, `title`, `nodeCount`). A node on
   several maps is still one node. Membership is shown as pie-slice badges in map colors (on
   request), and always named in the tooltip, side panel and List, so it never relies on color.
   A `mapIds` filter shows the union of the selected maps; a map can be highlighted (its members
   stay bright, the rest dims) and opened in Mind Maps with its own layout. Sharing a map never
   creates an edge (PRD §4.4). Map regions and collapsing a map (section 5 of the redesign request)
   are in progress as a separate step.
8. **Selection emphasis and Focus mode instead of more data.** Selecting a node dims everything
   except its immediate neighborhood and opens a side panel; Focus mode hides everything except
   the node and its immediate neighbors and grows only by explicit expansion. Expansions are
   re-applied after reloads.
9. **Migrations are immutable, also in development.** The saved viewport (`graph_view_state`,
   created by migration 3) was dropped by a new migration 4 rather than by editing migration 3,
   because migration 3 had already been applied to a development workspace and the runner refuses
   a changed history. `checksums.test.ts` pins every migration's checksum. The timeline redesign
   followed the same rule: migration 5 rebuilds `timeline_events` instead of changing migration 1.

### Visual learning timeline (timeline redesign)

10. **A horizontal time axis, with the list kept beside it.** The Timeline screen has a
    **Timeline** tab, an SVG axis with older events on the left and newer ones on the right, date
    ticks at local calendar boundaries in the workspace timezone and a "Now" line, and a **List**
    tab with the earlier day-grouped list, newest first. The axis opens on recent activity (now at
    85% of the width), or centred on the latest event when nothing is recent, so events are
    visible at once. It pans (buttons, drag, wheel or touchpad) and zooms (Day, Week, Month, Year;
    Ctrl+wheel), keeping the selected event, or now when visible, in place. The window math, ticks
    and marker layout are pure functions (`timeline-axis.ts`) with their own tests.
11. **Two times per event; the timeline uses the effective time.** `occurred_at` stays the time
    the action was recorded and never changes. A new nullable `learned_at` holds the moment the
    user says the learning happened (for example, a review recorded today of something learned
    last week). The timeline places, orders, filters (date range) and pages events by the
    effective time, `coalesce(learned_at, occurred_at)`, with an index on that expression. A
    learning date must be a valid instant, not in the future (5 minutes of tolerance) and not
    before 1900. Because it annotates the record rather than changing it, it may be set or cleared
    on any event, recorded activity included; the event panel always shows both times ("Learned"
    and "Recorded").
12. **Milestones are user-owned entries.** A `milestone` event has a required title (1–200
    characters after whitespace normalization), optional details (stored in `reflection`), an
    optional node and a learning date. The user-owned types are `reviewed` and `milestone`: their
    title and reflection can be edited and they can be deleted (`timeline:update-entry`,
    `timeline:delete-entry`, which replace `timeline:update-reflection` and
    `timeline:delete-reviewed`). Recorded activity still cannot be edited or deleted. The database
    enforces that only milestones have a title.
13. **A bounded window, spread evenly across its range.** The axis loads one time range at a time
    (`timeline:window`): the total, and at most 2,000 events, oldest first. When the range holds
    more, it is split into 200 time buckets and events are taken round-robin (the latest of each
    bucket, then the second latest, and so on), so a burst of activity never hides a quieter
    period. The status line says when the window is truncated ("Showing N of M events in this
    period, spread across it; zoom in to see them all").
14. **Shapes, words and buttons, not color alone.** Each type has its own marker shape and icon as
    well as a color (Created: circle with plus; Note edits: bar spanning the editing session;
    Relationships: diamond with link; Reviews: square with check-book; Milestones: pennant with
    flag), and a small dot marks a user-set learning date. Markers stack in rows so they do not
    overlap; nearby events become a numbered cluster at wide zoom, and activating a cluster zooms
    in. Every marker and cluster is a focusable SVG button with a spoken label, activated with
    Enter or Space; a legend names the shapes in words; the List tab presents the same events as
    an ordinary list.

### Amendment (2026-10-29): maps as drawn

Users asked for the graph to show the mind maps "as they are". **Maps as drawn**, on by default,
draws every map as a Cytoscape compound node with its items at their map positions (freeform
coordinates, or the hierarchy layout the map editor computes) and its hierarchy lines and
connectors. Decision 1 above (each canonical node once, no compound nodes) still holds for the
free graph; in this mode a node keeps its single graph element in the first group it is on, and
its other placements are copies (`copy:<placementId>`) that carry the node ID and are joined to
it by a faint line, so selection, Find, Focus and relationships keep working on the one node.
Positions in this mode are derived from the maps and never saved as graph positions; Rearrange,
Regions and collapsing apply to the free graph only. Maps are loaded with `maps:get` (at most 40
maps, 4,000 items); groups are packed in rows, and nodes on no map keep their free arrangement
below them. Implemented in `graph-map-groups.ts` (pure, unit-tested) and the graph canvas.

## Consequences

- The user always knows whether the graph is complete; a large workspace shows its best-connected
  part first, and the rest is reachable through filters and expansion.
- The same data and filters always give the same slice, and the picture stays where the user left
  it: nodes keep their saved positions across visits, reloads and filter changes. In exchange the
  picture depends on history (what was saved, when Rearrange ran), not only on the data, and the
  schema has one table of visual state (`graph_node_positions`). Rearrange replaces manual
  positions of the visible nodes; the automatic first layout is limited to 300 nodes.
- Map colors repeat after eight maps and a node shows at most six map slices plus one neutral
  slice; names, not colors, identify maps.
- Loading reads all relationships of the workspace (within the type filter) for every request.
  That is linear and measured on the PRD dataset (`search.benchmark.test.ts`, overview p95 must stay
  below 1 second; 267 ms measured on a loaded developer machine), but it grows with the workspace and runs on the main process thread until a
  worker exists.
- Expansions live in the renderer only. They are re-applied after reloads and filter changes and
  are cleared only by leaving the screen; there is no total cap on the merged view after many
  expansions.
- Keyboard and screen-reader users get the information and actions through the list, not through
  the drawing. Creating relationships from the graph (PRD §5.5), including drag-to-connect, is not
  implemented yet. Labels of parallel edges can overlap.
- The timeline is trustworthy as a record: what it shows happened, and the recorded time is kept
  even when the user places an event at a different learning date. A future import (Phase 5) must
  write imported events with `is_imported = 1` and an origin instead of new activity; the view
  already marks them.
- Events are ordered and filtered by their effective time. Without a learning date that is the
  start time, so an editing session that spans midnight belongs to the day it started; with one,
  the session is drawn as a point at that date.
- A learning date moves an event on the timeline, so the order of events no longer always matches
  the order in which they were recorded. The event panel, a dot on the marker and a "learning
  date" badge in the List make this visible.
- A truncated window shows a spread sample, not the newest events; the total is always reported,
  and zooming in shows everything once a range holds 2,000 events or fewer.
- Migration 5 rebuilds `timeline_events` (SQLite cannot change a `CHECK` constraint in place):
  every row is copied, and the indexes and workspace triggers are recreated, in one transaction
  after the usual verified backup. Builds from before the redesign refuse the upgraded workspace
  as too new.
- The axis is a single row of time; lanes per tag or topic are a planned later enhancement.
- Changing the timezone changes only presentation and filter boundaries, never stored data.

## Alternatives considered

- **Loading the whole graph and filtering in the renderer.** Simplest, but sends 10,000 nodes and
  30,000 edges over IPC and into Cytoscape, beyond the PRD §9 cap. Rejected.
- **Pushing ranking and joins into SQL** (per-node correlated counts, `json_each` ID lists, joins
  between the selected nodes and relationships). Tried first; its speed depended on query-plan
  choices and was unacceptable on the PRD dataset (see above). Rejected in favor of simple scans.
- **A deterministic layout recomputed on every load (the first Phase 4 version: concentric by
  degree, nothing stored).** Predictable, but every reload, filter change or new node redrew the
  whole picture, and a dragged node returned to its place on the next reload. Replaced by saved
  positions with stable placement.
- **Running a force-directed layout (`cose`) on every load.** Looks good, but moves nodes between
  reloads and costs time on large graphs on the renderer thread. Used only on request
  (Rearrange) and on a first visit of up to 300 nodes.
- **Storing positions in map placements, or in one shared layout.** Would couple the graph to the
  maps: moving a node in the graph would move it on a map. Rejected; the graph has its own table.
- **Storing the viewport.** Implemented first (`graph_view_state`), then dropped at the user's
  request (migration 4): the graph always opens fitted to view.
- **Cytoscape compound nodes for maps.** Would force each node into one parent, but a node can be
  on several maps. Rejected; membership stays on the node (regions drawn behind the graph are in
  progress).
- **Making the canvas itself keyboard-operable.** Cytoscape has no accessible DOM for its nodes;
  emulating focus inside the canvas is costly and fragile. The list gives the same information
  with standard controls. Rejected for now.
- **Letting users edit or delete any timeline event.** Would turn the record into an editable
  diary and make imported versus recorded history indistinguishable. Rejected.
- **Changing `occurred_at` to the learning date.** Simpler (one time per event), but the record
  of when something was actually done would be lost, and recorded activity would become
  editable. Rejected in favor of a separate `learned_at` and an effective time.
- **Returning the newest 2,000 events of a full window.** One busy day would push every older
  event in the range off the axis, so a year view could look empty apart from its last week.
  Rejected in favor of round-robin buckets.
- **Only the day-grouped list.** Accessible and simple, but it shows neither the shape of
  learning over time nor quiet periods. Kept as the List tab next to the axis, not as the only
  view.
- **Filtering by UTC dates, or by the computer's current timezone.** UTC days do not match the
  user's days, and the computer's timezone can differ from the workspace's when the folder moves.
  Rejected in favor of the stored workspace timezone.
- **A timezone library (for example Luxon or date-fns-tz).** `Intl` with the runtime's timezone
  database is enough for the conversions needed and keeps the domain package dependency-free.
  Rejected.
