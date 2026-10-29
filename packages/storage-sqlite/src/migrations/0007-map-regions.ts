/**
 * Migration 7 — regions on freeform mind maps.
 *
 * A region is a named, optionally colored rectangle on a map that groups items by subject. It is
 * visual organization only, like placements: it belongs to one map, never changes knowledge, and
 * goes away with its map (cascade). Which items are in a region is not stored: an item is in a
 * region when its center lies inside the rectangle, so dragging an item in or out is all it takes.
 */

import type { Migration } from './migration';

const utc = (column: string): string =>
  `CHECK (${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')`;

const uuid = (column: string): string =>
  `CHECK (length(${column}) = 36 AND ${column} NOT GLOB '*[^0-9a-f-]*')`;

export const mapRegionsMigration: Migration = {
  version: 7,
  name: 'map-regions',
  sql: `
CREATE TABLE map_regions (
  id            TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id  TEXT NOT NULL,
  map_id        TEXT NOT NULL,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  color         TEXT CHECK (color IS NULL OR color IN ('gray', 'blue', 'green', 'amber', 'red', 'violet')),
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  width         REAL NOT NULL CHECK (width > 0),
  height        REAL NOT NULL CHECK (height > 0),
  created_at    TEXT NOT NULL ${utc('created_at')},
  updated_at    TEXT NOT NULL ${utc('updated_at')},
  FOREIGN KEY (workspace_id, map_id) REFERENCES mind_maps (workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX map_regions_by_map ON map_regions (workspace_id, map_id);
`,
};
