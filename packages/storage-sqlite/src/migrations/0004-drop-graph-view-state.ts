/**
 * Migration 4 — removes the saved graph viewport.
 *
 * The knowledge graph now always opens fitted to view, so the last viewport (stored by
 * migration 3 in `graph_view_state`) is no longer read or written. Node positions in
 * `graph_node_positions` are kept. The table only held pan and zoom, so nothing of value is lost.
 */

import type { Migration } from './migration';

export const dropGraphViewStateMigration: Migration = {
  version: 4,
  name: 'drop-graph-view-state',
  sql: 'DROP TABLE graph_view_state;',
};
