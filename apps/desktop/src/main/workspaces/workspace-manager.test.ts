/**
 * Workspace lifecycle tests against real folders and SQLite files in a temporary directory.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSettingsStore } from './app-settings';
import { DATABASE_FILE_NAME, LOCK_FILE_NAME, MANIFEST_FILE_NAME } from './workspace-folder';
import type { LockEnvironment } from './workspace-lock';
import { DEFAULT_WORKSPACE_NAME, WorkspaceManager } from './workspace-manager';

let sandbox: string;
let userData: string;
let idCounter = 0;

/**
 * Stand-in for the Recycle Bin: moves folders into `<sandbox>/recycle-bin` so tests can check
 * that nothing was permanently deleted. Set `failNext` to simulate a refusal (e.g. a file in use).
 */
const trash = {
  failNext: false,
  trashed: [] as string[],
  async move(folderPath: string): Promise<void> {
    if (trash.failNext) {
      trash.failNext = false;
      throw new Error('Folder is in use.');
    }
    const target = join(sandbox, 'recycle-bin', String(trash.trashed.length));
    mkdirSync(join(sandbox, 'recycle-bin'), { recursive: true });
    renameSync(folderPath, target);
    trash.trashed.push(folderPath);
  },
};
const managers: WorkspaceManager[] = [];

beforeEach(() => {
  trash.failNext = false;
  trash.trashed = [];
  // Resolve to the real long path: on machines with 8.3 short names (e.g. GitHub runners,
  // RUNNER~1 instead of runneradmin) tmpdir() is a short path, while the code under test returns
  // real paths.
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'mmap-manager-')));
  userData = join(sandbox, 'userData');
  mkdirSync(userData);
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close();
  }
  rmSync(sandbox, { recursive: true, force: true });
});

function lockEnvironment(overrides: Partial<LockEnvironment> = {}): LockEnvironment {
  return {
    pid: process.pid,
    hostname: 'this-computer',
    instanceId: `instance-${++idCounter}`,
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    isProcessAlive: () => true,
    ...overrides,
  };
}

function createManager(lock: LockEnvironment = lockEnvironment()): WorkspaceManager {
  const manager = new WorkspaceManager({
    settings: createFileSettingsStore(userData),
    defaultWorkspacesRoot: join(userData, 'workspaces'),
    appVersion: '0.1.0-test',
    timezone: () => 'Asia/Jerusalem',
    clock: { now: () => '2026-10-26T12:00:00.000Z' as UtcTimestamp },
    ids: { newId: () => crypto.randomUUID() },
    lockEnvironment: lock,
    trashFolder: (folderPath) => trash.move(folderPath),
  });
  managers.push(manager);
  return manager;
}

function expectOpen(state: Awaited<ReturnType<WorkspaceManager['startup']>>) {
  if (state.status !== 'open') {
    throw new Error(`Expected an open workspace, got ${JSON.stringify(state)}`);
  }
  return state.workspace;
}

describe('first run', () => {
  it('creates the default workspace with manifest, database and folders', async () => {
    const workspace = expectOpen(await createManager().startup());
    const folder = join(userData, 'workspaces', DEFAULT_WORKSPACE_NAME);

    expect(workspace).toMatchObject({
      name: DEFAULT_WORKSPACE_NAME,
      folderPath: folder,
      timezone: 'Asia/Jerusalem',
      cloudSyncProvider: null,
    });
    for (const entry of [MANIFEST_FILE_NAME, DATABASE_FILE_NAME, 'attachments', 'recovery']) {
      expect(existsSync(join(folder, entry))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(folder, MANIFEST_FILE_NAME), 'utf8')) as {
      workspaceId: string;
    };
    expect(manifest.workspaceId).toBe(workspace.id);
  });

  it('reopens the same workspace on the next launch (content survives restart)', async () => {
    const first = createManager();
    const created = expectOpen(await first.startup());
    await first.rename('Renamed before restart');
    await first.close();

    const reopened = expectOpen(await createManager().startup());

    expect(reopened.id).toBe(created.id);
    expect(reopened.name).toBe('Renamed before restart');
  });

  it('adopts an existing default workspace when settings were lost instead of replacing it', async () => {
    const first = createManager();
    const created = expectOpen(await first.startup());
    await first.close();
    rmSync(join(userData, 'settings.json'));

    const adopted = expectOpen(await createManager().startup());

    expect(adopted.id).toBe(created.id);
  });
});

