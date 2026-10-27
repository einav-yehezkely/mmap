/**
 * Graph, timeline and timezone channel handlers against a real workspace. Responses are checked
 * against the strict response schemas, so internal fields never reach the renderer.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IPC_CATALOGUE } from '@mmap/contracts';
import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { createGraphTimelineIpcServices } from './graph-timeline-ipc-services';
import { createNodeIpcServices } from './node-ipc-services';
import { createRelationshipIpcServices } from './relationship-ipc-services';
import { createWorkspaceIpcServices } from './workspace-ipc-services';

let sandbox: string;
let manager: WorkspaceManager;

function services() {
  return {
    ...createNodeIpcServices(manager),
    ...createRelationshipIpcServices(manager),
    ...createGraphTimelineIpcServices(manager),
  };
}

beforeEach(async () => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'mmap-graph-ipc-')));
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

describe('graph channels', () => {
  it('returns a bounded overview and a neighborhood with strict DTOs', async () => {
    const ipc = services();
    const a = await ipc['nodes:create']({ title: 'Alpha' });
    const b = await ipc['nodes:create']({ title: 'Beta' });
    await ipc['nodes:create']({ title: 'Gamma' });
    const { items: types } = await ipc['relationship-types:list'](undefined);
    await ipc['relationships:create']({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      typeId: types.find((type) => type.label === 'depends on')!.id,
    });

    const overview = await ipc['graph:overview']({ maxNodes: 2 });
    expect(IPC_CATALOGUE['graph:overview'].response.safeParse(overview).success).toBe(true);
    expect(overview).toMatchObject({ totalNodes: 3, edgesTruncated: false });
    expect(overview.nodes.map((node) => node.title)).toEqual(['Alpha', 'Beta']);

    const neighborhood = await ipc['graph:neighborhood']({ nodeId: b.id });
    expect(neighborhood.nodes.map((node) => node.id)).toEqual([b.id, a.id]);
    await expect(
      ipc['graph:neighborhood']({ nodeId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('timeline channels', () => {
  it('lists activity, records and edits reviews, and refuses to change recorded activity', async () => {
    const ipc = services();
    const node = await ipc['nodes:create']({ title: 'Entropy' });
    const review = await ipc['timeline:mark-reviewed']({
      nodeId: node.id,
      reflection: 'Clear now.',
    });
    expect(IPC_CATALOGUE['timeline:mark-reviewed'].response.safeParse(review).success).toBe(true);
    expect(review).toMatchObject({ eventType: 'reviewed', nodeTitle: 'Entropy' });

    const listed = await ipc['timeline:list']({ limit: 10 });
    expect(IPC_CATALOGUE['timeline:list'].response.safeParse(listed).success).toBe(true);
    expect(listed.items.map((item) => item.eventType)).toEqual(['reviewed', 'node_created']);

    await ipc['timeline:update-reflection']({ eventId: review.id, reflection: null });
    const created = listed.items[1]!;
    await expect(ipc['timeline:delete-reviewed']({ eventId: created.id })).rejects.toMatchObject({
      code: 'INVARIANT_VIOLATION',
    });
    await ipc['timeline:delete-reviewed']({ eventId: review.id });
    expect((await ipc['timeline:list']({ limit: 10 })).items).toHaveLength(1);
  });

  it('filters days in the timezone chosen in settings', async () => {
    const ipc = services();
    // This channel never opens native dialogs, so none are provided.
    const workspace = createWorkspaceIpcServices(manager, {} as never);
    await ipc['nodes:create']({ title: 'Today' });
    const state = await workspace['workspace:set-timezone']({ timezone: 'Pacific/Kiritimati' });
    expect(state).toMatchObject({ status: 'open', workspace: { timezone: 'Pacific/Kiritimati' } });
    await expect(
      workspace['workspace:set-timezone']({ timezone: 'Not/AZone' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const utcToday = new Date().toISOString().slice(0, 10);
    // Kiritimati is UTC+14: an event made "today" in UTC may already be tomorrow there, so the
    // UTC date alone must not decide the filter. Both days together always contain it.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const both = await ipc['timeline:list']({ limit: 10, fromDate: utcToday, toDate: tomorrow });
    expect(both.items).toHaveLength(1);
  });
});
