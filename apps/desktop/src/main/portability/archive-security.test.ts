/**
 * Hostile and broken archives (PRD §11 "Security: malicious archives, traversal, symlinks, and
 * file escapes"; §5.11 "Validate the whole package before mutation").
 *
 * Archives are assembled byte by byte with `buildZip`, because ZIP libraries refuse to write the
 * unsafe names and lying headers these tests need. Every rejected import must leave the
 * workspace exactly as it was: no records and no files.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  type ArchiveData,
  type UtcTimestamp,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSettingsStore } from '../workspaces/app-settings';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { WorkspaceManager } from '../workspaces/workspace-manager';
import { applyImport, IMPORT_LIMITS, prepareImport } from './import-workspace';

interface RawEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate?: boolean;
  /** Lie about the uncompressed size in both headers. */
  readonly declaredSize?: number;
  /** Unix file mode stored in the external attributes (for example a symlink). */
  readonly unixMode?: number;
}

/** Writes a minimal ZIP (no ZIP64) with full control over every header field. */
function buildZip(entries: readonly RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const size = entry.declaredSize ?? entry.data.length;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const T = '2026-10-27T10:00:00.000Z';
const NODE = 'a1111111-0000-4000-8000-000000000001';
const ATTACHMENT = 'b2222222-0000-4000-8000-000000000002';

function data(overrides: Partial<ArchiveData> = {}): ArchiveData {
  return {
    nodes: [
      {
        id: NODE,
        title: 'Imported node',
        summary: null,
        note: { type: 'doc', content: [] },
        noteSchemaVersion: 2,
        createdAt: T,
        updatedAt: T,
      },
    ],
    tags: [],
    nodeTags: [],
    relationshipTypes: [],
    relationships: [],
    maps: [],
    placements: [],
    connections: [],
    timelineEvents: [],
    attachments: [],
    graphPositions: [],
    ...overrides,
  };
}

/** A well-formed archive of `content`, plus optional extra entries or manifest changes. */
function archive(
  content: ArchiveData,
  options: {
    files?: { name: string; data: Buffer }[];
    extraEntries?: RawEntry[];
    manifest?: Record<string, unknown>;
    dataBytes?: Buffer;
  } = {},
): Buffer {
  const dataBytes = Buffer.from(JSON.stringify(content));
  const files = options.files ?? [];
  const manifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportId: 'c3333333-0000-4000-8000-000000000003',
    exportedAt: T,
    appVersion: 'test',
    schemaVersion: 5,
    workspace: { id: 'd4444444-0000-4000-8000-000000000004', name: 'Elsewhere', timezone: 'UTC' },
    counts: {
      nodes: content.nodes.length,
      tags: content.tags.length,
      relationshipTypes: content.relationshipTypes.length,
      relationships: content.relationships.length,
      maps: content.maps.length,
      placements: content.placements.length,
      connections: content.connections.length,
      timelineEvents: content.timelineEvents.length,
      attachments: content.attachments.length,
    },
    files: [
      { path: 'data/workspace.json', byteSize: dataBytes.length, sha256: sha256(dataBytes) },
      ...files.map((file) => ({
        path: file.name,
        byteSize: file.data.length,
        sha256: sha256(file.data),
      })),
    ],
    ...options.manifest,
  };
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'data/workspace.json', data: options.dataBytes ?? dataBytes, deflate: true },
    ...files,
    ...(options.extraEntries ?? []),
  ]);
}

let sandbox: string;
let manager: WorkspaceManager;
let workspace: OpenWorkspace;

beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-archive-security-'));
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
  workspace = manager.current!;
});

afterEach(async () => {
  await manager.close();
  rmSync(sandbox, { recursive: true, force: true });
});

function write(bytes: Buffer): string {
  const path = join(sandbox, `${crypto.randomUUID()}.zip`);
  writeFileSync(path, bytes);
  return path;
}

const options = { ids: { newId: () => crypto.randomUUID() }, maxAttachmentBytes: 1024 * 1024 };

async function importArchive(bytes: Buffer, limits = IMPORT_LIMITS) {
  const prepared = await prepareImport(workspace, write(bytes), { ...options, limits });
  await applyImport(workspace, prepared);
  return prepared;
}

