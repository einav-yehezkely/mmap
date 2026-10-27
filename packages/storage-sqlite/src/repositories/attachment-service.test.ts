/**
 * Attachment metadata service + SQLite repository against a real database (PRD §5.10).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAttachmentService,
  createKnowledgeNodeService,
  createWorkspaceService,
  type AttachmentService,
  type KnowledgeNodeService,
  type StoredFileDescription,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteConnections } from '../sqlite-connections';
import { openWorkspaceDatabase } from '../workspace-database';
import { SqliteAttachmentRepository } from './sqlite-attachment-repository';
import { SqliteKnowledgeNodeRepository } from './sqlite-knowledge-node-repository';
import { SqliteRelationshipTypeRepository } from './sqlite-relationship-type-repository';
import { SqliteTagRepository } from './sqlite-tag-repository';
import { SqliteTimelineEventRepository } from './sqlite-timeline-event-repository';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository';

const WORKSPACE_A = '70000000-0000-4000-8000-00000000000a' as WorkspaceId;
const WORKSPACE_B = '70000000-0000-4000-8000-00000000000b' as WorkspaceId;

let directory: string;
let connections: SqliteConnections;
let idCounter = 0;
const ids = {
  newId: () => `80000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`,
};
const clock = { now: () => '2026-10-26T12:00:00.000Z' as UtcTimestamp };

function services(workspaceId: WorkspaceId): {
  nodes: KnowledgeNodeService;
  attachments: AttachmentService;
} {
  const nodeRepository = new SqliteKnowledgeNodeRepository(connections);
  return {
    nodes: createKnowledgeNodeService({
      workspaceId,
      transactions: connections,
      nodes: nodeRepository,
      timeline: new SqliteTimelineEventRepository(connections),
      tags: new SqliteTagRepository(connections),
      ids,
      clock,
    }),
    attachments: createAttachmentService({
      workspaceId,
      transactions: connections,
      attachments: new SqliteAttachmentRepository(connections),
      nodes: nodeRepository,
      ids,
      clock,
    }),
  };
}

function storedFile(overrides: Partial<StoredFileDescription> = {}): StoredFileDescription {
  idCounter += 1;
  return {
    relativePath: `ab/${idCounter.toString().padStart(4, '0')}.png`,
    displayName: 'diagram.png',
    mimeType: 'image/png',
    byteSize: 1234,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-attachments-db-'));
  connections = (
    await openWorkspaceDatabase(join(directory, 'mmap.sqlite'), { backupDirectory: directory })
  ).connections;
  const workspaces = createWorkspaceService({
    transactions: connections,
    workspaces: new SqliteWorkspaceRepository(connections),
    relationshipTypes: new SqliteRelationshipTypeRepository(connections),
    ids,
    clock,
  });
  await workspaces.initialize(WORKSPACE_A, 'A', 'UTC');
  await workspaces.initialize(WORKSPACE_B, 'B', 'UTC');
});

afterEach(async () => {
  await connections.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('attachment metadata', () => {
  it('registers and lists attachments for a node', async () => {
    const { nodes, attachments } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'With files' });

    const image = await attachments.register(node.id, storedFile());
    const svg = await attachments.register(
      node.id,
      storedFile({ displayName: 'drawing.svg', mimeType: 'image/svg+xml' }),
    );

    expect(image).toMatchObject({ displayName: 'diagram.png', previewable: true });
    // SVG can contain scripts, so it is never previewed inside the app.
    expect(svg.previewable).toBe(false);
    await expect(attachments.listForNode(node.id)).resolves.toHaveLength(2);
  });

  it('refuses to attach to a missing node', async () => {
    const { attachments } = services(WORKSPACE_A);

    await expect(
      attachments.register('80000000-0000-4000-8000-ffffffffffff' as never, storedFile()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the stored path when metadata is removed, so the file can be deleted after', async () => {
    const { nodes, attachments } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Node' });
    const file = storedFile();
    const attachment = await attachments.register(node.id, file);

    await expect(attachments.remove(attachment.id)).resolves.toEqual({
      relativePath: file.relativePath,
    });
    await expect(attachments.listForNode(node.id)).resolves.toEqual([]);
  });

  it('removes attachment rows when the node is deleted (files are reconciled separately)', async () => {
    const { nodes, attachments } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Doomed' });
    await attachments.register(node.id, storedFile());

    await expect(nodes.previewDelete(node.id)).resolves.toMatchObject({ attachments: 1 });
    await nodes.delete(node.id, 1);

    await expect(attachments.listAllRelativePaths()).resolves.toEqual([]);
  });

  it('rejects unsafe stored paths at the database level', async () => {
    const { nodes, attachments } = services(WORKSPACE_A);
    const node = await nodes.create({ title: 'Node' });

    await expect(
      attachments.register(node.id, storedFile({ relativePath: '../../escape.png' })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('never exposes another workspace attachment', async () => {
    const a = services(WORKSPACE_A);
    const b = services(WORKSPACE_B);
    const node = await a.nodes.create({ title: 'Private' });
    const attachment = await a.attachments.register(node.id, storedFile());

    await expect(b.attachments.getStoredFile(attachment.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(b.attachments.remove(attachment.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(b.attachments.listAllRelativePaths()).resolves.toEqual([]);
  });
});
