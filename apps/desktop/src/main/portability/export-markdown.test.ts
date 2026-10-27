/**
 * Markdown export against the real stack (PRD §5.11): one file per node with its stable ID,
 * wikilinks to other files, relationships, and attachments next to the notes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UtcTimestamp } from '@mmap/domain';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createAttachmentIpcServices } from '../services/attachment-ipc-services';
import { createTransferIpcServices } from '../services/transfer-ipc-services';
import { createFileSettingsStore } from '../workspaces/app-settings';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { IMPORT_LIMITS } from './import-workspace';
import { ZipReader } from './zip-reader';

let sandbox: string;
let manager: WorkspaceManager;

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-markdown-'));
  const userData = join(sandbox, 'userData');
  mkdirSync(userData);
  manager = new WorkspaceManager({
    settings: createFileSettingsStore(userData),
    defaultWorkspacesRoot: join(userData, 'workspaces'),
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

it('writes one Markdown file per node, with links, relationships and attachments', async () => {
  const workspace = manager.current!;
  const { nodes, relationships, tags } = workspace.services;
  const entropy = await nodes.create({ title: 'Entropy' });
  const heat = await nodes.create({ title: 'Heat' });
  const imagePath = join(sandbox, 'engine diagram.png');
  writeFileSync(
    imagePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('png'),
    ]),
  );
  const attachments = createAttachmentIpcServices({
    currentWorkspace: () => manager.current,
    maxAttachmentBytes: () => Promise.resolve(1024 * 1024),
    native: {
      chooseFiles: () => Promise.resolve([imagePath]),
      openFile: () => Promise.resolve(true),
    },
    logFailure: () => undefined,
  });
  const [attachment] = (await attachments['attachments:add']({ nodeId: entropy.id })).added;
  await nodes.update(entropy.id, entropy.revision, {
    note: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Grows with ' },
            { type: 'wikilink', attrs: { targetNodeId: heat.id, label: 'heat' } },
          ],
        },
        {
          type: 'attachment',
          attrs: { attachmentId: attachment!.id, displayName: 'engine diagram.png', kind: 'image' },
        },
      ],
    },
  });
  await tags.assignToNode(entropy.id, 'thermo');
  const explains = await relationships.createType('explains', 'directed');
  await relationships.create({
    sourceNodeId: entropy.id,
    targetNodeId: heat.id,
    typeId: explains.id,
  });

  const archivePath = join(sandbox, 'notes.zip');
  const transfer = createTransferIpcServices({
    currentWorkspace: () => manager.current,
    maxAttachmentBytes: () => Promise.resolve(1024 * 1024),
    native: {
      chooseExportDestination: () => Promise.resolve(archivePath),
      chooseArchiveToImport: () => Promise.resolve(null),
    },
    appVersion: 'test',
    ids: { newId: () => crypto.randomUUID() },
  });
  expect(await transfer['transfer:export-markdown']({})).toEqual({
    status: 'exported',
    fileName: 'notes.zip',
    nodes: 2,
    attachments: 1,
    warnings: [],
  });

  const reader = await ZipReader.open(archivePath, IMPORT_LIMITS);
  try {
    const entropyFile = `Entropy (${entropy.id.slice(0, 8)})`;
    const heatFile = `Heat (${heat.id.slice(0, 8)})`;
    const imageFile = `${attachment!.id.slice(0, 8)} engine diagram.png`;
    expect(
      reader
        .entries()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(
      [
        'README.md',
        `attachments/${imageFile}`,
        `nodes/${entropyFile}.md`,
        `nodes/${heatFile}.md`,
      ].sort(),
    );
    const entropyMarkdown = (
      await reader.readEntry(`nodes/${entropyFile}.md`, 1024 * 1024)
    ).toString();
    expect(entropyMarkdown).toContain(`id: "${entropy.id}"`);
    expect(entropyMarkdown).toContain('tags: ["thermo"]');
    expect(entropyMarkdown).toContain(`Grows with [[${heatFile}|heat]]`);
    expect(entropyMarkdown).toContain(`![engine diagram.png](<../attachments/${imageFile}>)`);
    expect(entropyMarkdown).toContain(`- explains → [[${heatFile}|Heat]]`);
    const heatMarkdown = (await reader.readEntry(`nodes/${heatFile}.md`, 1024 * 1024)).toString();
    expect(heatMarkdown).toContain(`- [[${entropyFile}|Entropy]] explains → this note`);
    const readme = (await reader.readEntry('README.md', 1024 * 1024)).toString();
    expect(readme).toContain('mmap does not import Markdown files.');
  } finally {
    reader.close();
  }
});
