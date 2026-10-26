/**
 * Workspace lifecycle tests against real folders and SQLite files in a temporary directory.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const managers: WorkspaceManager[] = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-manager-'));
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