describe('missing and damaged workspaces (PRD §5.1)', () => {
  it('reports a missing last workspace and never creates an empty replacement', async () => {
    const first = createManager();
    const created = expectOpen(await first.startup());
    await first.close();
    rmSync(created.folderPath, { recursive: true });

    const state = await createManager().startup();

    expect(state).toMatchObject({
      status: 'unavailable',
      reason: 'WORKSPACE_MISSING',
      lastWorkspace: { folderPath: created.folderPath },
    });
    expect(existsSync(created.folderPath)).toBe(false);
  });

  it('refuses to create a new database when the database file is missing', async () => {
    const first = createManager();
    const created = expectOpen(await first.startup());
    await first.close();
    rmSync(join(created.folderPath, DATABASE_FILE_NAME));

    const state = await createManager().startup();

    expect(state).toMatchObject({ status: 'unavailable', reason: 'WORKSPACE_DAMAGED' });
    expect(existsSync(join(created.folderPath, DATABASE_FILE_NAME))).toBe(false);
  });

  it('rejects folders that are not workspaces', async () => {
    const manager = createManager();
    await manager.startup();
    const randomFolder = join(sandbox, 'random');
    mkdirSync(randomFolder);
    writeFileSync(join(randomFolder, 'notes.txt'), 'hello');

    await expect(manager.openFolder(randomFolder)).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID',
    });
  });

  it('rejects a manifest from a newer mmap version', async () => {
    const first = createManager();
    const created = expectOpen(await first.startup());
    await first.close();
    const manifestPath = join(created.folderPath, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, formatVersion: 99 }));

    await expect(createManager().startup()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'WORKSPACE_TOO_NEW',
    });
  });
});

describe('locking (PRD §5.1)', () => {
  it('prevents a second process from opening an open workspace', async () => {
    const owner = createManager();
    const created = expectOpen(await owner.startup());
    const intruder = createManager();

    await expect(intruder.openFolder(created.folderPath)).rejects.toMatchObject({
      code: 'WORKSPACE_LOCKED',
    });
  });

  it('recovers a stale lock left by a crashed process on this computer', async () => {
    const previousRun = createManager();
    const created = expectOpen(await previousRun.startup());
    await previousRun.close();
    // Simulate a crash: the lock file of a process that no longer exists was left behind.
    writeFileSync(
      join(created.folderPath, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 999_999,
        hostname: 'this-computer',
        instanceId: 'crashed-run',
        acquiredAt: '2026-10-26T11:00:00.000Z',
      }),
    );

    const recovered = createManager(lockEnvironment({ isProcessAlive: (pid) => pid !== 999_999 }));

    expect(expectOpen(await recovered.startup()).id).toBe(created.id);
  });

  it('never treats a lock from another computer as stale', async () => {
    const first = createManager();
    const created = expectOpen(await first.startup());
    await first.close();
    writeFileSync(
      join(created.folderPath, LOCK_FILE_NAME),
      JSON.stringify({
        pid: 1,
        hostname: 'laptop-elsewhere',
        instanceId: 'other',
        acquiredAt: '2026-10-26T11:00:00.000Z',
      }),
    );

    const state = await createManager(lockEnvironment({ isProcessAlive: () => false })).startup();

    expect(state).toMatchObject({ status: 'unavailable', reason: 'WORKSPACE_LOCKED' });
  });

  it('releases the lock on close', async () => {
    const manager = createManager();
    const created = expectOpen(await manager.startup());

    await manager.close();

    expect(existsSync(join(created.folderPath, LOCK_FILE_NAME))).toBe(false);
  });
});

