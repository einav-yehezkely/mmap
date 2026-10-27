/**
 * Creating a node with "Add to Mind Maps": one canonical node, placed on every chosen map at a
 * free spot (under a chosen parent in hierarchical maps), all or nothing.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createFileSettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { createMapIpcServices } from './map-ipc-services';
import { createNodeIpcServices } from './node-ipc-services';

let sandbox: string;
let manager: WorkspaceManager;

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-node-maps-'));
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

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < 210 && Math.abs(a.y - b.y) < 70;

it('creates one node on several maps, at free spots and under a chosen parent', async () => {
  const nodes = createNodeIpcServices(manager);
  const maps = createMapIpcServices(manager);
  let freeform = await maps['maps:create']({ title: 'Ideas' });
  for (const [index, title] of ['A', 'B', 'C'].entries()) {
    freeform = await maps['maps:add-placement']({
      mapId: freeform.map.id,
      expectedRevision: freeform.map.revision,
      newNodeTitle: title,
      x: index * 220,
      y: 0,
    });
  }
  let tree = await maps['maps:create']({ title: 'Outline', mode: 'hierarchical' });
  tree = await maps['maps:add-placement']({
    mapId: tree.map.id,
    expectedRevision: tree.map.revision,
    newNodeTitle: 'Root',
    x: 0,
    y: 0,
  });
  const root = tree.placements[0]!;

  const node = await nodes['nodes:create']({
    title: 'New idea',
    addToMaps: [
      { mapId: freeform.map.id, parentPlacementId: null },
      { mapId: tree.map.id, parentPlacementId: root.id },
    ],
  });

  const ideas = await maps['maps:get']({ mapId: freeform.map.id });
  const added = ideas.placements.find((placement) => placement.nodeId === node.id)!;
  expect(added).toBeDefined();
  expect(
    ideas.placements
      .filter((placement) => placement.id !== added.id)
      .some((other) => overlaps(other, added)),
  ).toBe(false);
  const outline = await maps['maps:get']({ mapId: tree.map.id });
  expect(
    outline.placements.find((placement) => placement.nodeId === node.id)?.parentPlacementId,
  ).toBe(root.id);
  // One canonical node, not one per map.
  const titles = (await nodes['nodes:list']({ sort: 'title-asc', limit: 50 })).items.map(
    (item) => item.title,
  );
  expect(titles.filter((title) => title === 'New idea')).toHaveLength(1);
});

it('creates nothing when a placement is rejected', async () => {
  const nodes = createNodeIpcServices(manager);
  const maps = createMapIpcServices(manager);
  const tree = await maps['maps:create']({ title: 'Outline', mode: 'hierarchical' });
  await expect(
    nodes['nodes:create']({
      title: 'Orphan',
      addToMaps: [{ mapId: tree.map.id, parentPlacementId: crypto.randomUUID() }],
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const titles = (await nodes['nodes:list']({ sort: 'title-asc', limit: 50 })).items.map(
    (item) => item.title,
  );
  expect(titles).not.toContain('Orphan');
  expect((await maps['maps:get']({ mapId: tree.map.id })).placements).toEqual([]);
});

it('adds an existing node to more maps from the node panel, all or nothing', async () => {
  const nodes = createNodeIpcServices(manager);
  const maps = createMapIpcServices(manager);
  const node = await nodes['nodes:create']({ title: 'Existing idea' });
  const first = await maps['maps:create']({ title: 'Alpha' });
  let tree = await maps['maps:create']({ title: 'Beta', mode: 'hierarchical' });
  tree = await maps['maps:add-placement']({
    mapId: tree.map.id,
    expectedRevision: tree.map.revision,
    newNodeTitle: 'Root',
    x: 0,
    y: 0,
  });
  const root = tree.placements[0]!;
  expect((await maps['maps:list-for-node']({ nodeId: node.id })).items).toEqual([]);

  const result = await maps['maps:add-node']({
    nodeId: node.id,
    targets: [
      { mapId: first.map.id, parentPlacementId: null },
      { mapId: tree.map.id, parentPlacementId: root.id },
    ],
  });
  expect(result.items.map((map) => map.title)).toEqual(['Alpha', 'Beta']);
  const beta = await maps['maps:get']({ mapId: tree.map.id });
  expect(beta.placements.find((placement) => placement.nodeId === node.id)?.parentPlacementId).toBe(
    root.id,
  );

  // Adding to a map that already shows the node changes nothing there.
  await maps['maps:add-node']({
    nodeId: node.id,
    targets: [{ mapId: first.map.id, parentPlacementId: null }],
  });
  expect((await maps['maps:get']({ mapId: first.map.id })).placements).toHaveLength(1);

  // A map that already shows the node is skipped, even with a parent that no longer exists.
  const gamma = await maps['maps:create']({ title: 'Gamma', mode: 'hierarchical' });
  await expect(
    maps['maps:add-node']({
      nodeId: node.id,
      targets: [
        { mapId: gamma.map.id, parentPlacementId: null },
        { mapId: tree.map.id, parentPlacementId: crypto.randomUUID() },
      ],
    }),
  ).resolves.toBeDefined();
  expect(
    (await maps['maps:list-for-node']({ nodeId: node.id })).items.map((map) => map.title),
  ).toEqual(['Alpha', 'Beta', 'Gamma']);
  // A rejected target leaves every map unchanged.
  const delta = await maps['maps:create']({ title: 'Delta', mode: 'hierarchical' });
  const epsilon = await maps['maps:create']({ title: 'Epsilon' });
  await expect(
    maps['maps:add-node']({
      nodeId: node.id,
      targets: [
        { mapId: epsilon.map.id, parentPlacementId: null },
        { mapId: delta.map.id, parentPlacementId: crypto.randomUUID() },
      ],
    }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await maps['maps:get']({ mapId: epsilon.map.id })).placements).toEqual([]);
});
