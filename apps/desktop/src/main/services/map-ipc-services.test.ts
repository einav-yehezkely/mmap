/**
 * Map channel handlers against a real workspace (folder, SQLite). Responses are also checked
 * against the strict response schemas, so internal fields (workspace IDs, timestamps the renderer
 * does not use) can never leak into the renderer.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IPC_CATALOGUE } from '@mmap/contracts';
import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { createMapIpcServices } from './map-ipc-services';
import { createNodeIpcServices } from './node-ipc-services';

let sandbox: string;
let manager: WorkspaceManager;

function services() {
  return { ...createNodeIpcServices(manager), ...createMapIpcServices(manager) };
}

beforeEach(async () => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'mmap-map-ipc-')));
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

describe('map channels', () => {
  it('runs a map through creation, editing, hierarchy and deletion', async () => {
    const ipc = services();
    const existing = await ipc['nodes:create']({ title: 'Existing' });
    let view = await ipc['maps:create']({ title: 'Study plan' });
    view = await ipc['maps:add-placement']({
      mapId: view.map.id,
      expectedRevision: view.map.revision,
      nodeId: existing.id,
      x: 10,
      y: 20,
    });
    view = await ipc['maps:add-placement']({
      mapId: view.map.id,
      expectedRevision: view.map.revision,
      newNodeTitle: 'Created on the map',
      x: 300,
      y: 20,
    });
    const [first, second] = view.placements;
    view = await ipc['maps:add-connection']({
      mapId: view.map.id,
      expectedRevision: view.map.revision,
      sourcePlacementId: first!.id,
      targetPlacementId: second!.id,
      label: 'leads to',
    });
    expect(IPC_CATALOGUE['maps:add-connection'].response.safeParse(view).success).toBe(true);

    const proposal = await ipc['maps:propose-hierarchy']({ mapId: view.map.id });
    expect(proposal.ambiguous).toEqual([]);
    view = await ipc['maps:switch-mode']({
      mapId: view.map.id,
      expectedRevision: view.map.revision,
      mode: 'hierarchical',
      parents: [...proposal.parents],
    });
    expect(view.map.mode).toBe('hierarchical');
    expect(view.placements.find((p) => p.id === second!.id)?.parentPlacementId).toBe(first!.id);

    await expect(
      ipc['maps:reparent']({
        mapId: view.map.id,
        expectedRevision: view.map.revision,
        placementId: first!.id,
        parentPlacementId: second!.id,
        index: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });

    await ipc['maps:set-viewport']({ mapId: view.map.id, viewport: { x: 5, y: 6, zoom: 2 } });
    const listed = await ipc['maps:list'](undefined);
    expect(IPC_CATALOGUE['maps:list'].response.safeParse(listed).success).toBe(true);
    expect(listed.items).toMatchObject([{ title: 'Study plan', placementCount: 2 }]);

    await ipc['maps:delete']({ mapId: view.map.id });
    const nodes = await ipc['nodes:list']({ sort: 'title-asc', limit: 10 });
    expect(nodes.items.map((node) => node.title)).toEqual(['Created on the map', 'Existing']);
  });

  it('rejects stale revisions with REVISION_CONFLICT', async () => {
    const ipc = services();
    const view = await ipc['maps:create']({ title: 'Map' });
    await ipc['maps:rename']({ mapId: view.map.id, expectedRevision: 1, title: 'Renamed' });

    await expect(
      ipc['maps:rename']({ mapId: view.map.id, expectedRevision: 1, title: 'Stale' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('reports unknown maps as not found', async () => {
    const ipc = services();
    await expect(
      ipc['maps:get']({ mapId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
