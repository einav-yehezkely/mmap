/**
 * Where to put a node added to a map without the user choosing a spot (for example from the
 * "New node" dialog): a position that does not overlap existing items and stays close to them,
 * so the new item appears among the map's content rather than far off to one side.
 *
 * Items are treated as boxes of about `ITEM_WIDTH` × `ITEM_HEIGHT` (the canvas shows titles in
 * cards of roughly that size). The search starts at the middle of the existing items and walks
 * outward ring by ring over a grid, taking the first cell whose box is clear of every item.
 */

export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

const ITEM_WIDTH = 200;
const ITEM_HEIGHT = 60;
const GRID_X = 220;
const GRID_Y = 90;
const MAX_RINGS = 200;

export function findFreePosition(existing: readonly MapPoint[]): MapPoint {
  if (existing.length === 0) return { x: 0, y: 0 };
  const centerX = existing.reduce((sum, point) => sum + point.x, 0) / existing.length;
  const centerY = existing.reduce((sum, point) => sum + point.y, 0) / existing.length;
  const origin = {
    x: Math.round(centerX / GRID_X) * GRID_X,
    y: Math.round(centerY / GRID_Y) * GRID_Y,
  };
  const isFree = (candidate: MapPoint) =>
    existing.every(
      (point) =>
        Math.abs(point.x - candidate.x) >= ITEM_WIDTH + 10 ||
        Math.abs(point.y - candidate.y) >= ITEM_HEIGHT + 10,
    );

  for (let ring = 0; ring <= MAX_RINGS; ring += 1) {
    // Cells on the square ring at distance `ring`, nearest to the centre row first.
    const cells: MapPoint[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        cells.push({ x: origin.x + dx * GRID_X, y: origin.y + dy * GRID_Y });
      }
    }
    cells.sort(
      (a, b) =>
        Math.abs(a.y - origin.y) - Math.abs(b.y - origin.y) ||
        Math.abs(a.x - origin.x) - Math.abs(b.x - origin.x) ||
        a.x - b.x ||
        a.y - b.y,
    );
    const free = cells.find(isFree);
    if (free !== undefined) return free;
  }
  // Unreachable for realistic maps; below everything is always free.
  return { x: origin.x, y: Math.max(...existing.map((point) => point.y)) + GRID_Y };
}
