/**
 * Phase 2 channel handlers against a real workspace (folder, SQLite, FTS5): relationships,
 * relationship types, title lookup, backlinks, link resolution and search.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { createNodeIpcServices } from './node-ipc-services';
import { createRelationshipIpcServices } from './relationship-ipc-services';

let sandbox: string;
let manager: WorkspaceManager;

function services() {
  return { ...createNodeIpcServices(manager), ...createRelationshipIpcServices(manager) };
}

beforeEach(async () => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'mmap-phase2-ipc-')));
  mkdirSync(join(sandbox, 'userData'));
  manager = new WorkspaceManager({
    settings: createFileSettingsStore(join(sandbox, 'userData')),
    defaultWorkspacesRoot: join(sandbox, 'userData', 'workspaces'),
    appVersion: 'test',
    timezone: () => 'UTC',
    clock: { now: () => new Date().toISOString() as UtcTimestamp },
    ids: { newId: () => crypto.randomUUID() },
    lockEnvironment: {
      pid: process.pid,
      hostname: 'test',
      instanceId: crypto.randomUUID(),
      now: () => new Date(),
      isProcessAlive: () => true,
    },
    trashFolder: () => Promise.reject(new Error('Not used in this test.')),
  });
  await manager.startup();
});

afterEach(async () => {
  await manager.close();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('Phase 2 channels', () => {
  it('runs the relationship flow end to end', async () => {
    const ipc = services();
    const a = await ipc['nodes:create']({ title: 'Alpha' });
    const b = await ipc['nodes:create']({ title: 'Beta' });
    const { items: types } = await ipc['relationship-types:list'](undefined);
    const dependsOn = types.find((type) => type.label === 'depends on')!;

    const created = await ipc['relationships:create']({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      typeId: dependsOn.id,
      description: '  why  ',
    });
    const reversed = await ipc['relationships:update']({
      relationshipId: created.id,
      changes: { reverseDirection: true, description: null },
    });

    expect(created).toMatchObject({ description: 'why', source: { id: a.id } });
    expect(reversed).toMatchObject({
      description: null,
      source: { id: b.id },
      target: { id: a.id },
    });
    await expect(ipc['relationships:list-for-node']({ nodeId: a.id })).resolves.toMatchObject({
      items: [{ id: created.id }],
    });
    await expect(
      ipc['relationship-types:set-directionality']({
        typeId: dependsOn.id,
        directionality: 'undirected',
      }),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
    await ipc['relationships:delete']({ relationshipId: created.id });
    await expect(ipc['relationships:list-for-node']({ nodeId: a.id })).resolves.toEqual({
      items: [],
    });
  });

  it('looks up titles, resolves links, lists backlinks and searches', async () => {
    const ipc = services();
    const target = await ipc['nodes:create']({ title: 'Photosynthesis' });
    const source = await ipc['nodes:create']({ title: 'Plants' });
    await ipc['nodes:update']({
      nodeId: source.id,
      expectedRevision: source.revision,
      changes: {
        note: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Chlorophyll drives ' },
                { type: 'wikilink', attrs: { targetNodeId: target.id, label: 'it' } },
              ],
            },
          ],
        },
      },
    });

    await expect(ipc['nodes:lookup']({ text: 'photo' })).resolves.toEqual({
      items: [{ id: target.id, title: 'Photosynthesis' }],
    });
    await expect(
      ipc['nodes:lookup']({ text: 'photo', excludeNodeIds: [target.id] }),
    ).resolves.toEqual({ items: [] });
    await expect(ipc['nodes:backlinks']({ nodeId: target.id })).resolves.toMatchObject({
      items: [{ sourceNodeId: source.id, label: 'it' }],
    });
    await expect(
      ipc['nodes:resolve-links']({ nodeIds: [target.id, '00000000-0000-4000-8000-000000000000'] }),
    ).resolves.toEqual({ items: [{ id: target.id, title: 'Photosynthesis' }] });
    const results = await ipc['search:query']({ text: 'chlorophyll', limit: 10 });
    expect(results).toMatchObject({ totalCount: 1, items: [{ nodeId: source.id }] });
    expect(results.items[0]?.snippet.some((segment) => segment.isMatch)).toBe(true);
  });

  it('reports archived types as a validation error, not an internal failure', async () => {
    const ipc = services();
    const a = await ipc['nodes:create']({ title: 'A' });
    const b = await ipc['nodes:create']({ title: 'B' });
    const custom = await ipc['relationship-types:create']({
      label: 'cites',
      directionality: 'directed',
    });
    await ipc['relationship-types:set-archived']({ typeId: custom.id, archived: true });

    await expect(
      ipc['relationships:create']({ sourceNodeId: a.id, targetNodeId: b.id, typeId: custom.id }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
