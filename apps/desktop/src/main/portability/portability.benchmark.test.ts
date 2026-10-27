/**
 * Backup, restore, export and import timings on the PRD §9 validation dataset: 10,000 nodes,
 * 30,000 relationships, 100 maps (the largest with 500 placements), plus timeline events and 50
 * attachments of 200 KB. PRD §9: "Restore works offline, with a 15-minute target for the
 * validation dataset and recorded measured results" (results: docs/testing.md).
 *
 * Skipped in normal test runs because building the dataset takes a while. Run with:
 *   MMAP_BENCHMARK=1 npx vitest run --project desktop portability.benchmark --silent=false
 *
 * The dataset is written with bulk SQL inside the open workspace (the services would take far
 * longer for 40,000 records); the timed operations use the real backup, restore, export and
 * import code.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { UtcTimestamp } from '@mmap/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BackupService } from '../backups/backup-service';
import { createFileSettingsStore } from '../workspaces/app-settings';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { exportWorkspaceArchive } from './export-workspace';
import { applyImport, prepareImport } from './import-workspace';

const NODES = 10_000;
const RELATIONSHIPS = 30_000;
const MAPS = 100;
const ATTACHMENTS = 50;
const ATTACHMENT_BYTES = 200 * 1024;
const RESTORE_TARGET_MS = 15 * 60 * 1_000;
const T = '2026-10-27T09:00:00.000Z';

const report = (line: string): void => void process.stdout.write(`      ${line}\n`);

/** Deterministic pseudo-random numbers, so every run measures the same data. */
function createRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const WORDS =
  'energy entropy heat work system state process cycle engine temperature pressure volume ' +
  'particle wave field force motion mass charge current circuit signal model theory law proof';

