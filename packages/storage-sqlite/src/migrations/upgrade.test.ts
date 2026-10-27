/**
 * Upgrading a real Phase 1 database (schema version 1) with the current build: a verified backup
 * is taken first, the version is raised, all data stays intact, and an older build would now
 * refuse the file (PRD §9).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, readPragmaNumber } from '../connection';
import { openWorkspaceDatabase } from '../workspace-database';
import { ALL_MIGRATIONS, migrateToLatest, SchemaTooNewError } from './index';

const NOW = '2026-10-26T12:00:00.000Z';
const WORKSPACE = 'e0000000-0000-4000-8000-000000000001';
const NODE = 'e0000000-0000-4000-8000-000000000002';

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-upgrade-'));
  databasePath = join(directory, 'mmap.sqlite');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Creates a database exactly as a Phase 1 build would: migration 1 only, with one node. */
async function createPhase1Database(): Promise<void> {
  const database = openDatabase(databasePath);
  await migrateToLatest(database, ALL_MIGRATIONS.slice(0, 1));
  database
    .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(WORKSPACE, 'Phase 1 workspace', NOW, NOW);
  database
    .prepare(
      `INSERT INTO knowledge_nodes (id, workspace_id, title, note_json, note_schema_version,
         note_plain_text, created_at, updated_at)
       VALUES (?, ?, 'Written in Phase 1', '{"type":"doc","content":[]}', 1, '', ?, ?)`,
    )
    .run(NODE, WORKSPACE, NOW, NOW);
  database.close();
}

describe('upgrading a Phase 1 database', () => {
  it('backs up, migrates to the current version and keeps the data', async () => {
    await createPhase1Database();

    const opened = await openWorkspaceDatabase(databasePath, { backupDirectory: directory });
    try {
      expect(opened.migrationPlan).toMatchObject({
        currentVersion: 1,
        targetVersion: ALL_MIGRATIONS.length,
      });
      expect(opened.preMigrationBackupPath).not.toBeNull();
      expect(
        opened.connections.forRead().prepare('SELECT title FROM knowledge_nodes').get()?.title,
      ).toBe('Written in Phase 1');
    } finally {
      await opened.connections.close();
    }

    const backup = openDatabase(opened.preMigrationBackupPath ?? '', { readOnly: true });
    expect(readPragmaNumber(backup, 'user_version')).toBe(1);
    backup.close();
  });

  it('is refused by a Phase 1 build afterwards instead of being misread', async () => {
    await createPhase1Database();
    const opened = await openWorkspaceDatabase(databasePath, { backupDirectory: directory });
    await opened.connections.close();

    const database = openDatabase(databasePath);
    try {
      await expect(migrateToLatest(database, ALL_MIGRATIONS.slice(0, 1))).rejects.toBeInstanceOf(
        SchemaTooNewError,
      );
    } finally {
      database.close();
    }
  });
});
