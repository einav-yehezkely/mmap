# ADR-0008: Wikilinks and note schema version 2

- Status: Accepted
- Date: 2026-10-27

## Context

PRD §4.3 and §5.4 require `[[wikilinks]]` inside notes: typing `[[` opens a node picker, links
keep working after the target is renamed (PRD §4.1), backlinks show the source title and an
excerpt, removed links disappear from backlinks after save, and deleted targets appear as
unresolved links with a repair action. A wikilink is a note reference, not a semantic
relationship, and must never create one silently (PRD §4.3, §14). PRD §14 also names
"editor/reference divergence" as a risk: references must be reconciled in the same database
transaction as the note.

Phase 1 stored notes as validated Tiptap JSON with `note_schema_version` 1
(`packages/domain/src/notes/note-document.ts`). Its parser rejects unknown node types, so a Phase 1
build cannot read a note that contains a wikilink. Migration 1 already created the
`note_references` table, so no table change is needed. Without a further step, a Phase 1 build
would open a workspace written by Phase 2 and then fail on individual notes.

## Decision

1. **ID-based identity.** A wikilink is an inline leaf node
   `{ type: 'wikilink', attrs: { targetNodeId, label } }`. `targetNodeId` (a canonical lowercase
   UUID) is the identity; the title is never used to find the target.
2. **Label preserved.** `label` (1 to 300 characters, no control characters) is the text the
   author sees. The editor sets it to the target's title when the link is inserted. Renaming the
   target does not change it, and repairing a link changes only the target. Any other attribute,
   such as a cached title, is dropped by the parser.
3. **References derived per save.** The note JSON is the source of truth. On every note write
   (create, duplicate, and update with a note), `KnowledgeNodeService` extracts one reference per
   occurrence (`extractNoteReferences`, with ordinal, label and an excerpt of about 160
   characters) and replaces all `note_references` rows of the source node in the same write
   transaction.
4. **Unresolved links are retained.** Only references whose target exists in the workspace are
   stored (`INSERT … WHERE EXISTS`). Deleting a target cascades its reference rows, but the
   wikilink stays in the source note. The editor asks `nodes:resolve-links` which targets exist
   and marks the others as unresolved, with a repair action that re-targets the link.
5. **No implicit relationships.** Nothing in the wikilink path writes `relationships`. Tests
   assert this.
6. **Schema version 2 plus a database marker.** `NOTE_SCHEMA_VERSION` becomes 2. Every version-1
   document is a valid version-2 document, so old notes are read unchanged. Migration 2
   (`packages/storage-sqlite/src/migrations/0002-note-schema-v2-marker.ts`, SQL `SELECT 1;`)
   changes no table but raises the database version to 2. A Phase 1 build then refuses the
   workspace as a whole with `WORKSPACE_TOO_NEW` ([ADR-0007](0007-database-migrations-strategy.md),
   "refuse newer") instead of failing later on notes. The usual verified pre-migration backup is
   taken first ([ADR-0006](0006-backup-policy.md)).

## Consequences

- Renaming a node never breaks links, and two nodes with the same title are never confused,
  because a link is always created by picking one node.
- Backlinks always match the last saved notes; there is no background job to fall behind.
- A workspace opened once by a Phase 2 build can no longer be opened by a Phase 1 build. The
  pre-migration backup in `recovery/` is the way back.
- Every note save rewrites that note's reference rows. This is proportional to the number of
  links in one note and runs inside the existing transaction.
- Links to deleted nodes have no database row, so they are found only by reading notes. The
  editor resolves them on load; a workspace-wide list of unresolved links would need a scan of
  note JSON.
- The editor offers no way to choose a label other than the title yet (`[[target|label]]`
  behaviour is supported by the data, not by the UI).
- Import of raw or Markdown text (Phase 5) has to map `[[Title]]` text to IDs and must ask the
  user when a title is ambiguous (PRD §5.4); this ADR does not decide how.

## Alternatives considered

- **Title-based links** (`[[Title]]` resolved by title on read). Simple and close to Markdown,
  but renaming the target breaks the link, repeated titles make it ambiguous, and the PRD
  forbids relying on title matching for identity. Rejected.
- **Storing references only in `note_references`**, with the note holding plain text. The note
  would no longer be self-contained: export, undo and copy and paste would have to reattach
  links, and the two stores could diverge. Keeping the link in the note JSON and deriving the rows
  makes the note the single source of truth. Rejected.
- **Creating relationships from links.** It would make every link a typed semantic statement
  the user never made, mixing two concepts the PRD keeps apart (§4.3, §14). Rejected.
- **No database version change.** Phase 1 builds would open the workspace and fail note by note.
  Refusing up front is clearer and safer. Rejected.
