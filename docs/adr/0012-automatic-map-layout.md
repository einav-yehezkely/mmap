# ADR-0012: Automatic layout of freeform maps

- Status: Accepted
- Date: 2026-10-28

## Context

Freeform maps are arranged by hand. Users asked for an **Auto layout** button that tidies a messy
map in one step: a chosen direction (left to right, top to bottom, right to left, bottom to top),
clean orthogonal lines, a short animation, Undo, items that can be locked in place, and manual
editing that keeps working afterwards. Maps contain cycles, two-way connectors, items with
several incoming lines, separate groups and lone items. Where the lines form a plain hierarchy,
users expect a tidy tree: every parent centered over its children, siblings evenly spaced in one
row, and children joined through a shared branching line. The result must survive leaving and
reopening the map. Hierarchy maps already have their own automatic tree layout
([ADR-0009](0009-mind-map-editing.md)) and are out of scope.

## Decision

1. **ELK.js for general graphs.** `elkjs` 0.12.1 (the Eclipse Layout Kernel compiled to
   JavaScript, EPL-2.0) runs its `layered` algorithm in the renderer
   (`apps/desktop/src/renderer/src/maps/auto-layout.ts`): crossing minimization, Brandes-Köpf
   placement with balanced alignment, orthogonal routing, greedy cycle breaking, model order kept
   for stability, separate components side by side. Each item has two fixed ports at the middles
   of the sides facing the direction, the same points as the canvas's handles, so routes meet the
   items exactly. The bundled build runs on the main thread; layouts of a few hundred items take
   well under a second. The license text ships in `resources/licenses`.
2. **A dedicated tree layout for strict hierarchies.** ELK's layered placement does not
   guarantee centered parents. When every item has at most one incoming line and there is no
   cycle, a deterministic tidy-tree layout is used instead: subtrees are measured, children are
   placed in one row with equal gaps between their boxes, each parent is centered over the span
   of its children at every level, subtrees never overlap, and every line goes from the parent to
   a branching line halfway to the next level and then to the child. Everything else (cross-links,
   several parents, cycles) uses ELK.
3. **Pure function, canvas applies, one change.** `computeAutoLayout(items, lines, direction)`
   takes measured boxes and returns positions and routes. The canvas animates the items (450 ms,
   none with reduced motion), then the editor saves the result with one
   `maps:save-arrangement` request, which is one revision and one Undo step.
4. **Locks.** An item can be locked (`style.pinned`, `maps:set-placement-pinned`). Locked items
   keep their place; the other items are arranged as a block placed after them in the layout
   direction. Lines to or from locked items keep ordinary curves.
5. **Routes are stored with the map, and apply only while they still fit.** Migration 6 adds
   `mind_maps.arrangement_json`: the direction, the positions the layout gave, and each line's
   route. The canvas draws a stored route only while both of its items are still at those
   positions (within 1 px); after a drag, Undo or new lines, the affected lines go back to curves
   without any extra bookkeeping. The arrangement is visual state like the viewport; duplicating
   a map does not copy it. ZIP exports carry it, and the item locks, since archive format version 3
   (2026-10-29); import rewrites its IDs and drops routes or items it cannot match.

## Consequences

- Arranging an arranged map changes little, and the map does not jump: the block keeps the
  top-left corner of the items it moved.
- Line routes are a hint, not structure: nothing else reads them, and a malformed stored value is
  treated as none.
- ZIP exports keep item positions, colors, locks and routes (format version 3); archives from
  before version 3 import without locks, and their maps show curves until arranged again.
- The ELK bundle adds about 1.6 MB to the renderer code.
