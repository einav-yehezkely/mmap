/**
 * Migration 1 — initial schema for the full logical data model (PRD §7.3).
 *
 * Design notes (read before changing anything; released migrations are immutable):
 *
 * 1. Workspace consistency is enforced by constraints, not only by services (PRD §7.3). Parent
 *    tables expose `UNIQUE (workspace_id, id)` and children reference that pair with composite
 *    foreign keys, so a row can never point at a record from another workspace. Where SQLite's
 *    composite `ON DELETE SET NULL` would also null `workspace_id`, a single-column foreign key
 *    plus a workspace-check trigger is used instead.
 *
 * 2. Relationship rules (PRD §4.2) are encoded so the database rejects violations even if a
 *    service has a bug:
 *    - self-links: `CHECK (source_node_id <> target_node_id)`;
 *    - canonical undirected ordering: `CHECK (directionality = 'directed' OR source < target)`;
 *    - duplicates: `UNIQUE (workspace_id, source, target, type)`;
 *    - "directionality cannot change while used": each relationship copies its type's
 *      directionality and references `(workspace_id, type_id, directionality)`. Updating the
 *      type's directionality while relationships exist breaks that reference and fails.
 *
 * 3. `knowledge_nodes.row_key` is an explicit INTEGER PRIMARY KEY because the FTS5 index uses
 *    external content keyed by rowid. Without an explicit alias, VACUUM may renumber rowids and
 *    silently desynchronize the search index. The public identity remains the UUID `id`.
 *
 * 4. Map hierarchy parents use `ON DELETE NO ACTION`: deleting a placement that still has
 *    children fails. Services must first reparent or promote children, which makes the outcome
 *    an explicit, previewable choice instead of a silent subtree deletion. Deleting a whole map
 *    removes all its placements in one statement, which satisfies the check.
 *
 * 5. All timestamps are fixed-width UTC text (`YYYY-MM-DDTHH:MM:SS.sssZ`), validated by GLOB.
 *    All tables are STRICT so SQLite enforces declared column types.
 */

import type { Migration } from './migration';

/** CHECK expression validating the storage timestamp format for one column. */
const utc = (column: string): string =>
  `CHECK (${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')`;

/** CHECK expression for canonical lowercase UUID text (36 chars, hex and dashes only). */
const uuid = (column: string): string =>
  `CHECK (length(${column}) = 36 AND ${column} NOT GLOB '*[^0-9a-f-]*')`;

/** CHECK expression for SQLite booleans stored as 0/1. */
const bool = (column: string): string => `CHECK (${column} IN (0, 1))`;