/** Nothing of a failed import may be visible: no nodes and no stored files. */
async function expectUnchanged() {
  const snapshot = await workspace.services.snapshots.read(workspace.id);
  expect(snapshot.nodes).toEqual([]);
  expect(snapshot.attachments).toEqual([]);
  // Files only: an emptied shard folder may stay until the next startup reconciliation.
  const stored = readdirSync(workspace.paths.attachments, {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile());
  expect(stored).toEqual([]);
}

describe('hostile archives are rejected before anything changes', () => {
  it.each([
    ['a parent-directory entry', '../escaped.txt'],
    ['a nested parent-directory entry', 'attachments/../../escaped.txt'],
    ['an absolute path', '/etc/escaped.txt'],
    ['a drive letter', 'C:/escaped.txt'],
    ['a backslash path', 'attachments\\..\\escaped.txt'],
    ['a control character', 'attachments/evil\u0001.txt'],
  ])('rejects %s', async (_case, name) => {
    const bytes = archive(data(), { extraEntries: [{ name, data: Buffer.from('x') }] });
    await expect(importArchive(bytes)).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    expect(existsSync(join(sandbox, 'escaped.txt'))).toBe(false);
    await expectUnchanged();
  });

  it('rejects symbolic links', async () => {
    const bytes = archive(data(), {
      extraEntries: [
        { name: 'attachments/link', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 },
      ],
    });
    await expect(importArchive(bytes)).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
    await expectUnchanged();
  });

  it('rejects names that repeat, also in another letter case', async () => {
    const bytes = archive(data(), {
      extraEntries: [{ name: 'DATA/workspace.json', data: Buffer.from('{}') }],
    });
    await expect(importArchive(bytes)).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
  });

  it('rejects files outside the archive layout', async () => {
    const bytes = archive(data(), {
      extraEntries: [{ name: 'setup.exe', data: Buffer.from('MZ') }],
    });
    await expect(importArchive(bytes)).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
  });

  it('rejects zip bombs by their declared size before inflating them', async () => {
    const bomb = Buffer.alloc(2 * 1024 * 1024);
    const bytes = archive(data(), {
      extraEntries: [{ name: `attachments/${ATTACHMENT}`, data: bomb, deflate: true }],
    });
    const limits = { ...IMPORT_LIMITS, maxTotalUncompressedBytes: 1024 * 1024 };
    await expect(importArchive(bytes, limits)).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
    await expectUnchanged();
  });

  it('rejects entries that inflate to more than they declare', async () => {
    const real = Buffer.from(JSON.stringify(data()));
    const bytes = archive(data(), { dataBytes: real });
    // Rewrite the data entry with a declared size smaller than its real content.
    const lying = buildZip([
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify({ format: ARCHIVE_FORMAT, formatVersion: 1 })),
      },
      { name: 'data/workspace.json', data: real, deflate: true, declaredSize: 10 },
    ]);
    expect(bytes.length).toBeGreaterThan(0);
    await expect(importArchive(lying)).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
  });

  it('rejects archives with too many entries', async () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      name: `attachments/${index}`,
      data: Buffer.from('x'),
    }));
    const limits = { ...IMPORT_LIMITS, maxEntries: 10 };
    await expect(
      importArchive(archive(data(), { extraEntries: entries }), limits),
    ).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
  });

  it('rejects files that are not ZIP archives', async () => {
    await expect(importArchive(Buffer.from('not a zip at all'))).rejects.toMatchObject({
      code: 'ARCHIVE_INVALID',
    });
  });

  it('rejects archives from a newer mmap with an actionable message', async () => {
    const bytes = archive(data(), { manifest: { formatVersion: ARCHIVE_FORMAT_VERSION + 1 } });
    await expect(importArchive(bytes)).rejects.toMatchObject({
      code: 'ARCHIVE_TOO_NEW',
      message: expect.stringContaining('Update mmap') as unknown,
    });
  });

  it('rejects data that does not match its checksum', async () => {
    const tampered = Buffer.from(JSON.stringify(data({ nodes: [] })));
    const bytes = archive(data(), { dataBytes: tampered });
    await expect(importArchive(bytes)).rejects.toMatchObject({ code: 'ARCHIVE_INVALID' });
  });

  it('rejects unknown fields in the data', async () => {
    const withExtra = { ...data(), secrets: [] } as unknown as ArchiveData;
    await expect(importArchive(archive(withExtra))).rejects.toMatchObject({
      code: 'ARCHIVE_INVALID',
    });
  });

  it('rejects inconsistent data and writes nothing', async () => {
    const broken = data({
      relationshipTypes: [
        {
          id: 'type',
          label: 'causes',
          directionality: 'directed',
          isArchived: false,
          isBuiltin: false,
          createdAt: T,
          updatedAt: T,
        },
      ],
      relationships: [
        {
          id: 'r',
          sourceNodeId: NODE,
          targetNodeId: 'missing-node',
          typeId: 'type',
          description: null,
          createdAt: T,
          updatedAt: T,
        },
      ],
    });
    await expect(importArchive(archive(broken))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('not consistent') as unknown,
    });
    await expectUnchanged();
  });

  it('rejects hostile note content', async () => {
    const hostile = data({
      nodes: [
        {
          id: NODE,
          title: 'Script',
          summary: null,
          note: {
            type: 'doc',
            content: [{ type: 'html', attrs: { html: '<script>alert(1)</script>' } }],
          },
          noteSchemaVersion: 2,
          createdAt: T,
          updatedAt: T,
        },
      ],
    });
    await expect(importArchive(archive(hostile))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expectUnchanged();
  });
});

