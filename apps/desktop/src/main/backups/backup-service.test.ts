/**
 * Backups and restore against the real stack (PRD §9, §11 "Recovery: … full snapshot restore";
 * §13 criterion 17: "backups restore all supported entities and attachment checksums offline").
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AttachmentId, UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAttachmentIpcServices } from '../services/attachment-ipc-services';
import { createFileSettingsStore, type SettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { BackupService } from './backup-service';
import { listSnapshots } from './snapshot-store';

let sandbox: string;
let clock: Date;
const running: { manager: WorkspaceManager; backups: BackupService }[] = [];
const trashed: string[] = [];

function startApp(profile: string, options: { destination?: string } = {}) {
  const userData = join(sandbox, profile);
  mkdirSync(userData, { recursive: true });
  const settings: SettingsStore = createFileSettingsStore(userData);
  let backups: BackupService | null = null;
  const manager = new WorkspaceManager({
    settings,
    defaultWorkspacesRoot: join(userData, 'workspaces'),
    appVersion: 'test',
    timezone: () => 'UTC',
    clock: { now: () => clock.toISOString() as UtcTimestamp },
    ids: { newId: () => crypto.randomUUID() },
    lockEnvironment: {
      pid: process.pid,
      hostname: 'test',
      instanceId: crypto.randomUUID(),
      now: () => clock,
      isProcessAlive: () => true,
    },
    trashFolder: (folder) => {
      trashed.push(folder);
      rmSync(folder, { recursive: true, force: true });
      return Promise.resolve();
    },
    onWorkspaceOpened: (workspace) => void backups?.backUpIfDue(workspace),
  });
  backups = new BackupService({
    workspaces: manager,
    settings,
    defaultDestination: options.destination ?? join(userData, 'backups'),
    appVersion: 'test',
    now: () => clock,
  });
  running.push({ manager, backups });
  return { manager, backups };
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-backups-'));
  clock = new Date('2026-10-27T09:00:00.000Z');
  trashed.length = 0;
});

afterEach(async () => {
  for (const { manager, backups } of running.splice(0)) {
    await backups.idle();
    await manager.close();
  }
  rmSync(sandbox, { recursive: true, force: true });
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('pixels'),
]);

async function addAttachment(manager: WorkspaceManager, nodeId: string, name: string) {
  const path = join(sandbox, name);
  writeFileSync(path, PNG);
  const service = createAttachmentIpcServices({
    currentWorkspace: () => manager.current,
    maxAttachmentBytes: () => Promise.resolve(1024 * 1024),
    native: { chooseFiles: () => Promise.resolve([path]), openFile: () => Promise.resolve(true) },
    logFailure: () => undefined,
  });
  return (await service['attachments:add']({ nodeId })).added[0]!;
}

describe('daily backups', () => {
  it('backs up on the first opening of each day, once', async () => {
    const { manager, backups } = startApp('app');
    await manager.startup();
    await backups.idle();
    const status = await backups.status();
    expect(status.snapshots).toHaveLength(1);
    expect(status.lastSuccessAt).toBe('2026-10-27T09:00:00.000Z');
    expect(status.sameDriveAsWorkspace).toBe(true);
    expect(status.retention).toEqual({ daily: 7, weekly: 4 });

    await backups.backUpIfDue(manager.current!);
    expect((await backups.status()).snapshots).toHaveLength(1);
    clock = new Date('2026-10-28T08:00:00.000Z');
    await backups.backUpIfDue(manager.current!);
    expect((await backups.status()).snapshots).toHaveLength(2);
  });

  it('keeps seven daily and four weekly snapshots and stores each file once', async () => {
    const { manager, backups } = startApp('app');
    await manager.startup();
    await backups.idle();
    const node = await manager.current!.services.nodes.create({ title: 'With a picture' });
    await addAttachment(manager, node.id, 'a.png');
    await addAttachment(manager, node.id, 'b.png');
    for (let day = 1; day <= 40; day += 1) {
      clock = new Date(Date.UTC(2026, 9, 27 + day, 9));
      await backups.backUpIfDue(manager.current!);
    }
    const status = await backups.status();
    expect(status.snapshots.length).toBeLessThanOrEqual(11);
    expect(status.snapshots.length).toBeGreaterThanOrEqual(10);
    expect(status.snapshots[0]!.attachmentCount).toBe(2);
    // Two attachments with the same bytes are stored once, for all snapshots together.
    const files = readdirSync(join(status.destination, manager.current!.id, 'files'), {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile());
    expect(files).toHaveLength(1);
  });

  it('records a failure instead of throwing, and shows it in the status', async () => {
    const blocked = join(sandbox, 'not-a-folder');
    writeFileSync(blocked, 'a file where the backup folder should be');
    const { manager, backups } = startApp('app', { destination: blocked });
    await manager.startup();
    await backups.idle();
    const status = await backups.status();
    expect(status.snapshots).toEqual([]);
    expect(status.lastFailure?.message).toMatch(/^The backup failed/u);
  });
});

describe('restore', () => {
  it('restores the open workspace from a snapshot after a safety backup', async () => {
    const { manager, backups } = startApp('app');
    await manager.startup();
    await backups.idle();
    const workspace = manager.current!;
    const kept = await workspace.services.nodes.create({ title: 'Kept' });
    const attachment = await addAttachment(manager, kept.id, 'kept.png');
    clock = new Date('2026-10-27T10:00:00.000Z');
    const snapshot = (await backups.backUpNow()).snapshots[0]!;

    // Later changes that the restore must undo.
    await workspace.services.nodes.create({ title: 'Added later' });
    await workspace.services.nodes.delete(
      kept.id,
      (await workspace.services.nodes.get(kept.id)).revision,
    );
    clock = new Date('2026-10-27T11:00:00.000Z');

    const state = await backups.restoreSnapshot(snapshot.id);
    expect(state.status).toBe('open');
    const restored = manager.current!;
    expect(restored.id).toBe(workspace.id);
    expect(restored.paths.folder).toBe(workspace.paths.folder);
    const titles = (await restored.services.snapshots.read(restored.id)).nodes.map(
      (node) => node.title,
    );
    expect(titles).toEqual(['Kept']);
    const record = await restored.services.attachments.getStoredFile(attachment.id as AttachmentId);
    const file = await restored.attachmentStore.resolveExisting(record.relativePath);
    expect(createHash('sha256').update(readFileSync(file!)).digest('hex')).toBe(record.sha256);

    // The state before the restore was backed up, and the old folder went to the Recycle Bin.
    const after = await backups.status();
    expect(after.snapshots.map((item) => item.createdAt)).toContain('2026-10-27T11:00:00.000Z');
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/\.before-restore-/u);
  });

  it('leaves the workspace unchanged when the snapshot is damaged', async () => {
    const { manager, backups } = startApp('app');
    await manager.startup();
    await backups.idle();
    const workspace = manager.current!;
    const snapshot = (await backups.status()).snapshots[0]!;
    await workspace.services.nodes.create({ title: 'Current work' });
    const [listed] = await listSnapshots((await backups.status()).destination, workspace.id);
    writeFileSync(join(listed!.folder, 'mmap.sqlite'), 'damaged');

    await expect(backups.restoreSnapshot(snapshot.id)).rejects.toMatchObject({
      code: 'BACKUP_DAMAGED',
    });
    const current = manager.current!;
    expect(
      (await current.services.snapshots.read(current.id)).nodes.map((node) => node.title),
    ).toEqual(['Current work']);
    expect(
      readdirSync(join(workspace.paths.folder, '..')).filter((name) =>
        name.includes('.restoring-'),
      ),
    ).toEqual([]);
  });

  it('restores a backup folder as a new workspace when the original is gone', async () => {
    const backupRoot = join(sandbox, 'external-drive');
    const original = startApp('old-computer', { destination: backupRoot });
    await original.manager.startup();
    await original.backups.idle();
    const workspace = original.manager.current!;
    await workspace.services.nodes.create({ title: 'Precious note' });
    clock = new Date('2026-10-27T12:00:00.000Z');
    await original.backups.backUpNow();
    const [snapshot] = await listSnapshots(backupRoot, workspace.id);
    await original.backups.idle();
    await original.manager.close();
    rmSync(workspace.paths.folder, { recursive: true, force: true });

    const fresh = startApp('new-computer');
    await fresh.manager.startup();
    await fresh.backups.idle();
    const state = await fresh.backups.restoreFromFolder(snapshot!.folder);
    expect(state.status).toBe('open');
    const restored = fresh.manager.current!;
    expect(restored.id).toBe(workspace.id);
    expect(restored.paths.folder).toMatch(/\(restored\)$/u);
    const titles = (await restored.services.snapshots.read(restored.id)).nodes.map(
      (node) => node.title,
    );
    expect(titles).toEqual(['Precious note']);
    expect(existsSync(join(restored.paths.folder, 'mmap-workspace.json'))).toBe(true);
  });

  it('refuses to restore the open workspace as a second copy', async () => {
    const { manager, backups } = startApp('app');
    await manager.startup();
    await backups.idle();
    const [snapshot] = await listSnapshots(
      (await backups.status()).destination,
      manager.current!.id,
    );
    await expect(backups.restoreFromFolder(snapshot!.folder)).rejects.toMatchObject({
      code: 'RESTORE_FAILED',
    });
  });

  it('rejects a folder that is not a backup', async () => {
    const { manager, backups } = startApp('app');
    await manager.startup();
    await expect(backups.restoreFromFolder(sandbox)).rejects.toMatchObject({
      code: 'BACKUP_DAMAGED',
    });
  });
});
