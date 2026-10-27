# ADR-0011: Workspace export and import

- Status: Accepted
- Date: 2026-10-27

## Context

PRD §5.11 requires a complete, portable ZIP export (a versioned JSON manifest, nodes, rich notes,
tags, relationship types, relationships, map placements and structure, timeline records, and
attachment files with checksums), a readable Markdown export, and an import of the ZIP format with
schema validation, archive size and entry limits, path traversal protection, checksums and a
preview of changes and warnings. By default an import creates new records with an explicit ID
mapping and rewrites every internal reference; re-importing the same archive must show a
duplicate warning first. The whole package must be validated before anything changes, attachments
staged, records applied in one transaction, and staged files cleaned up on failure. Exports must
contain workspace data only: no locks, temporary files, logs, machine-specific settings or
credentials. Acceptance criterion 12 requires a round trip into a fresh workspace to preserve
every entity, direction, hierarchy, note content and attachment checksum, and an invalid or
interrupted import to leave no partially visible change. PRD §8 and §11 treat archives as hostile
input (traversal, links, zip bombs), and PRD §5.9 requires imported timeline history to be marked
as imported.

The workspace database uses UUIDs as primary keys, composite foreign keys that tie every record to
its workspace ([implementation plan §1](../implementation-plan.md)), and stores undirected
relationships in canonical endpoint order. Notes are validated JSON documents that contain
wikilink target IDs and attachment IDs ([ADR-0008](0008-wikilinks-and-note-schema-v2.md)).

## Decision

1. **One ZIP with a manifest, one data document and the attachment files.** `manifest.json`
   carries `format: "mmap-workspace-export"`, `formatVersion` (1), a random `exportId`, the export
   time, the app and schema versions, the source workspace (ID, name, timezone), counts, and every
   other file with its size and SHA-256. `data/workspace.json` holds every entity as plain JSON
   (nodes with their notes as JSON objects, tags, tag assignments, relationship types,
   relationships, maps, placements, connectors, timeline events, attachment metadata, graph
   positions). `attachments/<attachment ID>` holds each file's bytes, named by ID only. The format
   is defined in the domain (`packages/domain/src/portability/archive-format.ts`) and mapped field
   by field from the records, so storage details (workspace IDs, revisions, derived plain text,
   stored paths, the search index, derived note references, `transfer_jobs`) never leak into it.
2. **A consistent snapshot, verified files, atomic output.** Export reads every record in one read
   transaction on the reader connection, without blocking writers. An attachment whose file is
   missing or no longer matches its checksum is left out with a warning, so the archive never
   vouches for bytes it cannot verify. The ZIP is written to a temporary file and renamed into
   place when complete.
3. **Import creates new records with new IDs.** Every record gets a new ID through an explicit
   mapping (`planImport`), and every reference is rewritten: relationship endpoints (re-ordered
   for undirected types), placement parents, connector ends and relationship links, tag
   assignments, timeline nodes, graph positions, and the wikilinks and attachment blocks inside
   notes. Archive IDs are never written. A wikilink to a node that is not in the archive gets a
   fresh, unused target ID and shows as an unresolved link.
4. **Tags and relationship types merge by label.** A tag whose label matches an existing one
   (ignoring case and spacing) is reused. A relationship type is reused only when its label and
   direction both match; when only the label matches, the imported type is created as
   "`<label> (imported)`" and the preview warns, so no relationship changes direction. Imported
   types are never built-in.
5. **Duplicates are detected by export ID.** Each completed import is recorded in `transfer_jobs`
   (`kind = 'import_zip'`, idempotency key `import:<exportId>:<jobId>`). The preview lists earlier
   imports of the same archive, and applying it again requires an explicit confirmation
   (`acceptDuplicate`); otherwise the request fails with `DUPLICATE`. An archive exported from the
   open workspace itself gets a warning that importing adds a second copy.
6. **Safe reading before any decompression.** The ZIP's central directory is read and checked in
   full first: limits on archive size (4 GiB), entries (200,000), declared total size (8 GiB),
   manifest (64 MiB) and data (256 MiB); strict names (no traversal, absolute or drive paths,
   control characters, empty or dot segments, or names that repeat in any letter case); no
   encrypted entries or symbolic links. Actual inflated bytes are counted against each entry's
   limit. The layout must be exactly the manifest, the data file and `attachments/<UUID>` entries,
   each listed in the manifest with its size and checksum. Nothing is ever extracted to a path
   taken from the archive.
