/**
 * Migration 3 — knowledge graph layout (PRD §5.7).
 *
 * The global graph remembers where the user placed nodes, so a visit does not start from a fresh
 * arrangement. This is visual state only:
 * - it never changes knowledge (nodes, relationships, references);
 * - it is separate from mind map placements, so moving a node in the graph never moves it in a
 *   map, and the reverse (PRD §4.4: each map keeps its own layout);
 * - deleting a node removes its graph position with it (cascade).
 *
 * `graph_view_state` (the last viewport) was created here but is no longer used: the graph now
 * always opens fitted to view. Migration 4 drops it; this migration stays unchanged because it was
 * already applied to existing workspaces and applied migrations must never change.
 */

import type { Migration } from './migration';

const utc = (column: string): string =>
  `CHECK (${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')`;

export const graphLayoutMigration: Migration = {
  version: 3,
  name: 'graph-layout',
  sql: `
CREATE TABLE graph_node_positions (
  workspace_id  TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  x             REAL NOT NULL,
  y             REAL NOT NULL,
  updated_at    TEXT NOT NULL ${utc('updated_at')},
  PRIMARY KEY (workspace_id, node_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE graph_view_state (
  workspace_id   TEXT NOT NULL PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  viewport_json  TEXT NOT NULL CHECK (json_valid(viewport_json)),
  updated_at     TEXT NOT NULL ${utc('updated_at')}
) STRICT;
`,
};
