/**
 * Migration 2 — compatibility marker for note schema version 2 (wikilinks, PRD §5.4).
 *
 * No table changes are needed: wikilinks live in the note JSON and their derived references use
 * the `note_references` table created by migration 1. The migration exists to raise the database
 * schema version. Builds that only know note schema version 1 (Phase 1) cannot parse notes that
 * contain wikilinks; with this version raised they refuse the whole workspace up front with
 * "created by a newer version of mmap" (see `SchemaTooNewError`) instead of failing later on
 * individual notes. As with every migration, a verified backup is taken before it runs on an
 * existing workspace.
 */

import type { Migration } from './migration';

export const noteSchemaV2MarkerMigration: Migration = {
  version: 2,
  name: 'note-schema-v2-marker',
  sql: 'SELECT 1;',
};
