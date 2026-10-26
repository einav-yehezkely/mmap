/**
 * Test helpers: real SQLite databases in a temporary directory (PRD §10.6 — test transactions,
 * FTS5, constraints and migrations with real temporary databases, not mocks).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../connection';
import { ALL_MIGRATIONS, migrateToLatest } from '../migrations';

export interface TemporaryDatabase {
  readonly database: DatabaseSync;
  readonly filePath: string;
  /** Closes the connection and deletes the temporary directory. Safe to call twice. */
  dispose(): void;
}

export function createTemporaryDatabaseFile(): { filePath: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'mmap-test-'));
  return { directory, filePath: join(directory, 'mmap.sqlite') };
}

export async function openMigratedTemporaryDatabase(): Promise<TemporaryDatabase> {
  const { directory, filePath } = createTemporaryDatabaseFile();
  const database = openDatabase(filePath);
  await migrateToLatest(database, ALL_MIGRATIONS, { now: () => FIXED_TIME });
  return {
    database,
    filePath,
    dispose: () => {
      if (database.isOpen) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const FIXED_TIME = '2026-10-26T12:00:00.000Z';

let idCounter = 0;

/** Deterministic, unique, canonical lowercase UUIDs for fixtures. */
export function nextTestId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`;
}

/** Minimal valid row builders. Each inserts one row and returns its ID. */
export const insert = {
  workspace(database: DatabaseSync, name = 'Test workspace'): string {
    const id = nextTestId();
    database
      .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name, FIXED_TIME, FIXED_TIME);
    return id;
  },

  node(
    database: DatabaseSync,
    workspaceId: string,
    fields: { title?: string; plainText?: string; summary?: string | null } = {},
  ): string {
    const id = nextTestId();
    database
      .prepare(
        `INSERT INTO knowledge_nodes
           (id, workspace_id, title, summary, note_json, note_schema_version, note_plain_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', 1, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        fields.title ?? 'Untitled',
        fields.summary ?? null,
        fields.plainText ?? '',
        FIXED_TIME,
        FIXED_TIME,
      );
    return id;
  },

  relationshipType(
    database: DatabaseSync,
    workspaceId: string,
    label: string,
    directionality: 'directed' | 'undirected',
  ): string {
    const id = nextTestId();
    database
      .prepare(
        `INSERT INTO relationship_types
           (id, workspace_id, label, normalized_label, directionality, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, label, label.toLowerCase(), directionality, FIXED_TIME, FIXED_TIME);
    return id;
  },

  relationship(
    database: DatabaseSync,
    fields: {
      workspaceId: string;
      sourceNodeId: string;
      targetNodeId: string;
      typeId: string;
      directionality: 'directed' | 'undirected';
    },
  ): string {
    const id = nextTestId();
    database
      .prepare(
        `INSERT INTO relationships
           (id, workspace_id, source_node_id, target_node_id, type_id, directionality, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.workspaceId,
        fields.sourceNodeId,
        fields.targetNodeId,
        fields.typeId,
        fields.directionality,
        FIXED_TIME,
        FIXED_TIME,
      );
    return id;
  },

  map(database: DatabaseSync, workspaceId: string, title = 'Map'): string {
    const id = nextTestId();
    database
      .prepare(
        `INSERT INTO mind_maps (id, workspace_id, title, mode, created_at, updated_at)
         VALUES (?, ?, ?, 'freeform', ?, ?)`,
      )
      .run(id, workspaceId, title, FIXED_TIME, FIXED_TIME);
    return id;
  },

  placement(
    database: DatabaseSync,
    fields: { workspaceId: string; mapId: string; nodeId: string; parentPlacementId?: string },
  ): string {
    const id = nextTestId();
    database
      .prepare(
        `INSERT INTO map_placements
           (id, workspace_id, map_id, node_id, parent_placement_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.workspaceId,
        fields.mapId,
        fields.nodeId,
        fields.parentPlacementId ?? null,
        FIXED_TIME,
        FIXED_TIME,
      );
    return id;
  },
};

/** Two nodes with lexicographically ordered IDs (`low` < `high`), for canonical-order tests. */
export function insertOrderedNodePair(
  database: DatabaseSync,
  workspaceId: string,
): { low: string; high: string } {
  const first = insert.node(database, workspaceId, { title: 'First' });
  const second = insert.node(database, workspaceId, { title: 'Second' });
  return first < second ? { low: first, high: second } : { low: second, high: first };
}

export function countRows(database: DatabaseSync, table: string): number {
  // `table` is always a literal from test code.
  const row = database.prepare(`SELECT count(*) AS total FROM ${table}`).get();
  return Number(row?.total);
}