function uuid(prefix: number, index: number): string {
  return `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function startApp(sandbox: string, profile: string) {
  const userData = join(sandbox, profile);
  mkdirSync(userData, { recursive: true });
  const settings = createFileSettingsStore(userData);
  const manager = new WorkspaceManager({
    settings,
    defaultWorkspacesRoot: join(userData, 'workspaces'),
    appVersion: 'benchmark',
    timezone: () => 'UTC',
    clock: { now: () => new Date().toISOString() as UtcTimestamp },
    ids: { newId: () => crypto.randomUUID() },
    lockEnvironment: {
      pid: process.pid,
      hostname: 'benchmark',
      instanceId: crypto.randomUUID(),
      now: () => new Date(),
      isProcessAlive: () => true,
    },
    trashFolder: (folder) => {
      rmSync(folder, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
  const backups = new BackupService({
    workspaces: manager,
    settings,
    defaultDestination: join(userData, 'backups'),
    appVersion: 'benchmark',
  });
  return { manager, backups };
}

async function buildDataset(workspace: OpenWorkspace, sandbox: string): Promise<void> {
  const random = createRandom(7);
  const words = WORDS.split(' ');
  const text = (count: number) =>
    Array.from({ length: count }, () => words[Math.floor(random() * words.length)]!).join(' ');
  const nodeIds = Array.from({ length: NODES }, (_, index) => uuid(0xa, index + 1));

  // Attachment files go through the real store, so they exist with their checksums.
  const stored: { nodeId: string; path: string; sha: string; size: number }[] = [];
  for (let index = 0; index < ATTACHMENTS; index += 1) {
    const source = join(sandbox, `attachment-${index}.pdf`);
    const bytes = Buffer.alloc(ATTACHMENT_BYTES, index);
    Buffer.from('%PDF-1.7\n').copy(bytes);
    writeFileSync(source, bytes);
    const file = await workspace.attachmentStore.importFile(source, 'pdf', ATTACHMENT_BYTES);
    stored.push({
      nodeId: nodeIds[index]!,
      path: file.relativePath,
      sha: file.sha256,
      size: file.byteSize,
    });
  }

  await workspace.connections.runInTransaction(async () => {
    const database = workspace.connections.forWrite();
    const id = workspace.id;
    const insertNode = database.prepare(
      `INSERT INTO knowledge_nodes (id, workspace_id, title, summary, note_json, note_schema_version,
         note_plain_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 2, ?, ?, ?)`,
    );
    const insertEvent = database.prepare(
      `INSERT INTO timeline_events (id, workspace_id, node_id, node_title_snapshot, event_type,
         occurred_at, last_activity_at) VALUES (?, ?, ?, ?, 'node_created', ?, ?)`,
    );
    for (const [index, nodeId] of nodeIds.entries()) {
      const title = `${text(3)} ${index}`;
      const body = text(80);
      const target = nodeIds[Math.floor(random() * NODES)]!;
      const note = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: body }] },
          {
            type: 'paragraph',
            content: [{ type: 'wikilink', attrs: { targetNodeId: target, label: 'see also' } }],
          },
        ],
      };
      insertNode.run(nodeId, id, title, JSON.stringify(note), `${body} see also`, T, T);
      insertEvent.run(uuid(0xe, index + 1), id, nodeId, title, T, T);
    }

    const types = database
      .prepare('SELECT id, directionality FROM relationship_types WHERE workspace_id = ?')
      .all(id);
    const insertRelationship = database.prepare(
      `INSERT OR IGNORE INTO relationships (id, workspace_id, source_node_id, target_node_id,
         type_id, directionality, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < RELATIONSHIPS; index += 1) {
      const type = types[index % types.length]!;
      let source = nodeIds[Math.floor(random() * NODES)]!;
      let target = nodeIds[Math.floor(random() * NODES)]!;
      if (source === target) continue;
      if (type.directionality === 'undirected' && source > target)
        [source, target] = [target, source];
      insertRelationship.run(
        uuid(0xb, index + 1),
        id,
        source,
        target,
        String(type.id),
        String(type.directionality),
        T,
        T,
      );
    }

    const insertMap = database.prepare(
      `INSERT INTO mind_maps (id, workspace_id, title, mode, created_at, updated_at)
       VALUES (?, ?, ?, 'hierarchical', ?, ?)`,
    );
    const insertPlacement = database.prepare(
      `INSERT INTO map_placements (id, workspace_id, map_id, node_id, freeform_x, freeform_y,
         parent_placement_id, sibling_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let placementCounter = 0;
    for (let map = 0; map < MAPS; map += 1) {
      const mapId = uuid(0xf, map + 1);
      insertMap.run(mapId, id, `Map ${map + 1}`, T, T);
      const count = map === 0 ? 500 : 50;
      const placed: string[] = [];
      for (let item = 0; item < count; item += 1) {
        const placementId = uuid(0xc, ++placementCounter);
        const parent = item === 0 ? null : placed[Math.floor(item / 4)]!;
        insertPlacement.run(
          placementId,
          id,
          mapId,
          nodeIds[(map * 97 + item) % NODES]!,
          item * 10,
          item * 5,
          parent,
          item,
          T,
          T,
        );
        placed.push(placementId);
      }
    }

    const insertAttachment = database.prepare(
      `INSERT INTO attachments (id, workspace_id, node_id, relative_path, original_name, mime_type,
         byte_size, sha256, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, 'committed', ?, ?)`,
    );
    for (const [index, file] of stored.entries()) {
      insertAttachment.run(
        uuid(0xd, index + 1),
        id,
        file.nodeId,
        file.path,
        `paper-${index}.pdf`,
        file.size,
        file.sha,
        T,
        T,
      );
    }
  });
}

describe.skipIf(process.env.MMAP_BENCHMARK !== '1')(
  'portability benchmark (PRD §9 dataset)',
  () => {
    let sandbox: string;
    let source: ReturnType<typeof startApp>;

    beforeAll(async () => {
      sandbox = mkdtempSync(join(tmpdir(), 'mmap-portability-benchmark-'));
      source = startApp(sandbox, 'source');
      await source.manager.startup();
      await source.backups.idle();
      const start = performance.now();
      await buildDataset(source.manager.current!, sandbox);
      report(`Dataset built in ${((performance.now() - start) / 1000).toFixed(1)} s`);
    }, 600_000);

    afterAll(async () => {
      await source.backups.idle();
      await source.manager.close();
      rmSync(sandbox, { recursive: true, force: true });
    });

    it(
      'backs up and restores the validation dataset well within 15 minutes',
      async () => {
        let start = performance.now();
        const status = await source.backups.backUpNow();
        const backupMs = performance.now() - start;
        expect(status.lastFailure).toBeNull();
        report(`Backup: ${(backupMs / 1000).toFixed(1)} s`);

        start = performance.now();
        await source.backups.restoreSnapshot(status.snapshots[0]!.id);
        const restoreMs = performance.now() - start;
        report(`Restore (includes a safety backup first): ${(restoreMs / 1000).toFixed(1)} s`);
        const restored = source.manager.current!;
        const snapshot = await restored.services.snapshots.read(restored.id);
        expect(snapshot.nodes).toHaveLength(NODES);
        expect(snapshot.attachments).toHaveLength(ATTACHMENTS);
        expect(restoreMs).toBeLessThan(RESTORE_TARGET_MS);
      },
      RESTORE_TARGET_MS,
    );

    it(
      'exports and imports the validation dataset',
      async () => {
        const archive = join(sandbox, 'dataset.mmap.zip');
        let start = performance.now();
        const exported = await exportWorkspaceArchive(source.manager.current!, archive, {
          appVersion: 'benchmark',
          now: () => new Date(),
        });
        report(`ZIP export: ${((performance.now() - start) / 1000).toFixed(1)} s`);
        expect(exported.counts.nodes).toBe(NODES);

        const destination = startApp(sandbox, 'destination');
        await destination.manager.startup();
        await destination.backups.idle();
        try {
          start = performance.now();
          const prepared = await prepareImport(destination.manager.current!, archive, {
            ids: { newId: () => crypto.randomUUID() },
            maxAttachmentBytes: ATTACHMENT_BYTES,
          });
          const previewMs = performance.now() - start;
          start = performance.now();
          await applyImport(destination.manager.current!, prepared);
          report(
            `ZIP import: preview ${(previewMs / 1000).toFixed(1)} s, apply ${((performance.now() - start) / 1000).toFixed(1)} s`,
          );
          const imported = destination.manager.current!;
          expect((await imported.services.snapshots.read(imported.id)).nodes).toHaveLength(NODES);
        } finally {
          await destination.backups.idle();
          await destination.manager.close();
        }
      },
      RESTORE_TARGET_MS,
    );
  },
);
