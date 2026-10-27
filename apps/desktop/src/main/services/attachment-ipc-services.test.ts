/**
 * End-to-end attachment flow in the main process: real workspace folder, real SQLite database,
 * real files; only the native dialog and the OS "open" call are replaced (PRD §5.10, §11).
 */

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

import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileSettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { createAttachmentIpcServices } from './attachment-ipc-services';
import { createNodeIpcServices } from './node-ipc-services';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let sandbox: string;
let sources: string;
let manager: WorkspaceManager;
let chosenFiles: string[] | null;
const openFile = vi.fn((_path: string) => Promise.resolve(true));

function source(name: string, contents: Buffer | string): string {
  const path = join(sources, name);
  writeFileSync(path, contents);
  return path;
}

function services(maxBytes = 20 * 1024 * 1024) {
  return {
    ...createAttachmentIpcServices({
      currentWorkspace: () => manager.current,
      maxAttachmentBytes: () => Promise.resolve(maxBytes),
      native: { chooseFiles: () => Promise.resolve(chosenFiles), openFile },
      logFailure: () => undefined,
    }),
    ...createNodeIpcServices(manager),
  };
}

function storedFiles(): string[] {
  const root = manager.current?.paths.attachments;
  if (!root) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-attach-ipc-'));
  sources = join(sandbox, 'sources');
  mkdirSync(sources);
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
  chosenFiles = null;
  openFile.mockClear();
});

afterEach(async () => {
  await manager.close();
  rmSync(sandbox, { recursive: true, force: true });
});

async function createNode(): Promise<string> {
  const node = await services()['nodes:create']({ title: 'With files' });
  return node.id;
}

describe('attachments:add', () => {
  it('copies accepted files, leaves sources untouched and survives source deletion', async () => {
    const nodeId = await createNode();
    const image = source('diagram.png', PNG_BYTES);
    const pdf = source('paper.pdf', '%PDF-1.7 test');
    chosenFiles = [image, pdf];

    const result = await services()['attachments:add']({ nodeId });

    expect(result.rejected).toEqual([]);
    expect(result.added.map((item) => [item.displayName, item.mimeType, item.previewable])).toEqual(
      [
        ['diagram.png', 'image/png', true],
        ['paper.pdf', 'application/pdf', false],
      ],
    );
    rmSync(image);
    rmSync(pdf);
    expect(storedFiles()).toHaveLength(2);
  });

  it('rejects executables, including disguised ones, without storing anything', async () => {
    const nodeId = await createNode();
    chosenFiles = [
      source('setup.exe', 'MZ fake program'),
      source('holiday.png', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30)])),
      source('script.ps1', 'Remove-Item C:\\'),
    ];

    const result = await services()['attachments:add']({ nodeId });

    expect(result.added).toEqual([]);
    expect(result.rejected.map((item) => item.fileName)).toEqual([
      'setup.exe',
      'holiday.png',
      'script.ps1',
    ]);
    expect(result.rejected[0]?.reason).toMatch(/Programs and scripts/);
    expect(storedFiles()).toEqual([]);
  });

  it('enforces the configured size limit per file and keeps the others', async () => {
    const nodeId = await createNode();
    chosenFiles = [source('big.txt', 'x'.repeat(2_000)), source('small.txt', 'ok')];

    const result = await services(1_000)['attachments:add']({ nodeId });

    expect(result.added.map((item) => item.displayName)).toEqual(['small.txt']);
    expect(result.rejected[0]).toMatchObject({ fileName: 'big.txt' });
  });

  it('returns cancelled when the dialog is dismissed', async () => {
    const nodeId = await createNode();

    await expect(services()['attachments:add']({ nodeId })).resolves.toEqual({
      cancelled: true,
      added: [],
      rejected: [],
    });
  });

  it('fails before opening the dialog when the node does not exist', async () => {
    chosenFiles = [source('a.txt', 'a')];

    await expect(
      services()['attachments:add']({ nodeId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('attachments:open', () => {
  it('opens a stored copy with the OS', async () => {
    const nodeId = await createNode();
    chosenFiles = [source('notes.txt', 'hello')];
    const [added] = (await services()['attachments:add']({ nodeId })).added;

    await expect(services()['attachments:open']({ attachmentId: added!.id })).resolves.toEqual({
      opened: true,
    });
    const openedPath = openFile.mock.calls[0]?.[0] ?? '';
    expect(openedPath.startsWith(manager.current!.paths.attachments)).toBe(true);
    expect(readFileSync(openedPath, 'utf8')).toBe('hello');
  });

  it('refuses to open a stored file that was replaced by a program', async () => {
    const nodeId = await createNode();
    chosenFiles = [source('notes.txt', 'hello')];
    const [added] = (await services()['attachments:add']({ nodeId })).added;
    const stored = await manager.current!.services.attachments.getStoredFile(added!.id as never);
    const absolute = await manager.current!.attachmentStore.resolveExisting(stored.relativePath);
    writeFileSync(absolute!, 'MZ planted program');

    await expect(services()['attachments:open']({ attachmentId: added!.id })).resolves.toEqual({
      opened: false,
    });
    expect(openFile).not.toHaveBeenCalled();
  });
});

describe('attachments:list', () => {
  it('reports a managed copy that went missing instead of hiding it', async () => {
    const nodeId = await createNode();
    chosenFiles = [source('kept.txt', 'kept'), source('lost.txt', 'lost')];
    const { added } = await services()['attachments:add']({ nodeId });
    const lost = added.find((item) => item.displayName === 'lost.txt');
    const record = await manager.current!.services.attachments.getStoredFile(lost!.id as never);
    rmSync((await manager.current!.attachmentStore.resolveExisting(record.relativePath))!);

    const { items } = await services()['attachments:list']({ nodeId });

    expect(items.map((item) => [item.displayName, item.fileAvailable])).toEqual([
      ['kept.txt', true],
      ['lost.txt', false],
    ]);
    await expect(services()['attachments:open']({ attachmentId: lost!.id })).resolves.toEqual({
      opened: false,
    });
  });
});

describe('removal and cleanup', () => {
  it('removes the managed copy with the attachment', async () => {
    const nodeId = await createNode();
    chosenFiles = [source('notes.txt', 'hello')];
    const [added] = (await services()['attachments:add']({ nodeId })).added;

    await services()['attachments:remove']({ attachmentId: added!.id });

    expect(storedFiles()).toEqual([]);
    await expect(services()['attachments:list']({ nodeId })).resolves.toEqual({ items: [] });
  });

  it('deletes the files of a deleted node', async () => {
    const nodeId = await createNode();
    chosenFiles = [source('a.txt', 'a'), source('b.txt', 'b')];
    await services()['attachments:add']({ nodeId });

    await services()['nodes:delete']({ nodeId, expectedRevision: 1 });

    expect(storedFiles()).toEqual([]);
  });

  it('removes orphaned files when the workspace is opened again', async () => {
    const folder = manager.current!.paths.folder;
    const orphanDirectory = join(manager.current!.paths.attachments, 'zz');
    mkdirSync(orphanDirectory, { recursive: true });
    writeFileSync(join(orphanDirectory, 'orphan.txt'), 'left behind by a crash');
    await manager.create('Other', null);
    await manager.openFolder(folder);
    // Reconciliation runs in the background after opening.
    await vi.waitFor(() => expect(existsSync(join(orphanDirectory, 'orphan.txt'))).toBe(false));
  });
});
