# Data model

This page explains the SQLite schema created by migration 1,
`packages/storage-sqlite/src/migrations/0001-initial-schema.ts`. It maps each table to the logical
entities in PRD §7.3 and explains the constraints that are not obvious from the SQL.

Migration 1 creates the complete schema for the whole logical model. Phase 1 services use part of
it; the rest waits for the phases that need it (see [Table usage](#table-usage-in-phase-1)). The
schema is verified by the tests in `packages/storage-sqlite/src/migrations/initial-schema.test.ts`.

## Table usage in Phase 1

Repositories are in `packages/storage-sqlite/src/repositories/`; the services that call them are
in `packages/domain/src/application/`. Every repository method takes the workspace ID and filters
by it, so a record from another workspace behaves as not found.

| Table                                            | Status       | Written by                                                                                               |
| ------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `workspaces`                                     | Used         | `WorkspaceService.initialize` (create), `rename`; read on every open to check the manifest ID            |
| `knowledge_nodes`                                | Used         | `KnowledgeNodeService`: create, update, duplicate, delete; keyset-paginated listing in three sort orders |
| `knowledge_nodes_fts`                            | Maintained   | Kept in sync by triggers on every node write; not queried until the Phase 2 search UI                    |
| `relationship_types`                             | Seeded only  | `WorkspaceService.initialize` inserts the five built-in types; nothing else reads or writes them yet     |
| `tags`, `node_tags`                              | Used         | `TagService`; `KnowledgeNodeService.duplicate` copies assignments                                        |
| `timeline_events`                                | Used (write) | `node_created` on create and duplicate; `note_updated` grouped by editing session. No UI reads them yet  |
| `attachments`                                    | Used         | `AttachmentService` (register, list, remove); rows cascade when a node is deleted                        |
| `relationships`                                  | Not used yet | Phase 2. Only counted by the node delete preview                                                         |
| `note_references`                                | Not used yet | Phase 2. Only counted by the node delete preview                                                         |
| `mind_maps`, `map_placements`, `map_connections` | Not used yet | Phase 3. Node deletion already promotes child placements (see below)                                     |
| `transfer_jobs`                                  | Not used yet | Phase 5                                                                                                  |
| `schema_migrations`                              | Used         | Migration runner                                                                                         |

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
same transaction as the built-in relationship types. `timezone` is set from the operating system
when the workspace is created and is used to display dates.

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
- Phase 1 behaviour: titles are NFC-normalized, single-line, 1 to 300 characters; summaries are
  optional, up to 2,000 characters (`packages/domain/src/knowledge/node-fields.ts`). `note_json`,
  `note_schema_version` (currently 1) and `note_plain_text` are always written together from the
  same validated document. Every update increments `revision`; an update or delete with an outdated
  revision fails with `REVISION_CONFLICT` and changes nothing. Tag changes do not touch the
  revision.
- Deleting a node first moves the children of its map placements up to the deleted placement's
  parent (the hierarchy foreign key refuses to orphan them), then deletes the row; relationships,
  placements, references from this node, tag assignments and attachment rows cascade.
  `timeline_events.node_id` becomes `NULL`.

### `knowledge_nodes_fts` (search index, PRD §5.8)

An FTS5 virtual table over `title`, `summary` and `note_plain_text`.

- **External content** (`content = 'knowledge_nodes'`, `content_rowid = 'row_key'`): text is
  stored once, in `knowledge_nodes`; the index holds only tokens.
- Three triggers (`knowledge_nodes_fts_after_insert`, `_after_delete`, `_after_update`) keep the
  index in sync. The update trigger fires only when an indexed column changes.
- Tokenizer `unicode61 remove_diacritics 2`: language-neutral tokenization that handles Unicode
  and right-to-left scripts and matches `cafe` to `Café`.
- The index has no `workspace_id` column. Every search query must join back to
  `knowledge_nodes` on `row_key` and filter by `workspace_id`; the tests check that a match in
  another workspace is never returned.

### `relationship_types` (RelationshipType)

`label` (display form), `normalized_label` (case-folded, unique per workspace), `directionality`
(`directed` or `undirected`), `is_archived`, `is_builtin`. Archiving keeps a type usable by
existing edges while hiding it from new-edge choices.

Every new workspace is seeded with the five built-in types from PRD §4.2
(`packages/domain/src/knowledge/builtin-relationship-types.ts`): `related to` (undirected),
`depends on`, `part of`, `example of` (directed) and `contradicts` (undirected), with
`is_builtin = 1`. Seeding happens in the same transaction as the `workspaces` row. Nothing else uses
the table until relationships arrive in Phase 2.

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

### `note_references` (NoteReference)

One row per wikilink occurrence in a saved note: `source_node_id`, `ordinal` (position in the
note), `target_node_id`, `label`, `context_excerpt` (shown in the target's backlinks). Primary key
`(source_node_id, ordinal)`.

These rows are derived data. Phase 2 rebuilds them for a node in the same transaction that saves
its note (PRD §14). Deleting the target node cascades and removes the rows, but the link label
stays readable in the source note's JSON, where it is rendered as an unresolved link with a
repair action (PRD §5.4).

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

### `map_connections` (MapConnection)

Visual connectors between two placements on the same map: `source_placement_id`,
`target_placement_id`, optional `relationship_id`, `label`, `style_json`. Freeform connectors may
form cycles; only the hierarchy is acyclic. Both endpoints reference `(map_id, id)` on
`map_placements`, so they must be on the connector's map. `relationship_id` is set to `NULL` when
the relationship is deleted, and the workspace triggers described above keep it in the same
workspace.

### `timeline_events` (TimelineEvent)

Recorded learning activity: `event_type` (`node_created`, `note_updated`,
`relationship_created`, `reviewed`), `occurred_at`, `last_activity_at`, optional `reflection`,
`is_imported`, `import_origin`.

- Events outlive deleted nodes: `node_id` becomes `NULL` and `node_title_snapshot` keeps the
  label readable.
- Grouped note edits use `occurred_at` as the start and `last_activity_at` as the latest activity
  of an editing session (ended by 30 minutes of inactivity, PRD §5.9).
  `CHECK (last_activity_at >= occurred_at)`.
- `CHECK (is_imported = 1 OR import_origin IS NULL)`: only imported events carry an origin, so
  imported history is always recognisable and never counts as new learning.

#### What Phase 1 records

`KnowledgeNodeService` (`packages/domain/src/application/knowledge-node-service.ts`) writes two
event types, always in the same transaction as the node change. No UI shows them yet (Phase 4).

- **`node_created`**: one event when a node is created, including by duplication, with the title
  as `node_title_snapshot`.
- **`note_updated`**: recorded only when a save changes the stored note JSON. Saves that change
  only the title or summary, or that send an identical note, record nothing.

**Editing-session grouping** (`packages/domain/src/timeline/editing-session.ts`, PRD §5.9). Autosave
writes roughly once per second of idle typing, so recording every save would flood the timeline.
On a note change, the service looks up the node's latest `note_updated` event. If less than
30 minutes have passed since its `last_activity_at`, the same event is extended: `last_activity_at`
moves to the new save time and `node_title_snapshot` is refreshed. Otherwise (a gap of exactly 30
minutes or more, or a clock that moved backwards) a new event starts with
`occurred_at = last_activity_at = save time`. `relationship_created` and `reviewed` are not
written yet.

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

Long-running export, import, backup and restore jobs: `kind`, `state`, `progress` (0 to 1),
`idempotency_key` (unique per workspace, so a retried request does not start a second job),
`result_relative_path`, `expires_at`, `error_code`. Used from Phase 5.

### `schema_migrations` (bookkeeping)

Created by the migration runner, not by migration 1. One row per applied migration: `version`,
`name`, `sha256` of its SQL, `applied_at`.

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

### Adding a migration

1. Create `packages/storage-sqlite/src/migrations/NNNN-short-name.ts` exporting a `Migration`
   with the next `version`.
2. Append it to `ALL_MIGRATIONS` in `migrations/index.ts`. Never edit or reorder earlier entries.
3. Add tests on real temporary databases (`test-support/temporary-database.ts`) for the new
   constraints and for migrating a database created at the previous version.
4. Update this page.

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