describe('create, switch and recent workspaces', () => {
  it('switches between workspaces and keeps them isolated', async () => {
    const manager = createManager();
    const first = expectOpen(await manager.startup());

    const second = expectOpen(await manager.create('Second brain', null));
    const recent = await manager.listRecent();

    expect(second.id).not.toBe(first.id);
    expect(second.folderPath).toBe(join(userData, 'workspaces', 'Second brain'));
    // The previous workspace was closed: its lock is gone.
    expect(existsSync(join(first.folderPath, LOCK_FILE_NAME))).toBe(false);
    expect(recent.map((entry) => [entry.name, entry.isCurrent])).toEqual([
      ['Second brain', true],
      [DEFAULT_WORKSPACE_NAME, false],
    ]);

    const back = expectOpen(await manager.openRecent(first.id));
    expect(back.id).toBe(first.id);
  });

  it('keeps the current workspace when switching fails', async () => {
    const manager = createManager();
    const current = expectOpen(await manager.startup());

    await expect(manager.openFolder(join(sandbox, 'does-not-exist'))).rejects.toMatchObject({
      code: 'WORKSPACE_MISSING',
    });

    expect(expectOpen(manager.getState()).id).toBe(current.id);
  });

  it('picks a free folder name instead of reusing an existing folder', async () => {
    const manager = createManager();
    await manager.startup();
    mkdirSync(join(userData, 'workspaces', 'Notes'));

    const created = expectOpen(await manager.create('Notes', null));

    expect(created.folderPath).toBe(join(userData, 'workspaces', 'Notes (2)'));
  });

  it('creates in a user-chosen parent folder with a Windows-safe folder name', async () => {
    const manager = createManager();
    await manager.startup();
    const parent = join(sandbox, 'chosen');
    mkdirSync(parent);

    const created = expectOpen(await manager.create('Physics: waves?', parent));

    expect(created.folderPath).toBe(join(parent, 'Physics- waves-'));
    expect(created.name).toBe('Physics: waves?');
  });

  it('rejects network share locations', async () => {
    const manager = createManager();
    await manager.startup();

    await expect(manager.create('Shared', '\\\\server\\share')).rejects.toMatchObject({
      code: 'WORKSPACE_UNSUPPORTED_LOCATION',
    });
  });

  it('flags cloud-sync folders with a warning', async () => {
    const manager = createManager();
    await manager.startup();
    const oneDrive = join(sandbox, 'OneDrive - University', 'Docs');
    mkdirSync(oneDrive, { recursive: true });

    const created = expectOpen(await manager.create('Synced', oneDrive));

    expect(created.cloudSyncProvider).toBe('OneDrive');
  });

  it('forgets a recent entry without deleting its folder', async () => {
    const manager = createManager();
    const first = expectOpen(await manager.startup());
    await manager.create('Other', null);

    const remaining = await manager.forgetRecent(first.id);

    expect(remaining.map((entry) => entry.name)).toEqual(['Other']);
    expect(existsSync(first.folderPath)).toBe(true);
  });

  it('serializes concurrent operations so only one workspace ends up open', async () => {
    const manager = createManager();
    await manager.startup();

    const results = await Promise.all([manager.create('A', null), manager.create('B', null)]);

    expect(results.map((state) => state.status)).toEqual(['open', 'open']);
    expect(expectOpen(manager.getState()).name).toBe('B');
    expect(existsSync(join(userData, 'workspaces', 'A', LOCK_FILE_NAME))).toBe(false);
  });
});

describe('settings resilience', () => {
  it('starts with defaults when settings.json is damaged', async () => {
    writeFileSync(join(userData, 'settings.json'), '{ not json');

    expect(expectOpen(await createManager().startup()).name).toBe(DEFAULT_WORKSPACE_NAME);
  });
});