7. **Validate everything, then apply in one transaction.** Strict zod schemas check the shape
   (unknown fields refused); the format version is checked first, so a newer archive gets an
   "Update mmap" message (`ARCHIVE_TOO_NEW`). The domain planner then checks meaning with the same
   rules as user input (titles, labels, notes, dates, uniqueness, no self-relationships, no
   hierarchy cycles, connectors consistent with their relationships). Only after a successful
   preview does apply copy each attachment through a temporary file into the attachment store
   (checksum verified twice) and write every record in one transaction; a failure removes the
   copied files.
8. **The attachment policy is applied again.** Each attachment is classified from its actual name,
   size and leading bytes, exactly as when a user attaches a file. Executables and files above
   this computer's size limit are skipped with a warning, and the stored MIME type comes from the
   policy, never from the archive.
9. **Imported history is marked.** Every imported timeline event is stored with
   `is_imported = 1` and the origin "`<workspace name> (exported YYYY-MM-DD)`".
10. **Two steps over IPC.** `transfer:preview-import` opens the file dialog in the main process,
    validates and plans, and keeps the prepared import (with the open archive) under a random
    token for 10 minutes; `transfer:apply-import` takes only that token. The renderer never sends
    a path, and what is applied is exactly what was previewed.
11. **Markdown is export-only.** The Markdown export (one file per node with JSON-string front
    matter holding the stable ID, `[[file|label]]` wikilinks, LaTeX math source, attachment links
    and a list of relationships) is for reading in other tools. It leaves out maps and timeline
    history and cannot be imported (PRD §5.11 puts arbitrary Markdown import outside version 1).

## Consequences

- Importing can never overwrite or address existing records, and importing into the source
  workspace is safe: it adds a copy.
- Import always adds copies. There is no merge or update of records that came from an earlier
  import; doing that later needs a stored mapping from archive IDs to local IDs.
- Duplicate detection is exact but narrow: a new export of the same data has a new export ID and
  is not recognised as a duplicate.
- An archive that is inconsistent in any way is refused as a whole; there is no partial import.
- Validation reads the whole data file into memory (bounded at 256 MiB) and the import runs on the
  main process thread: about 8 seconds for 10,000 nodes on a developer machine, during which the
  window does not respond. A worker thread and progress reporting are follow-up work.
- `formatVersion` must be raised whenever the archive layout or data shape changes; older builds
  then refuse newer archives with an actionable message.
- Map viewports, placement coordinates, colors and collapse states, and graph positions are
  carried over as stored, so imported maps and the imported part of the graph look as they did
  in the source.

## Alternatives considered

- **Preserve archive IDs on import.** Makes re-import an update and keeps links stable across
  workspaces, but an archive could then collide with or overwrite existing records, and importing
  into the source workspace would conflict on every row. PRD §5.11 asks for new records with an
  ID mapping by default. Rejected.
- **Always create new tags and relationship types.** Simpler, but would fill the workspace with
  duplicate labels that the unique-label rules forbid anyway. Rejected in favour of merging by
  label, with direction as part of a type's identity.
- **Detect duplicates by content hash of the data.** Would recognise a re-export of unchanged
  data, but any edit, even to a timestamp, changes the hash, so it is no more reliable for real
  use. The export ID is exact for "this archive", which is what the PRD asks about. Rejected for
  now.
- **Import directly while reading the ZIP (single pass).** Faster and simpler, but cannot show a
  preview and would discover problems after writing. Rejected: PRD §5.11 requires validation
  before mutation.
- **SQLite database file as the archive.** Lossless, but exposes the storage schema as an
  interchange format, is harder to validate field by field, and is not readable outside mmap.
  Rejected; snapshots of the database file are the backup format instead
  ([ADR-0006](0006-backup-policy.md)).
- **One JSON file per entity or per node.** Easier to diff, but tens of thousands of small entries
  make the archive slower to write and read and raise the entry count that has to be bounded.
  Rejected in favour of one data document.
- **Trust the archive's file names and MIME types for attachments.** Would let an archive import
  an executable under an innocent name. Rejected; the policy runs on the bytes.
