# ADR-0013: Regions on freeform maps

- Status: Accepted
- Date: 2026-10-29

## Context

Users asked for regions in mind maps, "so that a mind map can have different regions in different
subjects". A region has to be visible on the map, named and optionally colored, easy to put
around items that already exist, and easy to change: items move in and out of subjects as a map
grows. Moving a region should move its items with it. Automatic layout
([ADR-0012](0012-automatic-map-layout.md)) must not scatter a region's items, and the knowledge
graph's "Maps as drawn" view ([ADR-0010 amendment](0010-graph-and-timeline.md)) should show the
regions too. Regions are organization of one map, like placements and connectors: they must never
change knowledge (PRD §4.4).

## Decision

1. **A region is a stored rectangle; membership is geometric.** Migration 7 adds `map_regions`
   (`title` 1–100 characters, `color` from the placement palette or none, `x`, `y`, `width`,
   `height`, cascade with the map). Which items are in a region is not stored: an item belongs to
   the smallest region that contains its center (`regionOwners` in `map-model.ts`). Dragging an
   item in or out is all it takes, nothing can get out of sync, and nested or overlapping regions
   have a clear rule.
2. **Freeform maps only.** Positions in hierarchy maps come from the tree layout, so regions are
   neither shown nor editable there; they are kept, and come back when the map is switched to
   freeform again.
3. **Every region change is one structural change.** `maps:add-region`, `maps:update-region`
   (title, color, bounds, and the positions of items carried along) and `maps:remove-region` check
   and raise the map revision like any other structural change. Dragging a region moves the items
   whose center was inside it when the drag started, and saves region and items in one request,
   so one Undo step puts everything back. Removing a region keeps its items.
4. **Automatic layout keeps subjects together.** `computeLayoutWithRegions` first arranges each
   region's items inside the region (tree or ELK, as in ADR-0012) and fits the region around them
   with room for its title; it then arranges the map with each region as one block. A region with
   a locked item, or with no items, stays exactly as it is. Lines inside a region keep their routes;
   lines between regions are drawn as ordinary curves. `maps:save-arrangement` takes the regions'
   new bounds with the item positions, as one change.
5. **Portable.** ZIP archives carry `regions` (archive format version 2); version 1 archives still
   import. Duplicating a map copies its regions. In the knowledge graph, regions are frames nested
   in their map's group, around the items inside them; a region with no items is not drawn.

## Consequences

- The editor's toolbar has **Add region** (around the selected items, or in the middle of the
  view), the Color picker colors a selected region, Delete removes it, and double-clicking its
  title renames it. Undo covers adding, changing and removing regions.
- An item exactly on a region's edge counts as inside. An item can be in one region at a time
  (the smallest that contains it).
- A map has at most 200 regions.

## Alternatives considered

- **Storing membership (a region ID on each placement).** Explicit, but every move would have to
  update it, and an item drawn inside a region that does not "belong" to it would be confusing.
  Rejected in favor of position.
- **React Flow parent nodes (sub-flows).** They make positions relative to the region and tie
  each item to one parent, which conflicts with stored absolute positions, automatic layout and
  overlapping regions. Rejected.
