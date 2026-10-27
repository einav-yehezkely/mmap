/**
 * Migration 5 — learning milestones and learning dates on the timeline (PRD §5.9, visual
 * timeline).
 *
 * - \`milestone\`: a new event type for learning milestones the user adds by hand, with a required
 *   \`title\` (the optional \`reflection\` holds details, \`node_id\` an optional related node).
 * - \`learned_at\`: an optional, user-defined moment when the learning actually happened. It is kept
 *   apart from \`occurred_at\` (when the action was recorded), which never changes. The timeline
 *   places an event at \`coalesce(learned_at, occurred_at)\`, its effective time, so the default is
 *   the recorded time.
 *
 * SQLite cannot change a CHECK constraint in place, so the table is rebuilt: create the new table,
 * copy every row, drop the old table, rename, and recreate its indexes and triggers. No other
 * table references \`timeline_events\`, so the foreign keys of other tables are unaffected. The
 * migration runs in one transaction after a verified backup (see the runner).
 */

import type { Migration } from './migration';

const utc = (column: string): string =>
  `CHECK (${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')`;
const uuid = (column: string): string =>
  `CHECK (length(${column}) = 36 AND ${column} NOT GLOB '*[^0-9a-f-]*')`;
const bool = (column: string): string => `CHECK (${column} IN (0, 1))`;

export const timelineMilestonesLearnedAtMigration: Migration = {
  version: 5,
  name: 'timeline-milestones-learned-at',
  sql: `
CREATE TABLE timeline_events_next (
  id                   TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id         TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  node_id              TEXT REFERENCES knowledge_nodes (id) ON DELETE SET NULL,
  node_title_snapshot  TEXT,
  event_type           TEXT NOT NULL CHECK (
    event_type IN ('node_created', 'note_updated', 'relationship_created', 'reviewed', 'milestone')
  ),
  -- When the action was recorded. For grouped note edits, the start of the editing session.
  occurred_at          TEXT NOT NULL ${utc('occurred_at')},
  last_activity_at     TEXT NOT NULL ${utc('last_activity_at')},
  -- Optional moment the learning actually happened, chosen by the user.
  learned_at           TEXT ${utc('learned_at')},
  -- Title of a learning milestone; required for milestones, absent otherwise.
  title                TEXT,
  reflection           TEXT,
  is_imported          INTEGER NOT NULL DEFAULT 0 ${bool('is_imported')},
  import_origin        TEXT,
  CHECK (last_activity_at >= occurred_at),
  CHECK (is_imported = 1 OR import_origin IS NULL),
  CHECK (
    (event_type = 'milestone' AND title IS NOT NULL AND length(trim(title)) > 0)
    OR (event_type <> 'milestone' AND title IS NULL)
  )
) STRICT;

INSERT INTO timeline_events_next
  (id, workspace_id, node_id, node_title_snapshot, event_type, occurred_at, last_activity_at,
   learned_at, title, reflection, is_imported, import_origin)
SELECT id, workspace_id, node_id, node_title_snapshot, event_type, occurred_at, last_activity_at,
       NULL, NULL, reflection, is_imported, import_origin
FROM timeline_events;

DROP TABLE timeline_events;
ALTER TABLE timeline_events_next RENAME TO timeline_events;

CREATE INDEX timeline_events_by_time ON timeline_events (workspace_id, occurred_at DESC);
CREATE INDEX timeline_events_by_node ON timeline_events (workspace_id, node_id, occurred_at DESC);
CREATE INDEX timeline_events_by_type ON timeline_events (workspace_id, event_type, occurred_at DESC);
CREATE INDEX timeline_events_by_effective_time
  ON timeline_events (workspace_id, coalesce(learned_at, occurred_at) DESC, id DESC);

CREATE TRIGGER timeline_events_same_workspace_insert
BEFORE INSERT ON timeline_events
WHEN NEW.node_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM knowledge_nodes
  WHERE knowledge_nodes.id = NEW.node_id AND knowledge_nodes.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'mmap: workspace mismatch');
END;

CREATE TRIGGER timeline_events_same_workspace_update
BEFORE UPDATE OF node_id, workspace_id ON timeline_events
WHEN NEW.node_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM knowledge_nodes
  WHERE knowledge_nodes.id = NEW.node_id AND knowledge_nodes.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'mmap: workspace mismatch');
END;
`,
};