const sql = /* sql */ `
CREATE TABLE workspaces (
  id          TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- IANA timezone name used for display only; storage stays UTC (PRD §5.9).
  timezone    TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) > 0),
  created_at  TEXT NOT NULL ${utc('created_at')},
  updated_at  TEXT NOT NULL ${utc('updated_at')}
) STRICT;

CREATE TABLE knowledge_nodes (
  row_key              INTEGER PRIMARY KEY,
  id                   TEXT NOT NULL UNIQUE ${uuid('id')},
  workspace_id         TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Titles may repeat within a workspace; identity is always \`id\` (PRD §4.1).
  title                TEXT NOT NULL CHECK (length(trim(title)) > 0),
  summary              TEXT,
  note_json            TEXT NOT NULL CHECK (json_valid(note_json)),
  note_schema_version  INTEGER NOT NULL CHECK (note_schema_version >= 1),
  note_plain_text      TEXT NOT NULL DEFAULT '',
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at           TEXT NOT NULL ${utc('created_at')},
  updated_at           TEXT NOT NULL ${utc('updated_at')},
  UNIQUE (workspace_id, id)
) STRICT;

CREATE INDEX knowledge_nodes_by_title ON knowledge_nodes (workspace_id, title COLLATE NOCASE);
CREATE INDEX knowledge_nodes_by_updated ON knowledge_nodes (workspace_id, updated_at DESC);
CREATE INDEX knowledge_nodes_by_created ON knowledge_nodes (workspace_id, created_at DESC);

-- Full-text index over titles, summaries and derived note text (PRD §5.8).
-- unicode61 with diacritic removal gives language-neutral tokenization for Unicode and RTL text.
CREATE VIRTUAL TABLE knowledge_nodes_fts USING fts5 (
  title,
  summary,
  note_plain_text,
  content = 'knowledge_nodes',
  content_rowid = 'row_key',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER knowledge_nodes_fts_after_insert AFTER INSERT ON knowledge_nodes BEGIN
  INSERT INTO knowledge_nodes_fts (rowid, title, summary, note_plain_text)
  VALUES (NEW.row_key, NEW.title, NEW.summary, NEW.note_plain_text);
END;

CREATE TRIGGER knowledge_nodes_fts_after_delete AFTER DELETE ON knowledge_nodes BEGIN
  INSERT INTO knowledge_nodes_fts (knowledge_nodes_fts, rowid, title, summary, note_plain_text)
  VALUES ('delete', OLD.row_key, OLD.title, OLD.summary, OLD.note_plain_text);
END;

CREATE TRIGGER knowledge_nodes_fts_after_update
AFTER UPDATE OF title, summary, note_plain_text ON knowledge_nodes BEGIN
  INSERT INTO knowledge_nodes_fts (knowledge_nodes_fts, rowid, title, summary, note_plain_text)
  VALUES ('delete', OLD.row_key, OLD.title, OLD.summary, OLD.note_plain_text);
  INSERT INTO knowledge_nodes_fts (rowid, title, summary, note_plain_text)
  VALUES (NEW.row_key, NEW.title, NEW.summary, NEW.note_plain_text);
END;

CREATE TABLE relationship_types (
  id                TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  label             TEXT NOT NULL CHECK (length(trim(label)) > 0),
  -- Case-folded label used for uniqueness; \`label\` keeps the user's display form.
  normalized_label  TEXT NOT NULL CHECK (length(normalized_label) > 0),
  directionality    TEXT NOT NULL CHECK (directionality IN ('directed', 'undirected')),
  is_archived       INTEGER NOT NULL DEFAULT 0 ${bool('is_archived')},
  is_builtin        INTEGER NOT NULL DEFAULT 0 ${bool('is_builtin')},
  created_at        TEXT NOT NULL ${utc('created_at')},
  updated_at        TEXT NOT NULL ${utc('updated_at')},
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, directionality),
  UNIQUE (workspace_id, normalized_label)
) STRICT;

CREATE TABLE relationships (
  id              TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id    TEXT NOT NULL,
  source_node_id  TEXT NOT NULL,
  target_node_id  TEXT NOT NULL,
  type_id         TEXT NOT NULL,
  -- Copy of the type's directionality; see design note 2.
  directionality  TEXT NOT NULL CHECK (directionality IN ('directed', 'undirected')),
  description     TEXT,
  created_at      TEXT NOT NULL ${utc('created_at')},
  updated_at      TEXT NOT NULL ${utc('updated_at')},
  CHECK (source_node_id <> target_node_id),
  CHECK (directionality = 'directed' OR source_node_id < target_node_id),
  UNIQUE (workspace_id, source_node_id, target_node_id, type_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_node_id)
    REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, target_node_id)
    REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE,
  -- No ON DELETE action: a type in use cannot be deleted, only archived (PRD §5.5).
  FOREIGN KEY (workspace_id, type_id, directionality)
    REFERENCES relationship_types (workspace_id, id, directionality)
) STRICT;

CREATE INDEX relationships_by_target ON relationships (workspace_id, target_node_id);
CREATE INDEX relationships_by_type ON relationships (workspace_id, type_id, directionality);

-- Wikilink references derived from saved note content (PRD §4.3, §5.4). One row per occurrence.
-- Deleting the target removes these rows, but the label stays readable in the source note JSON,
-- which is rendered as an unresolved link with a repair action.
CREATE TABLE note_references (
  workspace_id     TEXT NOT NULL,
  source_node_id   TEXT NOT NULL,
  ordinal          INTEGER NOT NULL CHECK (ordinal >= 0),
  target_node_id   TEXT NOT NULL,
  label            TEXT NOT NULL,
  -- Short plain-text excerpt around the link, shown in the target's backlinks list.
  context_excerpt  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (source_node_id, ordinal),
  FOREIGN KEY (workspace_id, source_node_id)
    REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, target_node_id)
    REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX note_references_by_target ON note_references (workspace_id, target_node_id);

CREATE TABLE tags (
  id                TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  display_label     TEXT NOT NULL CHECK (length(trim(display_label)) > 0),
  normalized_label  TEXT NOT NULL CHECK (length(normalized_label) > 0),
  created_at        TEXT NOT NULL ${utc('created_at')},
  updated_at        TEXT NOT NULL ${utc('updated_at')},
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, normalized_label)
) STRICT;

CREATE TABLE node_tags (
  workspace_id  TEXT NOT NULL,
  node_id       TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  created_at    TEXT NOT NULL ${utc('created_at')},
  PRIMARY KEY (node_id, tag_id),
  FOREIGN KEY (workspace_id, node_id) REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, tag_id) REFERENCES tags (workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX node_tags_by_tag ON node_tags (workspace_id, tag_id);

CREATE TABLE mind_maps (
  id             TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title          TEXT NOT NULL CHECK (length(trim(title)) > 0),
  mode           TEXT NOT NULL CHECK (mode IN ('freeform', 'hierarchical')),
  viewport_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(viewport_json)),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at     TEXT NOT NULL ${utc('created_at')},
  updated_at     TEXT NOT NULL ${utc('updated_at')},
  UNIQUE (workspace_id, id)
) STRICT;

CREATE INDEX mind_maps_by_updated ON mind_maps (workspace_id, updated_at DESC);

-- A canonical node placed on a map. Content stays on the node; everything here is map-specific
-- visual state (PRD §4.4). Hierarchy is organizational only and never implies a relationship.
CREATE TABLE map_placements (
  id                   TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id         TEXT NOT NULL,
  map_id               TEXT NOT NULL,
  node_id              TEXT NOT NULL,
  -- Freeform coordinates are kept while in hierarchical mode so switching back restores them.
  freeform_x           REAL NOT NULL DEFAULT 0,
  freeform_y           REAL NOT NULL DEFAULT 0,
  parent_placement_id  TEXT,
  sibling_order        INTEGER NOT NULL DEFAULT 0,
  is_collapsed         INTEGER NOT NULL DEFAULT 0 ${bool('is_collapsed')},
  style_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(style_json)),
  created_at           TEXT NOT NULL ${utc('created_at')},
  updated_at           TEXT NOT NULL ${utc('updated_at')},
  CHECK (parent_placement_id IS NULL OR parent_placement_id <> id),
  -- A node appears at most once per map in version 1 (PRD §4.4).
  UNIQUE (map_id, node_id),
  UNIQUE (map_id, id),
  FOREIGN KEY (workspace_id, map_id) REFERENCES mind_maps (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, node_id) REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE,
  -- The parent must be a placement in the same map. See design note 4 for the delete behaviour.
  FOREIGN KEY (map_id, parent_placement_id) REFERENCES map_placements (map_id, id)
) STRICT;

CREATE INDEX map_placements_by_parent ON map_placements (map_id, parent_placement_id, sibling_order);
CREATE INDEX map_placements_by_node ON map_placements (workspace_id, node_id);

-- Rejects hierarchy cycles (PRD §5.6). Inserting cannot create a cycle because a new row has no
-- descendants, so only parent changes are checked. Walks the new parent's ancestor chain and
-- aborts if it reaches the row being updated. UNION (not UNION ALL) guarantees termination.
CREATE TRIGGER map_placements_reject_cycles
BEFORE UPDATE OF parent_placement_id ON map_placements
WHEN NEW.parent_placement_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'mmap: hierarchy cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors (placement_id) AS (
      SELECT NEW.parent_placement_id
      UNION
      SELECT parent.parent_placement_id
      FROM map_placements AS parent
      JOIN ancestors ON parent.id = ancestors.placement_id
      WHERE parent.parent_placement_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE placement_id = NEW.id
  );
END;

-- Map-specific visual connectors. Freeform connectors may form cycles. A connector may point at
-- an existing semantic relationship, but only through an explicit user action (PRD §4.4).
CREATE TABLE map_connections (
  id                   TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id         TEXT NOT NULL,
  map_id               TEXT NOT NULL,
  source_placement_id  TEXT NOT NULL,
  target_placement_id  TEXT NOT NULL,
  relationship_id      TEXT REFERENCES relationships (id) ON DELETE SET NULL,
  label                TEXT,
  style_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(style_json)),
  created_at           TEXT NOT NULL ${utc('created_at')},
  updated_at           TEXT NOT NULL ${utc('updated_at')},
  CHECK (source_placement_id <> target_placement_id),
  FOREIGN KEY (workspace_id, map_id) REFERENCES mind_maps (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (map_id, source_placement_id)
    REFERENCES map_placements (map_id, id) ON DELETE CASCADE,
  FOREIGN KEY (map_id, target_placement_id)
    REFERENCES map_placements (map_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX map_connections_by_map ON map_connections (map_id);
CREATE INDEX map_connections_by_source ON map_connections (map_id, source_placement_id);
CREATE INDEX map_connections_by_target ON map_connections (map_id, target_placement_id);
CREATE INDEX map_connections_by_relationship ON map_connections (relationship_id);

CREATE TRIGGER map_connections_same_workspace_insert
BEFORE INSERT ON map_connections
WHEN NEW.relationship_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM relationships
  WHERE relationships.id = NEW.relationship_id AND relationships.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'mmap: workspace mismatch');
END;

CREATE TRIGGER map_connections_same_workspace_update
BEFORE UPDATE OF relationship_id, workspace_id ON map_connections
WHEN NEW.relationship_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM relationships
  WHERE relationships.id = NEW.relationship_id AND relationships.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'mmap: workspace mismatch');
END;

-- Recorded learning activity (PRD §5.9). Events outlive deleted nodes so history stays readable;
-- \`node_title_snapshot\` keeps the label after \`node_id\` becomes NULL.
CREATE TABLE timeline_events (
  id                   TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id         TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  node_id              TEXT REFERENCES knowledge_nodes (id) ON DELETE SET NULL,
  node_title_snapshot  TEXT,
  event_type           TEXT NOT NULL CHECK (
    event_type IN ('node_created', 'note_updated', 'relationship_created', 'reviewed')
  ),
  -- Start of the activity. For grouped note edits this is the start of the editing session.
  occurred_at          TEXT NOT NULL ${utc('occurred_at')},
  -- Last activity in an editing session; a session ends after 30 minutes of inactivity.
  last_activity_at     TEXT NOT NULL ${utc('last_activity_at')},
  reflection           TEXT,
  -- Imported history is labeled and never counted as new learning (PRD §5.9).
  is_imported          INTEGER NOT NULL DEFAULT 0 ${bool('is_imported')},
  import_origin        TEXT,
  CHECK (last_activity_at >= occurred_at),
  CHECK (is_imported = 1 OR import_origin IS NULL)
) STRICT;

CREATE INDEX timeline_events_by_time ON timeline_events (workspace_id, occurred_at DESC);
CREATE INDEX timeline_events_by_node ON timeline_events (workspace_id, node_id, occurred_at DESC);
CREATE INDEX timeline_events_by_type ON timeline_events (workspace_id, event_type, occurred_at DESC);

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

-- Managed attachment metadata (PRD §5.10). \`relative_path\` is generated by the attachment store,
-- relative to the workspace attachments directory. The CHECK is defense in depth against
-- traversal: no absolute paths, drive letters, backslashes, parent segments or NUL characters.
CREATE TABLE attachments (
  id              TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id    TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  relative_path   TEXT NOT NULL UNIQUE CHECK (
    length(relative_path) > 0
    AND substr(relative_path, 1, 1) <> '/'
    AND instr(relative_path, ':') = 0
    AND instr(relative_path, char(92)) = 0
    AND instr(relative_path, char(0)) = 0
    AND relative_path <> '..'
    AND relative_path NOT LIKE '../%'
    AND relative_path NOT LIKE '%/../%'
    AND relative_path NOT LIKE '%/..'
  ),
  original_name   TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  byte_size       INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256          TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  -- 'staged': bytes copied, not yet visible. 'committed': visible. Startup reconciliation
  -- removes stale staged rows and their files.
  state           TEXT NOT NULL CHECK (state IN ('staged', 'committed')),
  created_at      TEXT NOT NULL ${utc('created_at')},
  updated_at      TEXT NOT NULL ${utc('updated_at')},
  FOREIGN KEY (workspace_id, node_id) REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX attachments_by_node ON attachments (workspace_id, node_id);
CREATE INDEX attachments_by_state ON attachments (state);

-- Long-running export/import/backup/restore jobs with progress and idempotent retries (PRD §7.2).
CREATE TABLE transfer_jobs (
  id                    TEXT NOT NULL PRIMARY KEY ${uuid('id')},
  workspace_id          TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (
    kind IN ('export_zip', 'export_markdown', 'import_zip', 'backup', 'restore')
  ),
  state                 TEXT NOT NULL CHECK (
    state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  progress              REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  idempotency_key       TEXT NOT NULL,
  result_relative_path  TEXT,
  expires_at            TEXT ${utc('expires_at')},
  error_code            TEXT,
  created_at            TEXT NOT NULL ${utc('created_at')},
  updated_at            TEXT NOT NULL ${utc('updated_at')},
  UNIQUE (workspace_id, idempotency_key)
) STRICT;
`;

export const initialSchemaMigration: Migration = {
  version: 1,
  name: 'initial-schema',
  sql,
};
