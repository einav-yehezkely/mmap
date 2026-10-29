/**
 * Ordered list of all schema migrations shipped with this build.
 * Append new migrations at the end; never edit or reorder released ones (see `migration.ts`).
 */

import { initialSchemaMigration } from './0001-initial-schema';
import { noteSchemaV2MarkerMigration } from './0002-note-schema-v2-marker';
import { graphLayoutMigration } from './0003-graph-layout';
import { dropGraphViewStateMigration } from './0004-drop-graph-view-state';
import { timelineMilestonesLearnedAtMigration } from './0005-timeline-milestones-learned-at';
import { mapArrangementMigration } from './0006-map-arrangement';
import { mapRegionsMigration } from './0007-map-regions';
import type { Migration } from './migration';

export const ALL_MIGRATIONS: readonly Migration[] = [
  initialSchemaMigration,
  noteSchemaV2MarkerMigration,
  graphLayoutMigration,
  dropGraphViewStateMigration,
  timelineMilestonesLearnedAtMigration,
  mapArrangementMigration,
  mapRegionsMigration,
];

export const LATEST_SCHEMA_VERSION = ALL_MIGRATIONS.length;

export type { Migration } from './migration';
export * from './runner';
