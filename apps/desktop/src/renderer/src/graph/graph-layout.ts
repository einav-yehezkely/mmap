/**
 * Stable placement for the knowledge graph (PRD §5.7: layout is visual state).
 *
 * The graph keeps the positions the user (or an explicit Rearrange) produced. When nodes appear
 * that have no saved position (new nodes, a changed filter, an expansion), only those are placed:
 * next to their already-placed neighbors when they have some, otherwise in free space below the
 * existing drawing. Nothing already on screen moves, so an edit, a selection or a filter change
 * never rearranges the whole graph.
 *
 * Placement is deterministic (same input, same output) and avoids overlaps with a spatial grid,
 * so it stays fast for 1,000 nodes.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Minimum distance kept between node centers when placing new nodes (room for a label). */
export const NODE_SPACING_X = 190;
export const NODE_SPACING_Y = 90;

/** Free-cell index: one occupied flag per cell of the spacing grid. */
class OccupancyGrid {
  private readonly cells = new Set<string>();

  private key(x: number, y: number): string {
    return `${Math.round(x / NODE_SPACING_X)}:${Math.round(y / NODE_SPACING_Y)}`;
  }

  public occupy(point: Point): void {
    this.cells.add(this.key(point.x, point.y));
  }

  public isFree(point: Point): boolean {
    return !this.cells.has(this.key(point.x, point.y));
  }

  /**
   * The free grid cell nearest to `origin`, searched ring by ring around it (clockwise from the
   * right), so results are deterministic.
   */
  public nearestFree(origin: Point): Point {
    const snapped = {
      x: Math.round(origin.x / NODE_SPACING_X) * NODE_SPACING_X,
      y: Math.round(origin.y / NODE_SPACING_Y) * NODE_SPACING_Y,
    };
    if (this.isFree(snapped)) return snapped;
    for (let ring = 1; ring < 1_000; ring += 1) {
      for (let dx = -ring; dx <= ring; dx += 1) {
        for (const dy of [-ring, ring]) {
          const candidate = {
            x: snapped.x + dx * NODE_SPACING_X,
            y: snapped.y + dy * NODE_SPACING_Y,
          };
          if (this.isFree(candidate)) return candidate;
        }
      }
      for (let dy = -ring + 1; dy <= ring - 1; dy += 1) {
        for (const dx of [-ring, ring]) {
          const candidate = {
            x: snapped.x + dx * NODE_SPACING_X,
            y: snapped.y + dy * NODE_SPACING_Y,
          };
          if (this.isFree(candidate)) return candidate;
        }
      }
    }
    return snapped;
  }
}

/**
 * Positions for every node in `nodeIds`: saved positions are kept unchanged; the rest are placed.
 * `nodeIds` is processed in order (the graph's ranking: best connected first), so well-connected
 * nodes are placed first and their neighbors gather around them.
 */
export function placeNodes(
  nodeIds: readonly string[],
  links: readonly { readonly source: string; readonly target: string }[],
  saved: ReadonlyMap<string, Point>,
): Map<string, Point> {
  const positions = new Map<string, Point>();
  const grid = new OccupancyGrid();
  const shown = new Set(nodeIds);
  for (const id of nodeIds) {
    const position = saved.get(id);
    if (position !== undefined) {
      positions.set(id, position);
      grid.occupy(position);
    }
  }

  const neighbors = new Map<string, string[]>();
  for (const { source, target } of links) {
    if (!shown.has(source) || !shown.has(target) || source === target) continue;
    neighbors.set(source, [...(neighbors.get(source) ?? []), target]);
    neighbors.set(target, [...(neighbors.get(target) ?? []), source]);
  }

  // Nodes that cannot be placed next to a neighbor go into rows below the current drawing.
  let bottom = 0;
  let left = 0;
  for (const position of positions.values()) {
    bottom = Math.max(bottom, position.y);
    left = Math.min(left, position.x);
  }
  const looseStart = { x: left, y: positions.size === 0 ? 0 : bottom + NODE_SPACING_Y * 2 };
  const looseColumns = Math.max(4, Math.ceil(Math.sqrt(nodeIds.length)));
  let looseCount = 0;

  // Repeated passes let chains of new nodes attach to neighbors placed in an earlier pass.
  let pending = nodeIds.filter((id) => !positions.has(id));
  while (pending.length > 0) {
    const next: string[] = [];
    let placedAny = false;
    for (const id of pending) {
      const placedNeighbors = (neighbors.get(id) ?? [])
        .map((neighbor) => positions.get(neighbor))
        .filter((point): point is Point => point !== undefined);
      if (placedNeighbors.length === 0) {
        next.push(id);
        continue;
      }
      const center = {
        x: placedNeighbors.reduce((sum, point) => sum + point.x, 0) / placedNeighbors.length,
        y: placedNeighbors.reduce((sum, point) => sum + point.y, 0) / placedNeighbors.length,
      };
      const point = grid.nearestFree(center);
      positions.set(id, point);
      grid.occupy(point);
      placedAny = true;
    }
    if (!placedAny) {
      // No remaining node touches a placed one: start the first remaining node of a new group in
      // the loose area, then continue attaching its neighbors around it.
      const [first, ...rest] = next;
      if (first === undefined) break;
      const column = looseCount % looseColumns;
      const row = Math.floor(looseCount / looseColumns);
      looseCount += 1;
      const point = grid.nearestFree({
        x: looseStart.x + column * NODE_SPACING_X,
        y: looseStart.y + row * NODE_SPACING_Y * 2,
      });
      positions.set(first, point);
      grid.occupy(point);
      pending = rest;
    } else {
      pending = next;
    }
  }
  return positions;
}
