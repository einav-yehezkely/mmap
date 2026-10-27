/**
 * Migration 5 rebuilds \`timeline_events\` (new event type, learning date, milestone title). This
 * test upgrades a database at version 4 that already holds timeline history and checks that every
 * row survives unchanged, the new rules hold, and the indexes and workspace triggers exist again.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../connection';
import { ALL_MIGRATIONS, migrateToLatest } from './index';

const NOW = '2026-10-27T12:00:00.000Z';
const LATER = '2026-10-27T12:30:00.000Z';
const WORKSPACE = 'e5000000-0000-4000-8000-000000000001';
const OTHER_WORKSPACE = 'e5000000-0000-4000-8000-000000000002';
const NODE = 'e5000000-0000-4000-8000-000000000003';
const EVENT = 'e5000000-0000-4000-8000-000000000004';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-timeline-rebuild-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('migration 5: timeline rebuild', () => {
  it('keeps existing history and adds milestones and learning dates', async () => {
    const database = openDatabase(join(directory, 'mmap.sqlite'));
    try {
      await migrateToLatest(database, ALL_MIGRATIONS.slice(0, 4));
      for (const id of [WORKSPACE, OTHER_WORKSPACE]) {
        database
          .prepare(
            'INSERT INTO workspaces (id, name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(id, 'W', 'UTC', NOW, NOW);
      }
      database
        .prepare(
          `INSERT INTO knowledge_nodes (id, workspace_id, title, note_json, note_schema_version,
             note_plain_text, created_at, updated_at)
           VALUES (?, ?, 'Entropy', '{"type":"doc","content":[]}', 2, '', ?, ?)`,
        )
        .run(NODE, WORKSPACE, NOW, NOW);
      database
        .prepare(
          `INSERT INTO timeline_events (id, workspace_id, node_id, node_title_snapshot, event_type,
             occurred_at, last_activity_at, reflection, is_imported, import_origin)
           VALUES (?, ?, ?, 'Entropy', 'note_updated', ?, ?, 'kept', 0, NULL)`,
        )
        .run(EVENT, WORKSPACE, NODE, NOW, LATER);

      await migrateToLatest(database, ALL_MIGRATIONS);

      expect(
        database.prepare('SELECT * FROM timeline_events WHERE id = ?').get(EVENT),
      ).toMatchObject({
        node_id: NODE,
        event_type: 'note_updated',
        occurred_at: NOW,
        last_activity_at: LATER,
        reflection: 'kept',
        learned_at: null,
        title: null,
      });

      const insert = database.prepare(
        `INSERT INTO timeline_events (id, workspace_id, node_id, event_type, occurred_at,
           last_activity_at, learned_at, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'e5000000-0000-4000-8000-000000000005',
        WORKSPACE,
        null,
        'milestone',
        NOW,
        NOW,
        '2026-09-01T09:00:00.000Z',
        'Finished the thermodynamics course',
      );
      // A milestone needs a title; other events must not have one.
      expect(() =>
        insert.run(
          'e5000000-0000-4000-8000-000000000006',
          WORKSPACE,
          null,
          'milestone',
          NOW,
          NOW,
          null,
          '  ',
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          'e5000000-0000-4000-8000-000000000007',
          WORKSPACE,
          NODE,
          'reviewed',
          NOW,
          NOW,
          null,
          'x',
        ),
      ).toThrow();
      // The learning date is a fixed-width UTC timestamp like every other.
      expect(() =>
        insert.run(
          'e5000000-0000-4000-8000-000000000008',
          WORKSPACE,
          NODE,
          'reviewed',
          NOW,
          NOW,
          '2026-09-01',
          null,
        ),
      ).toThrow();
      // The workspace trigger was recreated: a node of another workspace is refused.
      expect(() =>
        insert.run(
          'e5000000-0000-4000-8000-000000000009',
          OTHER_WORKSPACE,
          NODE,
          'reviewed',
          NOW,
          NOW,
          null,
          null,
        ),
      ).toThrow(/workspace mismatch/u);

      const indexes = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'timeline_events'",
        )
        .all()
        .map((row) => String(row.name));
      expect(indexes).toEqual(
        expect.arrayContaining([
          'timeline_events_by_time',
          'timeline_events_by_node',
          'timeline_events_by_type',
          'timeline_events_by_effective_time',
        ]),
      );
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
