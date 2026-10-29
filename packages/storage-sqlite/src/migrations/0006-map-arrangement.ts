/**
 * Migration 6 — the last automatic layout of a freeform map (ADR-0012).
 *
 * `arrangement_json` keeps the routes ELK computed for the map's lines and the positions it gave
 * the items, so the clean orthogonal lines come back when the map is opened again. A route is
 * shown only while both of its items are still at those positions; `{}` means none. It is visual
 * state, like `viewport_json`, and is not part of exports.
 *
 * `ADD COLUMN` keeps every row and needs no table rebuild; the default fills existing maps.
 */

import type { Migration } from './migration';

export const mapArrangementMigration: Migration = {
  version: 6,
  name: 'map-arrangement',
  sql: `
ALTER TABLE mind_maps
  ADD COLUMN arrangement_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(arrangement_json));
`,
};