describe('attachments in archives', () => {
  const attachmentRecord = (bytes: Buffer, originalName: string) => ({
    id: ATTACHMENT,
    nodeId: NODE,
    originalName,
    mimeType: 'image/png',
    byteSize: bytes.length,
    sha256: sha256(bytes),
    createdAt: T,
    updatedAt: T,
  });

  it('leaves out executables, judged by their bytes, and says so', async () => {
    const program = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);
    const bytes = archive(data({ attachments: [attachmentRecord(program, 'holiday.png')] }), {
      files: [{ name: `attachments/${ATTACHMENT}`, data: program }],
    });
    const prepared = await importArchive(bytes);
    expect(prepared.warnings).toContain(
      '1 attachment is not imported: Programs and scripts cannot be attached, for your safety.',
    );
    const snapshot = await workspace.services.snapshots.read(workspace.id);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.attachments).toEqual([]);
  });

  it('takes the file type from the bytes, not from the archive', async () => {
    const text = Buffer.from('plain words');
    const record = { ...attachmentRecord(text, 'notes.txt'), mimeType: 'text/html' };
    const bytes = archive(data({ attachments: [record] }), {
      files: [{ name: `attachments/${ATTACHMENT}`, data: text }],
    });
    await importArchive(bytes);
    const [stored] = (await workspace.services.snapshots.read(workspace.id)).attachments;
    expect(stored?.mimeType).toBe('text/plain');
  });

  it('removes copied files when a later attachment fails its checksum', async () => {
    const good = Buffer.from('first file');
    const second = 'e5555555-0000-4000-8000-000000000005';
    const recorded = Buffer.from('what the archive promised');
    const actual = Buffer.from('what the archive contains');
    const content = data({
      attachments: [
        { ...attachmentRecord(good, 'a.txt'), mimeType: 'text/plain' },
        {
          ...attachmentRecord(recorded, 'b.txt'),
          id: second,
          mimeType: 'text/plain',
          byteSize: actual.length,
        },
      ],
    });
    // Manifest and data agree on the promised checksum; the stored bytes differ.
    const bytes = buildZip([
      {
        name: 'manifest.json',
        data: Buffer.from(
          JSON.stringify({
            format: ARCHIVE_FORMAT,
            formatVersion: ARCHIVE_FORMAT_VERSION,
            exportId: 'c3333333-0000-4000-8000-000000000003',
            exportedAt: T,
            appVersion: 'test',
            schemaVersion: 5,
            workspace: {
              id: 'd4444444-0000-4000-8000-000000000004',
              name: 'Elsewhere',
              timezone: 'UTC',
            },
            counts: {
              nodes: 1,
              tags: 0,
              relationshipTypes: 0,
              relationships: 0,
              maps: 0,
              placements: 0,
              connections: 0,
              timelineEvents: 0,
              attachments: 2,
            },
            files: [
              {
                path: 'data/workspace.json',
                byteSize: Buffer.byteLength(JSON.stringify(content)),
                sha256: sha256(Buffer.from(JSON.stringify(content))),
              },
              { path: `attachments/${ATTACHMENT}`, byteSize: good.length, sha256: sha256(good) },
              { path: `attachments/${second}`, byteSize: actual.length, sha256: sha256(recorded) },
            ],
          }),
        ),
      },
      { name: 'data/workspace.json', data: Buffer.from(JSON.stringify(content)) },
      { name: `attachments/${ATTACHMENT}`, data: good },
      { name: `attachments/${second}`, data: actual },
    ]);
    await expect(importArchive(bytes)).rejects.toMatchObject({ code: 'ARCHIVE_CHECKSUM_MISMATCH' });
    await expectUnchanged();
  });
});