describe('moving a workspace (PRD §5.1)', () => {
  async function workspaceWithContent(manager: WorkspaceManager) {
    const workspace = expectOpen(await manager.startup());
    const node = await manager.current!.services.nodes.create({ title: 'Survives the move' });
    // A real, recorded attachment: an unrecorded file would be removed by reconciliation.
    const sourcePath = join(sandbox, 'notes.txt');
    writeFileSync(sourcePath, 'attachment bytes');
    const stored = await manager.current!.attachmentStore.importFile(sourcePath, 'txt', 1_000);
    const attachment = await manager.current!.services.attachments.register(node.id, {
      relativePath: stored.relativePath,
      displayName: 'notes.txt',
      mimeType: 'text/plain',
      byteSize: stored.byteSize,
      sha256: stored.sha256,
    });
    return { workspace, node, attachment };
  }

  it('copies, verifies, opens the copy, then sends the original to the Recycle Bin', async () => {
    const manager = createManager();
    const { workspace, node, attachment } = await workspaceWithContent(manager);
    const target = join(sandbox, 'Documents');
    mkdirSync(target);

    const result = await manager.move(target);

    const moved = expectOpen(result.state);
    expect(moved.id).toBe(workspace.id);
    expect(moved.folderPath).toBe(join(target, DEFAULT_WORKSPACE_NAME));
    expect(result).toMatchObject({ originalRemoved: true, originalFolder: workspace.folderPath });
    expect(trash.trashed).toEqual([workspace.folderPath]);
    expect(existsSync(workspace.folderPath)).toBe(false);
    await expect(manager.current!.services.nodes.get(node.id)).resolves.toMatchObject({
      title: 'Survives the move',
    });
    const storedFile = await manager.current!.services.attachments.getStoredFile(attachment.id);
    const storedPath = await manager.current!.attachmentStore.resolveExisting(
      storedFile.relativePath,
    );
    expect(storedPath?.startsWith(moved.folderPath)).toBe(true);
    expect(readFileSync(storedPath!, 'utf8')).toBe('attachment bytes');
    // The lock moved with the open workspace; no stale lock was copied.
    expect(existsSync(join(moved.folderPath, LOCK_FILE_NAME))).toBe(true);
    const recent = await manager.listRecent();
    expect(recent.map((entry) => entry.folderPath)).toEqual([moved.folderPath]);
  });

  it('reopens the next launch at the new location', async () => {
    const first = createManager();
    await first.startup();
    const target = join(sandbox, 'elsewhere');
    mkdirSync(target);
    const moved = expectOpen((await first.move(target)).state);
    await first.close();

    expect(expectOpen(await createManager().startup()).folderPath).toBe(moved.folderPath);
  });

  it('keeps the original open and unchanged when the destination is inside the workspace', async () => {
    const manager = createManager();
    const { workspace } = await workspaceWithContent(manager);

    await expect(manager.move(join(workspace.folderPath, 'attachments'))).rejects.toMatchObject({
      code: 'WORKSPACE_MOVE_FAILED',
    });

    expect(expectOpen(manager.getState()).folderPath).toBe(workspace.folderPath);
    expect(trash.trashed).toEqual([]);
  });

  it('keeps the original when the copy fails, and leaves no partial copy behind', async () => {
    const manager = createManager();
    const { workspace, node } = await workspaceWithContent(manager);
    const missingParent = join(sandbox, 'does-not-exist');

    await expect(manager.move(missingParent)).rejects.toMatchObject({
      code: 'WORKSPACE_MOVE_FAILED',
    });

    expect(expectOpen(manager.getState()).folderPath).toBe(workspace.folderPath);
    expect(existsSync(missingParent)).toBe(false);
    await expect(manager.current!.services.nodes.get(node.id)).resolves.toBeDefined();
  });

  it('reports when the original could not be moved to the Recycle Bin', async () => {
    const manager = createManager();
    const { workspace } = await workspaceWithContent(manager);
    const target = join(sandbox, 'target');
    mkdirSync(target);
    trash.failNext = true;

    const result = await manager.move(target);

    expect(result.originalRemoved).toBe(false);
    expect(existsSync(workspace.folderPath)).toBe(true);
    expect(expectOpen(result.state).folderPath).toBe(join(target, DEFAULT_WORKSPACE_NAME));
  });

  it('rejects network destinations', async () => {
    const manager = createManager();
    await manager.startup();

    await expect(manager.move('\\\\server\\share')).rejects.toMatchObject({
      code: 'WORKSPACE_UNSUPPORTED_LOCATION',
    });
  });
});

describe('deleting a workspace (PRD §5.1)', () => {
  it('requires the exact workspace name and then sends the folder to the Recycle Bin', async () => {
    const manager = createManager();
    const workspace = expectOpen(await manager.startup());

    await expect(manager.deleteCurrent('my knowledge')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(expectOpen(manager.getState()).id).toBe(workspace.id);

    const state = await manager.deleteCurrent(DEFAULT_WORKSPACE_NAME);

    expect(state).toEqual({ status: 'none' });
    expect(trash.trashed).toEqual([workspace.folderPath]);
    await expect(manager.listRecent()).resolves.toEqual([]);
  });

  it('does not recreate the deleted default workspace on the next launch', async () => {
    const first = createManager();
    await first.startup();
    await first.create('Kept', null);
    await first.openRecent(
      (await first.listRecent()).find((entry) => entry.name === DEFAULT_WORKSPACE_NAME)!
        .workspaceId,
    );
    await first.deleteCurrent(DEFAULT_WORKSPACE_NAME);
    await first.close();

    const next = await createManager().startup();

    // The last workspace is gone, so the user chooses; nothing is created behind their back.
    expect(next.status).toBe('none');
  });

  it('reopens the workspace and deletes nothing when the Recycle Bin refuses', async () => {
    const manager = createManager();
    const workspace = expectOpen(await manager.startup());
    trash.failNext = true;

    await expect(manager.deleteCurrent(DEFAULT_WORKSPACE_NAME)).rejects.toMatchObject({
      code: 'WORKSPACE_DELETE_FAILED',
    });

    expect(expectOpen(manager.getState()).id).toBe(workspace.id);
    expect(existsSync(workspace.folderPath)).toBe(true);
  });

  it('refuses when the folder now belongs to a different workspace', async () => {
    const manager = createManager();
    const workspace = expectOpen(await manager.startup());
    const manifestPath = join(workspace.folderPath, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, workspaceId: '00000000-0000-4000-8000-000000000999' }),
    );

    await expect(manager.deleteCurrent(DEFAULT_WORKSPACE_NAME)).rejects.toMatchObject({
      code: 'WORKSPACE_DELETE_FAILED',
    });
    expect(trash.trashed).toEqual([]);
  });
});
