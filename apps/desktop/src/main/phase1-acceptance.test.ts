/**
 * PRD §13 acceptance criterion 3, automated against the real main-process stack (workspace
 * manager, SQLite, file store): "A node with formatted text, a table, a code block, inline/display
 * math, tags, and an attachment retains its content after save, exit, and restart."
 *
 * "Exit and restart" is simulated by closing the workspace manager (flushes writes, checkpoints
 * the WAL, releases the lock) and opening the same profile with a brand-new manager instance.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AttachmentId, UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createAttachmentIpcServices } from './services/attachment-ipc-services';
import { createNodeIpcServices } from './services/node-ipc-services';
import { createFileSettingsStore } from './workspaces/app-settings';
import { WorkspaceManager } from './workspaces/workspace-manager';

let sandbox: string;
const managers: WorkspaceManager[] = [];

function startApp(): WorkspaceManager {
  const manager = new WorkspaceManager({
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
  });
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-acceptance-'));
  mkdirSync(join(sandbox, 'userData'));
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  rmSync(sandbox, { recursive: true, force: true });
});

const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});

it('keeps a rich node with tags and an attachment across exit and restart (criterion 3)', async () => {
  // --- First session: create everything. ---
  const firstRun = startApp();
  await firstRun.startup();
  const imageBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('rest of a tiny png'),
  ]);
  const imagePath = join(sandbox, 'figure.png');
  writeFileSync(imagePath, imageBytes);

  const nodes = createNodeIpcServices(firstRun);
  const attachments = createAttachmentIpcServices({
    currentWorkspace: () => firstRun.current,
    maxAttachmentBytes: () => Promise.resolve(20 * 1024 * 1024),
    native: {
      chooseFiles: () => Promise.resolve([imagePath]),
      openFile: () => Promise.resolve(true),
    },
    logFailure: () => undefined,
  });

  const node = await nodes['nodes:create']({ title: 'Fourier transform' });
  const { added } = await attachments['attachments:add']({ nodeId: node.id });
  const attachment = added[0];
  if (attachment === undefined) throw new Error('attachment was not added');

  const note = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [text('Definition')] },
      {
        type: 'paragraph',
        content: [
          text('The '),
          text('transform', [{ type: 'bold' }]),
          text(' of '),
          { type: 'inlineMath', attrs: { latex: 'f(x)' } },
          text(' — מעבר לתחום התדר.'),
        ],
      },
      { type: 'blockMath', attrs: { latex: '\\hat f(\\xi)=\\int f(x)e^{-2\\pi i x\\xi}\\,dx' } },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('f')] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('F')] }] },
            ],
          },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'python' }, content: [text('numpy.fft.fft(x)')] },
      {
        type: 'attachment',
        attrs: { attachmentId: attachment.id, displayName: 'figure.png', kind: 'image' },
      },
    ],
  };
  const saved = await nodes['nodes:update']({
    nodeId: node.id,
    expectedRevision: node.revision,
    changes: { note },
  });
  await nodes['nodes:add-tag']({ nodeId: node.id, label: 'Signal processing' });
  await nodes['nodes:add-tag']({ nodeId: node.id, label: 'Math' });

  // --- Exit. ---
  await firstRun.close();
  rmSync(imagePath); // The original file is gone; the managed copy must not depend on it.

  // --- Restart with a fresh process state. ---
  const secondRun = startApp();
  await secondRun.startup();
  const reloaded = await createNodeIpcServices(secondRun)['nodes:get']({ nodeId: node.id });

  expect(reloaded.title).toBe('Fourier transform');
  expect(reloaded.revision).toBe(saved.revision);
  expect(reloaded.note).toEqual(saved.note);
  expect(JSON.stringify(reloaded.note)).toContain('מעבר לתחום התדר');
  expect(reloaded.tags.map((tag) => tag.label)).toEqual(['Math', 'Signal processing']);

  const stored = await secondRun.current!.services.attachments.getStoredFile(
    attachment.id as AttachmentId,
  );
  const storedPath = await secondRun.current!.attachmentStore.resolveExisting(stored.relativePath);
  const storedBytes = readFileSync(storedPath!);
  expect(storedBytes.equals(imageBytes)).toBe(true);
  expect(stored.sha256).toBe(createHash('sha256').update(imageBytes).digest('hex'));
});
