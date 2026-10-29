# Data model

This page explains the SQLite schema created by migration 1,
`packages/storage-sqlite/src/migrations/0001-initial-schema.ts`, and the one table added since. It
maps each table to the logical entities in PRD §7.3 and explains the constraints that are not
obvious from the SQL. Migration 2 changes no table; it only marks note schema version 2.
Migration 3 adds the knowledge graph's visual state (`graph_node_positions` and
`graph_view_state`), migration 4 drops `graph_view_state` again, and migration 5 rebuilds
`timeline_events` for learning milestones and learning dates (see [Migrations](#migrations)).

Migration 1 creates the complete schema for the whole logical model, and since Phase 5 every
table is in use (see [Table usage](#table-usage-after-phase-5)). Phase 3 (mind maps) added no
migration, and the first Phase 4 timeline needed none: the map tables, the timeline columns for
reviews and imports, and the workspace timezone were already in migration 1. Phase 5 (export,
import, backups) added none either: it uses `transfer_jobs` and the timeline's import columns from
migration 1, and keeps backups and archives outside the database. The redesigned Phase 4 graph needed a new
table, for node positions that are kept apart from map placements, and the redesigned visual
timeline needed a new event type and two new columns on `timeline_events`. The schema is verified
by the tests in `packages/storage-sqlite/src/migrations/initial-schema.test.ts`, the graph tables
by `packages/storage-sqlite/src/graph/graph-maps-layout.test.ts` and the timeline rebuild by
`packages/storage-sqlite/src/migrations/timeline-rebuild.test.ts`.

## Table usage after Phase 5

Repositories are in `packages/storage-sqlite/src/repositories/`; the services that call them are
in `packages/domain/src/application/`. Every repository method takes the workspace ID and filters
by it, so a record from another workspace behaves as not found. Since Phase 5, export reads every
table except `knowledge_nodes_fts`, `note_references`, `transfer_jobs` and `schema_migrations`
through `SqliteWorkspaceSnapshotReader`
(`packages/storage-sqlite/src/portability/sqlite-workspace-snapshot-reader.ts`), and import
writes the same tables through the repositories in one transaction (`ImportService`,
`packages/domain/src/application/import-service.ts`); see
[Export archive](#export-archive-and-backup-layouts).

| Table                                                           | Status | Written by                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaces`                                                    | Used   | `WorkspaceService.initialize` (create), `rename`, `setTimezone`; read on every open to check the manifest ID; `timezone` read by timeline date filters                                                                                                                    |
| `knowledge_nodes`                                               | Used   | `KnowledgeNodeService`: create, update, duplicate, delete; keyset-paginated listing in three sort orders                                                                                                                                                                  |
| `knowledge_nodes_fts`                                           | Used   | Kept in sync by triggers on every node write; queried by `SqliteSearchIndex` (`search:query`) and by the graph text filter                                                                                                                                                |
| `relationship_types`                                            | Used   | Seeded by `WorkspaceService.initialize`; `RelationshipService` creates, renames, archives, changes direction                                                                                                                                                              |
| `tags`, `node_tags`                                             | Used   | `TagService`; `KnowledgeNodeService.duplicate` copies assignments; tag filters in lists and search                                                                                                                                                                        |
| `timeline_events`                                               | Used   | `node_created`, `note_updated` (grouped by session), `relationship_created`; `TimelineService` writes `reviewed` and `milestone` events, edits their title and reflection, deletes them, sets or clears `learned_at` on any event, and lists all events (Timeline screen) |
| `attachments`                                                   | Used   | `AttachmentService` (register, list, remove); rows cascade when a node is deleted                                                                                                                                                                                         |
| `relationships`                                                 | Used   | `RelationshipService`: create, update (type, description, reverse), delete, list for a node; read by `SqliteGraphQuery` for the graph                                                                                                                                     |
| `note_references`                                               | Used   | Rebuilt by `KnowledgeNodeService` in every note-save transaction; read for backlinks, delete preview and the graph's note-link layer                                                                                                                                      |
| `mind_maps`, `map_placements`, `map_connections`, `map_regions` | Used   | `MapService` (Phase 3) through `SqliteMapRepository`; node deletion promotes child placements (see below); read by `SqliteGraphQuery` for map membership and the graph's map filter                                                                                       |
| `graph_node_positions` (migration 3)                            | Used   | `GraphService.savePositions` through `SqliteGraphLayoutRepository` (`graph:save-positions`); read by `graph:get-positions`; rows cascade when a node is deleted                                                                                                           |
| `transfer_jobs`                                                 | Used   | `SqliteImportHistoryRepository`: one `import_zip` row per completed import, written in the import's transaction; read to detect re-imports of the same archive                                                                                                            |
| `schema_migrations`                                             | Used   | Migration runner                                                                                                                                                                                                                                                          |

## Three kinds of connection

PRD §4 defines three different ways two pieces of knowledge can be connected. Users easily
confuse them, so the schema keeps them in separate tables and nothing creates one from another
implicitly (PRD §14).

| Concept                   | Meaning                                                                                       | Stored in                                                  | Created by                                     |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| **Semantic relationship** | A typed statement about knowledge: "A depends on B", "A is related to B". Shown in the graph. | `relationships`, typed by `relationship_types`             | Explicit user action only                      |
| **Note reference**        | A `[[wikilink]]` written inside a note. Produces backlinks.                                   | `note_references`, derived from the note JSON on each save | Writing a link; never creates a relationship   |
| **Map structure**         | How a node is arranged on one mind map: parent/child hierarchy and visual connectors.         | `map_placements.parent_placement_id` and `map_connections` | Map editing; hierarchy never implies `part of` |

A map connector may point at an existing semantic relationship through
`map_connections.relationship_id`, but only when the user explicitly links them (PRD §4.4).

The knowledge graph draws relationships as edges and note references as a separate dashed layer.
It shows map membership (which maps have a placement for a node) on the node itself and never as
an edge: two nodes on the same map are not connected in the graph unless a relationship or note
reference connects them.

## Schema-wide conventions

- **STRICT tables.** Every table is declared `STRICT`, so SQLite rejects values of the wrong type
  instead of silently storing them (for example text in an `INTEGER` column).
- **UUID identities.** Public IDs are canonical lowercase UUID text, checked by
  `length(id) = 36` and "only `0-9`, `a-f` and `-`". Lowercase matters: undirected relationship
  ordering compares IDs as text, and the domain (`packages/domain/src/ids.ts`) and SQLite must
  agree on that ordering.
- **UTC timestamps.** Every timestamp column has a `GLOB` check for the fixed-width form
  `YYYY-MM-DDTHH:MM:SS.sssZ`. One fixed format sorts correctly as text, keeps date-range queries
  index-friendly, and rejects local-time strings such as `2026-10-26 12:00:00`. Conversion to the
  user's timezone happens only in presentation code (`packages/domain/src/clock.ts`).
- **Booleans** are `INTEGER` columns with `CHECK (x IN (0, 1))`.
- **JSON columns** (`note_json`, `viewport_json`, `style_json`) have `CHECK (json_valid(...))`.
- **Non-blank text.** Titles, names and labels have `CHECK (length(trim(x)) > 0)`.
- **Foreign keys are enforced on every connection.** SQLite turns them off by default; the
  connection factory turns them on and fails if that does not work
  (`packages/storage-sqlite/src/connection.ts`).

### Workspace consistency with composite foreign keys

One workspace folder holds one database, yet every table carries `workspace_id`. This keeps the
schema ready for a future multi-workspace server database and lets the database itself prohibit
cross-workspace links (PRD §7.3, acceptance criterion 2).

Parent tables declare `UNIQUE (workspace_id, id)`. Child tables reference that pair, for example
`FOREIGN KEY (workspace_id, source_node_id) REFERENCES knowledge_nodes (workspace_id, id)`. A row
in workspace A therefore cannot point at a node, tag or map in workspace B, because no parent row
matches the pair.

Where the child reference is optional and should become `NULL` when the parent is deleted, a
composite `ON DELETE SET NULL` would also null `workspace_id`. In those two places
(`map_connections.relationship_id` and `timeline_events.node_id`) the schema uses a
single-column foreign key plus `BEFORE INSERT` and `BEFORE UPDATE` triggers that abort with
`mmap: workspace mismatch`.

## Tables

### `workspaces` (PRD entity: Workspace)

One row per workspace: `id`, `name`, `timezone` (IANA name, default `UTC`, used only for
display), timestamps. Deleting a workspace row cascades to everything in it.

The PRD lists a schema version on Workspace. It is not a column: the schema version of the whole
database file is `PRAGMA user_version` plus the `schema_migrations` table (see
[Migrations](#migrations)). Outside the database, the workspace folder manifest
`mmap-workspace.json` records the same workspace ID; opening fails with `WORKSPACE_DAMAGED` if the
database has no row for it ([architecture](architecture.md#workspace-lifecycle),
[ADR-0005](adr/0005-workspace-location-and-supported-filesystems.md)). The row is created in the
same transaction as the built-in relationship types.

`timezone` is set from the operating system when the workspace is created. Since Phase 4 the user
can change it in Settings (`workspace:set-timezone`, which also updates `updated_at`). Only IANA
names that the runtime's `Intl` knows are stored (`validateTimeZone`); offsets such as `+02:00`
are refused. It controls how dates are shown and how the timeline's local date filters are turned
into UTC ranges. No stored timestamp is ever converted or rewritten when it changes, because
every timestamp in the database is UTC. The timezone belongs to the workspace, so it travels with
the folder to another computer.

### `knowledge_nodes` (KnowledgeNode)

Canonical knowledge items: `title`, optional `summary`, `note_json` (validated, versioned Tiptap
JSON and the source of truth), `note_schema_version`, `note_plain_text` (derived from the note for
search only), `revision` (starts at 1, used for optimistic concurrency), timestamps.

- `title` is not unique. Titles may repeat; identity is always `id` (PRD §4.1).
- `row_key INTEGER PRIMARY KEY` is an explicit rowid alias, separate from the public UUID `id`.
  The full-text index is keyed by rowid, and without an explicit alias `VACUUM` may renumber
  rowids and silently break the link between a node and its index entry.
- Indexes: `(workspace_id, title COLLATE NOCASE)` for pickers, and `(workspace_id, updated_at)`
  and `(workspace_id, created_at)` for lists and the timeline.
- Behaviour: titles are NFC-normalized, single-line, 1 to 300 characters; summaries are
  optional, up to 2,000 characters (`packages/domain/src/knowledge/node-fields.ts`). `note_json`,
  `note_schema_version` (2 since Phase 2; notes saved by Phase 1 keep 1 until the note itself is
  saved again, and both are read the same way) and `note_plain_text` are always written together
  from the
  same validated document. Every update increments `revision`; an update or delete with an outdated
  revision fails with `REVISION_CONFLICT` and changes nothing. Tag changes do not touch the
  revision.
- Deleting a node first moves the children of its map placements up to the deleted placement's
  parent (the hierarchy foreign key refuses to orphan them), then deletes the row; relationships,
  placements, note references from and to this node, tag assignments and attachment rows cascade.
  `timeline_events.node_id` becomes `NULL`.

### `knowledge_nodes_fts` (search index, PRD §5.8)

An FTS5 virtual table over `title`, `summary` and `note_plain_text`.

- **External content** (`content = 'knowledge_nodes'`, `content_rowid = 'row_key'`): text is
  stored once, in `knowledge_nodes`; the index holds only tokens.
- Three triggers (`knowledge_nodes_fts_after_insert`, `_after_delete`, `_after_update`) keep the
  index in sync. The update trigger fires only when an indexed column changes.
- Tokenizer `unicode61 remove_diacritics 2`: language-neutral tokenization that handles Unicode
  and right-to-left scripts and matches `cafe` to `Café`. It does not remove Hebrew niqqud, so
  pointed and unpointed Hebrew words are different tokens.
- `note_plain_text` includes wikilink labels, so search finds the link text the reader sees.
- The index has no `workspace_id` column. Every search query joins back to `knowledge_nodes` on
  `row_key` and filters by `workspace_id`; the tests check that a match in another workspace is
  never returned or counted. Query building, ranking and snippets are described in
  [architecture.md](architecture.md#search).

### `relationship_types` (RelationshipType)

`label` (display form), `normalized_label` (case-folded, unique per workspace), `directionality`
(`directed` or `undirected`), `is_archived`, `is_builtin`. Archiving keeps a type usable by
existing edges while hiding it from new-edge choices.

Every new workspace is seeded with the five built-in types from PRD §4.2
(`packages/domain/src/knowledge/builtin-relationship-types.ts`): `related to` (undirected),
`depends on`, `part of`, `example of` (directed) and `contradicts` (undirected), with
`is_builtin = 1`. Seeding happens in the same transaction as the `workspaces` row.

Phase 2 behaviour (`packages/domain/src/application/relationship-service.ts`): users create
custom types, rename any type (built-in ones included) and archive or restore them. Labels follow
the tag label rules: trimmed, whitespace collapsed, at most 60 characters, unique by their NFKC
lower-cased `normalized_label`. Types are never deleted. `directionality` can be updated only
while no relationship uses the type; the service refuses earlier with `INVARIANT_VIOLATION`, and
the foreign key described below would refuse it anyway. Usage counts are computed with
`GROUP BY type_id` on `relationships`, not stored.

### `relationships` (Relationship)

Typed semantic edges between two nodes: `source_node_id`, `target_node_id`, `type_id`,
`directionality`, optional `description`. PRD §4.2 rules enforced in SQL as a second line of
defense behind the domain rule in `packages/domain/src/knowledge/relationship-rules.ts`:

- **No self-links:** `CHECK (source_node_id <> target_node_id)`.
- **Canonical undirected ordering:**
  `CHECK (directionality = 'directed' OR source_node_id < target_node_id)`. "A related to B" and
  "B related to A" must be stored identically, otherwise a reversed duplicate would slip past the
  uniqueness rule. The domain function `toStoredEndpoints` swaps endpoints into this order before
  writing.
- **No duplicates:** `UNIQUE (workspace_id, source_node_id, target_node_id, type_id)`. Different
  types between the same nodes are allowed, and for directed types the reverse direction is a
  different row and is allowed.
- **Directionality cannot change while a type is used.** Each relationship stores a copy of its
  type's directionality, and the foreign key is
  `(workspace_id, type_id, directionality) REFERENCES relationship_types (workspace_id, id, directionality)`
  (backed by a matching `UNIQUE` on `relationship_types`). Two consequences: a relationship
  cannot claim a directionality different from its type, and updating a used type's
  directionality fails because the existing relationships would no longer match. Unused types can
  still change. This foreign key has no `ON DELETE` action, so a type in use cannot be deleted
  either; it can only be archived.
- Deleting either endpoint node cascades to the relationship.

Phase 2 behaviour: rows are written only by `RelationshipService`, always after an explicit user
action. The service applies the same rules first (self-link → `INVARIANT_VIOLATION`, existing
row with the same stored endpoints and type → `DUPLICATE`, archived type → `VALIDATION_FAILED`),
so users see a clear message instead of a constraint error. `description` is trimmed, `NULL` when
empty, at most 1,000 characters. Updating a relationship can change its type (endpoints are
re-ordered canonically when the new type is undirected), its description, or swap source and
target of a directed one. `listForNode` returns both directions of a node with the type label and
both titles from one join. Creating a relationship also writes a `relationship_created` timeline
event.

### `note_references` (NoteReference)

One row per wikilink occurrence in a saved note: `source_node_id`, `ordinal`, `target_node_id`,
`label`, `context_excerpt` (shown in the target's backlinks). Primary key
`(source_node_id, ordinal)`; index `(workspace_id, target_node_id)` for backlinks.

These rows are derived data; the note JSON is the source of truth. How they are written
(`packages/storage-sqlite/src/repositories/sqlite-note-reference-repository.ts`):

- **Rebuilt per save.** Whenever a note is written (create, duplicate, or an update that includes
  the note), `KnowledgeNodeService` deletes all rows of that source node and inserts the current
  ones, in the same transaction as the node row (PRD §14). Removing a link and saving removes its
  row. The delete is `DELETE FROM note_references WHERE source_node_id = ? AND +workspace_id = ?`:
  the unary `+` stops SQLite from choosing the `(workspace_id, target_node_id)` index, which
  scanned every reference of the workspace on every save, so the primary key finds the note's
  rows directly (fixed in Phase 5; a query-plan test in `note-references.test.ts` guards it).
  Import rebuilds the references of every imported note the same way.
- **Only existing targets.** Each insert is `INSERT … SELECT … WHERE EXISTS` on
  `knowledge_nodes` in the same workspace. A link to a deleted node, or an ID from another
  workspace, is not stored; it stays in the note JSON and is shown as unresolved.
- **`ordinal`** is the occurrence's position among all wikilinks of the note, counted before
  missing targets are filtered out, so stored ordinals can have gaps.
- **`label`** is the link text as written in the note, not the target's title.
- **`context_excerpt`** is plain text from the block that contains the link (paragraph, heading,
  list item or table cell), about 160 characters centred on the link, cut at word boundaries with
  `…` (`excerptAround` in `packages/domain/src/notes/note-references.ts`).

**Backlinks** (`listBacklinks`) group rows by source note: one item per source with the label and
excerpt of its lowest `ordinal`, the number of occurrences, and the source's current title, ordered
by title (`COLLATE NOCASE`) then ID. Rows where source and target are the same node are ignored.
The delete preview counts distinct source notes the same way.

Deleting the target node cascades and removes the rows, but the link label stays readable in the
source note's JSON, where it is rendered as an unresolved link with a repair action (PRD §5.4).
Deleting the source node removes its own rows.

### `tags` and `node_tags` (Tag / NodeTag)

`tags` holds `display_label` and `normalized_label` with `UNIQUE (workspace_id, normalized_label)`,
so tags are unique per workspace regardless of case while keeping the user's spelling.
`node_tags` is the assignment table with primary key `(node_id, tag_id)`. Both of its foreign keys
are composite with `workspace_id`, so a tag can only be applied to a node in the same workspace.
Deleting a tag removes its assignments, never the nodes.

Phase 1 behaviour (`packages/domain/src/application/tag-service.ts`,
`packages/domain/src/text/labels.ts`): the display label is NFC-normalized, trimmed, with
whitespace runs collapsed, and at most 60 characters. `normalized_label` is the NFKC, lower-cased
form, so `Physics` and `PHYSICS` are one tag. Assigning by label finds or creates the tag and is
idempotent. Renaming changes only the labels, so every assignment is kept. Library filtering
returns nodes that carry all selected tags.

### `mind_maps` (MindMap)

`title`, `mode` (`freeform` or `hierarchical`), `viewport_json`, `revision`. Deleting a map
cascades to its placements and connectors, never to the canonical nodes (acceptance criterion 8).

Phase 3 behaviour (`packages/domain/src/application/map-service.ts`,
`packages/storage-sqlite/src/repositories/sqlite-map-repository.ts`):

- `title` is NFC-normalized, single-line, 1 to 200 characters without control characters. A
  duplicate is titled `<title> (copy)`.
- `viewport_json` is `{"x": …, "y": …, "zoom": …}`: the canvas pan and zoom, written by
  `setViewport` (zoom 0.05 to 8, coordinates within ±1,000,000). New maps start with
  `{"x":0,"y":0,"zoom":1}`, which the editor treats as "never saved" and fits the view. A value
  that cannot be parsed is read as that default instead of failing to open the map.
- `revision` starts at 1 and is the map's optimistic-concurrency counter (PRD §14). Every
  structural change (rename, adding, removing, moving, reparenting, collapsing or coloring an
  item, adding or removing a connector, switching mode) runs in one transaction that checks the
  expected revision, applies the change to `map_placements` or `map_connections`, and writes
  `revision + 1` and `updated_at` with `UPDATE … WHERE revision = ?`. Saving the viewport changes
  neither. Deleting a node raises the revision (not `updated_at`) of every map that shows it;
  deleting a relationship that a connector references changes neither.
- The map list is ordered by `updated_at` descending, then `id` (index `mind_maps_by_updated`),
  with the placement count computed by a subquery.

### `map_placements` (MapPlacement)

A canonical node placed on one map. Everything here is map-specific visual state:
`freeform_x`/`freeform_y`, `parent_placement_id`, `sibling_order`, `is_collapsed`, `style_json`.
Note content stays on the node, so editing it updates every map that shows it.

- `UNIQUE (map_id, node_id)`: a node appears at most once per map, but in any number of maps.
- Freeform coordinates are kept while a map is in hierarchical mode, so switching back restores
  them (PRD §5.6).
- **Parent in the same map:** `FOREIGN KEY (map_id, parent_placement_id) REFERENCES map_placements (map_id, id)`.
  A placement cannot be its own parent (`CHECK`).
- **No action on parent delete.** This foreign key has no `ON DELETE` clause, so deleting a
  placement that still has children fails. The service must first reparent or promote the
  children; the result is an explicit, previewable choice rather than a silent subtree deletion
  or a set of orphans. Deleting a whole map still works, because all its placements go in one
  statement.
- **Cycle trigger.** `map_placements_reject_cycles` runs before any update of
  `parent_placement_id`. It walks the new parent's ancestor chain with a recursive CTE and aborts
  with `mmap: hierarchy cycle` if it reaches the row being moved. Inserts are not checked because
  a new row has no descendants. The CTE uses `UNION` rather than `UNION ALL`, so it terminates
  even on corrupted data.

Phase 3 behaviour:

- `freeform_x` and `freeform_y` are the item's position on the freeform canvas, rounded to whole
  pixels by the editor. In hierarchical mode they are neither used nor changed: the tree layout is
  computed from `parent_placement_id`, `sibling_order` and `is_collapsed` each time the map is
  shown and is never stored.
- `parent_placement_id` is `NULL` for a top-level item. `sibling_order` is the position among
  siblings; ties are broken by `id`. Moves renumber the affected sibling groups as 0, 1, 2, …
- `style_json` is `{"color": <name or null>}`, where the name is one of `gray`, `blue`, `green`,
  `amber`, `red` and `violet`. An unknown value is read as `{"color": null}` (the default look).
- `is_collapsed` hides the item's descendants in hierarchical mode; freeform mode shows every
  item.
- **Removing an item from a map** first moves its children into its place among its siblings, in
  their order, then deletes the placement. The node is never deleted.
- **Deleting a node** first sets the parent of each child of the node's placements to that
  placement's parent (`NULL` for a top-level placement), keeping their `sibling_order`, raises the
  revision of the affected maps, then deletes the node; its placements and their connectors
  cascade.
- Placements are read with the node's current title (`JOIN knowledge_nodes`), never with a copy.

The domain checks every rule before writing (`NOT_FOUND`, `DUPLICATE`, `INVARIANT_VIOLATION`), so
users see a clear message; the constraints above remain the second line of defense.

### `map_connections` (MapConnection)

Visual connectors between two placements on the same map: `source_placement_id`,
`target_placement_id`, optional `relationship_id`, `label`, `style_json`. Freeform connectors may
form cycles; only the hierarchy is acyclic. Both endpoints reference `(map_id, id)` on
`map_placements`, so they must be on the connector's map. `relationship_id` is set to `NULL` when
the relationship is deleted, and the workspace triggers described above keep it in the same
workspace.

Phase 3 behaviour: a connector is written only by `MapService.addConnection`, in a structural
change of its map. `source_placement_id` is where the user started drawing, shown as the arrow's
tail. `label` is optional (at most 200 characters, `NULL` when empty). `relationship_id` is set
only when the request names an existing relationship whose two nodes are exactly the nodes of the
two placements, in either direction; the service never creates a relationship. `style_json` is
always `{}`: connectors have no styling yet. Removing either placement deletes the connector by
cascade. Connectors are listed by `created_at`, then `id`, with the referenced relationship's type
label from a `LEFT JOIN`.

### `map_regions` (map regions, migration 7)

Named rectangles on freeform maps that group items by subject
([ADR-0013](adr/0013-map-regions.md)): `title` (1 to 100 characters), `color` (one of the
placement colors, or `NULL`), `x`, `y`, `width`, `height` (sides greater than 0; the service
requires at least 40), timestamps, and a cascade with the map. Membership is not stored: an item is
in the smallest region that contains its center. Regions are written only in structural changes of
their map (`addRegion`, `updateRegion` with the items carried along, `removeRegion`,
`saveArrangement`), are listed by `created_at`, then `id`, and are copied with the map. A map has
at most 200.

### `timeline_events` (TimelineEvent)

Recorded learning activity and the user's own learning entries: `event_type` (`node_created`,
`note_updated`, `relationship_created`, `reviewed`, `milestone`), `occurred_at`,
`last_activity_at`, optional `learned_at`, `title` (milestones only), optional `reflection`,
`is_imported`, `import_origin`. Since migration 5 the table has this shape; migration 1 created it
without `milestone`, `learned_at` and `title`.

- Events outlive deleted nodes: `node_id` becomes `NULL` and `node_title_snapshot` keeps the
  label readable. A milestone may have no node at all.
- Grouped note edits use `occurred_at` as the start and `last_activity_at` as the latest activity
  of an editing session (ended by 30 minutes of inactivity, PRD §5.9).
  `CHECK (last_activity_at >= occurred_at)`.
- **Two times.** `occurred_at` is when the action was recorded and never changes. `learned_at`
  (nullable, a UTC timestamp with the same fixed-width `CHECK` as every other timestamp) is an
  optional moment, chosen by the user, when the learning actually happened. The timeline places
  each event at its effective time, `coalesce(learned_at, occurred_at)`, so without a learning
  date it shows the recorded time. `TimelineService` accepts a learning date only if it is a valid
  instant, not in the future (5 minutes of clock difference tolerated) and not before 1900.
- `title` holds a milestone's title:
  `CHECK ((event_type = 'milestone' AND title IS NOT NULL AND length(trim(title)) > 0) OR (event_type <> 'milestone' AND title IS NULL))`.
  The service also collapses whitespace and limits it to 200 characters
  (`normalizeMilestoneTitle`).
- `CHECK (is_imported = 1 OR import_origin IS NULL)`: only imported events carry an origin, so
  imported history is always recognisable and never counts as new learning.
- `reflection` is used only by `reviewed` and `milestone` events: the user's optional note about
  a review, or a milestone's details, at most 2,000 characters after trimming, with line breaks
  kept (`normalizeReflection` in `timeline-service.ts`). Recorded activity always has
  `reflection = NULL`.
- `is_imported` and `import_origin`: events recorded in the workspace have `is_imported = 0` and
  no origin. Every event added by a ZIP import (Phase 5) has `is_imported = 1` and the origin
  `<source workspace name> (exported YYYY-MM-DD)`, also when it was already marked as imported in
  the archive. The Timeline view shows an "Imported" badge for such events. `import_origin` is
  never sent to the renderer.

#### What is recorded

`KnowledgeNodeService` (`packages/domain/src/application/knowledge-node-service.ts`) writes two
event types, always in the same transaction as the node change, `RelationshipService` writes a
third, and `TimelineService` (`packages/domain/src/application/timeline-service.ts`) writes the
fourth and fifth when the user asks for them.

- **`node_created`**: one event when a node is created, including by duplication, with the title
  as `node_title_snapshot`.
- **`note_updated`**: recorded only when a save changes the stored note JSON. Saves that change
  only the title or summary, or that send an identical note, record nothing.
- **`relationship_created`** (Phase 2): one event per created relationship, in the same
  transaction, with the request's source node as `node_id` and its title as snapshot. Updates and
  deletions of relationships record nothing, and the event names neither the target nor the type.
- **`reviewed`** (Phase 4): one event each time the user chooses "Mark as reviewed…" for a node,
  with `occurred_at = last_activity_at` = the time of the review, the node's title as snapshot,
  the optional `reflection` and an optional `learned_at`.
- **`milestone`** (Phase 4, migration 5): one event each time the user adds a learning milestone,
  with `occurred_at = last_activity_at` = the time it was added, the `title`, optional details in
  `reflection`, an optional node (with its title as snapshot) and an optional `learned_at` (the
  dialog fills in the current time by default).

**Editing-session grouping** (`packages/domain/src/timeline/editing-session.ts`, PRD §5.9). Autosave
writes roughly once per second of idle typing, so recording every save would flood the timeline.
On a note change, the service looks up the node's latest `note_updated` event. If less than
30 minutes have passed since its `last_activity_at`, the same event is extended: `last_activity_at`
moves to the new save time and `node_title_snapshot` is refreshed. Otherwise (a gap of exactly 30
minutes or more, or a clock that moved backwards) a new event starts with
`occurred_at = last_activity_at = save time`.

#### Who may change an event

Recorded activity (`node_created`, `note_updated`, `relationship_created`) is immutable from the
user's side: no channel changes its title or reflection or deletes it, and `TimelineService`
refuses with `INVARIANT_VIOLATION`. The only later writes are the node service extending a
running editing session as described above, and `learned_at`, which the user may set or clear
on any event because it annotates the record without changing what was recorded. `reviewed` and
`milestone` events are the user's own: the reflection (and a milestone's title) can be changed or
cleared, and the event can be deleted. `SqliteTimelineEventRepository.update` writes only the
columns that change (`title`, `reflection`, `learned_at`). See
[architecture.md](architecture.md#learning-timeline) for the reasons.

#### How the timeline reads it

Both queries of `SqliteTimelineEventRepository` work on the effective time,
`coalesce(learned_at, occurred_at)`, and filter by workspace, by event type, by node, and by tags
that the node carries now. A `LEFT JOIN` on `knowledge_nodes` adds the node's current title; for
a deleted node the snapshot is shown instead.

- **`list`** (List tab) filters by an effective-time range (inclusive start, exclusive end,
  computed from local dates in the workspace timezone), orders by effective time `DESC, id DESC`
  and pages with a keyset cursor holding the last row's effective time and ID.
- **`window`** (Timeline tab) takes a half-open UTC range of effective times and returns its
  total and at most 2,000 events, oldest first. When the range holds more, it is split into 200
  equal time buckets and events are taken round-robin with `row_number()` per bucket (the latest
  event of every bucket, then the second latest, and so on), so a burst of activity never hides a
  quieter period.

Migration 5 keeps the three migration 1 indexes `timeline_events_by_time`,
`timeline_events_by_node` and `timeline_events_by_type` (each starting with `workspace_id` and
ending with `occurred_at DESC`) and adds `timeline_events_by_effective_time` on
`(workspace_id, coalesce(learned_at, occurred_at) DESC, id DESC)` for the effective-time order.
Because an editing session is stored with its start in `occurred_at`, it is ordered, filtered and
grouped by day by its start time unless it has a learning date.

### `graph_node_positions` (graph layout)

Created by migration 3 (`0003-graph-layout.ts`). Where the user left each node on the global
knowledge graph: `workspace_id`, `node_id`, `x`, `y` (`REAL`) and `updated_at`, with primary key
`(workspace_id, node_id)`. This is visual state of the graph view only (PRD §5.7):

- It never changes knowledge (nodes, relationships, note references).
- It is separate from `map_placements`, so moving a node on the graph never moves it on any map,
  and the reverse (PRD §4.4: each map keeps its own layout). Test: "never moves a node inside any
  mind map".
- `FOREIGN KEY (workspace_id, node_id) REFERENCES knowledge_nodes (workspace_id, id) ON DELETE CASCADE`:
  a position belongs to a node of the same workspace and is deleted with it.
- `SqliteGraphLayoutRepository` reads positions in batches of 500 IDs and saves with
  `INSERT … SELECT … WHERE EXISTS … ON CONFLICT DO UPDATE`, so a position for a node deleted since
  the renderer read it (or of another workspace) is skipped instead of failing the whole save.
  `GraphService` refuses coordinates beyond ±1,000,000 and more than 5,000 positions per call.

Only nodes the user has seen on the graph have a row; the renderer places the rest
([architecture.md](architecture.md#stable-positions)).

**`graph_view_state`** (one row per workspace with `viewport_json`) was also created by migration
3, to reopen the graph at the last pan and zoom. The graph now always opens fitted to view, so
nothing reads or writes it, and migration 4 drops it. It held only pan and zoom, so no knowledge
is lost.

### `attachments` (Attachment)

Metadata for files copied into the workspace's managed attachments folder: `node_id`,
`relative_path`, `original_name`, `mime_type`, `byte_size`, `sha256`, `state` (`staged` or
`committed`).

- `relative_path` is generated by the attachment store and never derived from the user's file
  name. A `CHECK` rejects, as defense in depth against path traversal: empty paths, a leading
  `/`, any `:` (drive letters), backslashes, NUL characters, and `..` segments at the start,
  middle or end. It is also `UNIQUE`. The store validates the path again, including symlink and
  junction escapes, every time it reads or deletes a file.
- `sha256` must be 64 lowercase hex characters.
- `original_name` holds the sanitized display name; `mime_type` is decided by
  `classifyAttachment` (raster image types only when the bytes match).

#### Attachment lifecycle

Staging happens on disk, not in the table. In Phase 1 rows are only ever inserted with
`state = 'committed'`; the `staged` value is reserved and no code writes it (listing filters on
`committed`).

1. **Staged file.** The bytes are copied to `attachments/.staging/<id>.tmp`, fsynced and
   checksum-verified. No row exists yet.
2. **Stored file.** The staged file is renamed to `attachments/<shard>/<uuid>.<ext>`. Still no row.
3. **Committed row.** `AttachmentService.register` inserts the row in a write transaction. If the
   insert fails, the stored file is deleted at once.
4. **Removal.** `attachments:remove` deletes the row, then the file. `nodes:delete` deletes the
   node (rows cascade), then the files.
5. **Reconciliation.** On every workspace open, files in `.staging` and stored files without a row
   (a crash between steps 2 and 3, or a failed file deletion in step 4) are deleted. Rows whose
   file is missing are reported and kept, never deleted automatically.

See [architecture.md](architecture.md#attachments) for the file-type policy and preview rules.

### `transfer_jobs` (TransferJob)

Designed for long-running export, import, backup and restore jobs: `kind` (`export_zip`,
`export_markdown`, `import_zip`, `backup`, `restore`), `state` (`pending`, `running`,
`succeeded`, `failed`, `cancelled`), `progress` (0 to 1), `idempotency_key` (unique per
workspace, so a retried request does not start a second job), `result_relative_path`,
`expires_at`, `error_code`.

**Phase 5 uses it only as the import history**
(`packages/storage-sqlite/src/portability/sqlite-import-history-repository.ts`). Each completed
ZIP import writes one row, in the same transaction as the imported records: `kind = 'import_zip'`,
`state = 'succeeded'`, `progress = 1`, and the idempotency key `import:<exportId>:<jobId>`, where
`exportId` is the random ID in the archive's manifest and `jobId` the row's own ID. The job ID
keeps the key unique, so the same archive can be imported again after the user confirmed the
duplicate warning. Earlier imports of an archive are found by the key prefix `import:<exportId>:`
(compared with `substr`, not `LIKE`, so characters in the export ID can never act as wildcards).
Exports, backups, restores and failed imports are not recorded, and no row is ever in another
state: there is no progress reporting or cancellation yet.

The table is not exported: an imported workspace's history of its own imports does not travel
with it.

### `schema_migrations` (bookkeeping)

Created by the migration runner, not by migration 1. One row per applied migration: `version`,
`name`, `sha256` of its SQL, `applied_at`.

## Export archive and backup layouts

Workspace data also exists outside `mmap.sqlite` in two formats (Phase 5). Neither is a table, but
both mirror this schema.

**ZIP export** (`packages/domain/src/portability/archive-format.ts`,
[ADR-0011](adr/0011-export-import.md)):

```
manifest.json            format "mmap-workspace-export", formatVersion 3, exportId, exportedAt,
                         appVersion, schemaVersion, workspace { id, name, timezone }, counts,
                         files [{ path, byteSize, sha256 }]
data/workspace.json      nodes, tags, nodeTags, relationshipTypes, relationships, maps,
                         placements, connections, timelineEvents, attachments, graphPositions
attachments/<id>         the bytes of each attachment, named by its attachment ID
```

`data/workspace.json` is a field-by-field mapping of the rows (`toArchiveData` in
`export-archive.ts`), with the source workspace's IDs and UTC timestamps. A node's note is
embedded as a JSON object, not a string. Not exported: `workspace_id` columns, revisions,
`note_plain_text`, stored attachment paths, staged attachments, `knowledge_nodes_fts`,
`note_references` (rebuilt from the notes on import), `transfer_jobs`, `schema_migrations`, and
everything outside the database except attachment files (lock, `recovery/`, logs, machine
settings). On import, every record gets a new ID; see
[architecture.md](architecture.md#import).

**Backup snapshots** (`apps/desktop/src/main/backups/snapshot-store.ts`,
[ADR-0006](adr/0006-backup-policy.md)):

```
<destination>/<workspace ID>/
  snapshots/<UTC time>/        one folder per snapshot, e.g. 2026-10-27T09-15-00-123Z
    backup.json                format "mmap-backup", formatVersion 1, snapshotId, workspaceId,
                               workspaceName, createdAt, appVersion, schemaVersion,
                               database { byteSize, sha256 }, attachments [{ relativePath,
                               sha256, byteSize }], missingAttachments
    mmap.sqlite                consistent, integrity-checked copy of the database
  files/<ab>/<sha256>          attachment bytes, stored once per content and shared by snapshots
```

A snapshot keeps the source workspace's IDs and its stored attachment paths, because restoring it
recreates the same workspace. `<destination>` is `<userData>/backups` by default.

## Migrations

Schema changes are ordered TypeScript modules that export SQL text, listed in
`packages/storage-sqlite/src/migrations/index.ts`. They are bundled into the main process, so an
installed build cannot be missing one. The strategy and its reasons are recorded in
[ADR-0007](adr/0007-database-migrations-strategy.md); the runner
(`packages/storage-sqlite/src/migrations/runner.ts`) behaves as follows:

- **Versions** are sequential from 1 with no gaps; `LATEST_SCHEMA_VERSION` is the number of
  migrations. A non-sequential list is a programming error and throws.
- **Newer databases are refused untouched.** `PRAGMA user_version` is read first; if it is higher
  than this build supports, `SchemaTooNewError` is thrown before anything is written.
- **History is verified.** The stored `schema_migrations` rows must match the shipped migrations
  by version and SHA-256. An edited released migration or an unknown one raises
  `MigrationHistoryError`. Released migrations are therefore immutable: change the schema only by
  appending a new migration.
- **Each migration is its own transaction.** It runs inside `BEGIN IMMEDIATE` together with its
  bookkeeping row and the `user_version` update. On failure it is rolled back and
  `MigrationFailedError` reports the version that failed; the database stays at the last fully
  applied version.
- **Backup hook.** `beforeApply` runs once before the first pending migration. If it throws,
  nothing is applied. `openWorkspaceDatabase`
  (`packages/storage-sqlite/src/workspace-database.ts`) uses it to write a verified online backup
  of an existing database to the workspace's `recovery/` folder as
  `pre-migration-v<from>-to-v<to>-<timestamp>.sqlite` ([ADR-0006](adr/0006-backup-policy.md)). A
  brand-new database (version 0) is not backed up.
- Migration SQL must not contain statements that are invalid inside a transaction, such as
  `VACUUM` or `PRAGMA journal_mode`.

### Shipped migrations

| Version | File                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `0001-initial-schema.ts`                 | The complete schema described on this page.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2       | `0002-note-schema-v2-marker.ts`          | `SELECT 1;`. No table change. Raises the database version so that builds that only understand note schema version 1 (Phase 1) refuse the workspace as "too new" instead of failing later on notes with wikilinks ([ADR-0008](adr/0008-wikilinks-and-note-schema-v2.md)).                                                                                                                                                                                                                                |
| 3       | `0003-graph-layout.ts`                   | Creates `graph_node_positions` and `graph_view_state` for the knowledge graph ([above](#graph_node_positions-graph-layout)).                                                                                                                                                                                                                                                                                                                                                                            |
| 4       | `0004-drop-graph-view-state.ts`          | `DROP TABLE graph_view_state;`. The graph now always opens fitted to view, so the saved viewport is no longer used.                                                                                                                                                                                                                                                                                                                                                                                     |
| 5       | `0005-timeline-milestones-learned-at.ts` | Rebuilds `timeline_events` ([above](#timeline_events-timelineevent)), because SQLite cannot change a `CHECK` constraint in place: creates the new table with `milestone` allowed in `event_type` and the new columns `learned_at` and `title`, copies every row (with both new columns `NULL`), drops the old table, renames the new one, recreates the three indexes and both workspace triggers, and adds the index `timeline_events_by_effective_time`. No other table references `timeline_events`. |
| 6       | `0006-map-arrangement.ts`                | Adds `mind_maps.arrangement_json` (default `{}`): the last automatic layout of a freeform map and its line routes ([ADR-0012](adr/0012-automatic-map-layout.md)).                                                                                                                                                                                                                                                                                                                                       |
| 7       | `0007-map-regions.ts`                    | Creates `map_regions` and its index ([above](#map_regions-map-regions-migration-7), [ADR-0013](adr/0013-map-regions.md)).                                                                                                                                                                                                                                                                                                                                                                               |

Opening a Phase 1 workspace with a Phase 2 build therefore takes a verified backup to `recovery/`
and applies migration 2. After that, a Phase 1 build cannot open the workspace. In the same way,
the Phase 4 build backs up a Phase 2 or Phase 3 workspace and applies migrations 3 to 5 (or only
migration 5 to a workspace already at version 4); after that, a Phase 3 build refuses it as too
new, and so does a Phase 4 build from before the timeline redesign.

**Why migration 4 instead of editing migration 3.** Migration 3 had already been applied to a
development workspace when the saved viewport was dropped. The runner compares the SHA-256 of
every applied migration with the shipped code and refuses a workspace whose history differs
(`MigrationHistoryError`), so editing migration 3 would have locked that workspace out. The change
was therefore made as a new migration, and migration 3 keeps its original SQL (its header comment
explains this). `packages/storage-sqlite/src/migrations/checksums.test.ts` now pins the checksum
of every shipped migration (1 to 7), so such an edit fails in the test suite instead of on a
user's workspace. For the same reason the timeline redesign added migration 5 instead of changing
migration 1.

### Adding a migration

1. Create `packages/storage-sqlite/src/migrations/NNNN-short-name.ts` exporting a `Migration`
   with the next `version`.
2. Append it to `ALL_MIGRATIONS` in `migrations/index.ts`. Never edit or reorder earlier entries.
3. Add tests on real temporary databases (`test-support/temporary-database.ts`) for the new
   constraints and for migrating a database created at the previous version.
4. Append its checksum to `PINNED_CHECKSUMS` in `migrations/checksums.test.ts`.
5. Update this page.

## Connection settings

`openDatabase` in `packages/storage-sqlite/src/connection.ts` applies these settings to every
connection:

| Setting                         | Why                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foreign_keys = ON` (verified)  | All workspace and integrity rules depend on it; SQLite disables it by default.                                                                            |
| `journal_mode = WAL` (verified) | Readers do not block the writer. Fails with `DatabaseConfigurationError` if unavailable, which happens on unsupported filesystems such as network shares. |
| `synchronous = FULL`            | "Saved" must mean durable (PRD §9); `NORMAL` in WAL mode can lose the last commits on power loss.                                                         |
| `trusted_schema = OFF`          | A tampered database file cannot use unsafe functions from triggers or views.                                                                              |
| Busy timeout 5000 ms            | A competing lock produces a bounded wait and then a visible error, not an endless hang.                                                                   |
| Double-quoted strings disabled  | `"x"` is always an identifier, turning silent SQL typos into errors.                                                                                      |
| Extension loading disabled      | A database file can never load native code.                                                                                                               |

An open workspace uses two connections from this factory: a writer, and a read-only reader that
only verifies the journal mode instead of setting it. All writes go through the single write
coordinator described in [architecture.md](architecture.md#write-coordinator).
