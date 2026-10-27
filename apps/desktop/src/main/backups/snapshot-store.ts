/**
 * Workspace backup snapshots on disk (PRD §9: "Create consistent backups using SQLite's backup
 * mechanism plus verified attachments, never a raw live-database copy that ignores WAL").
 *
 * Layout under the backup destination:
 *
 *   <destination>/<workspace ID>/
 *     snapshots/<UTC time>/          one folder per snapshot
 *       backup.json                  manifest: workspace, time, versions, checksums
 *       mmap.sqlite                  consistent, integrity-checked database copy
 *     files/<ab>/<sha256>            attachment bytes, stored once per content and shared by all
 *                                    snapshots that need them
 *
 * Invariants:
 * - A snapshot folder appears under its final name only when complete: it is written as
 *   `snapshots/.partial-<random>` and renamed at the end. Listing ignores anything else.
 * - The attachment list comes from the database copy itself, so the files of a snapshot always
 *   match its database. Every file is checked against its recorded SHA-256 when stored; a file
 *   that is missing or changed in the workspace is counted and reported, never stored wrongly.
 * - Restoring verifies the database checksum and integrity and every file's checksum before the
 *   restored folder is used, and never writes to a path taken from the manifest without checking
 *   it (stored relative paths must have the attachment store's generated form).
 *
 * This module must not import `electron`, so it stays unit-testable on plain Node.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createVerifiedBackup,
  inspectDatabaseFile,
  LATEST_SCHEMA_VERSION,
} from '@mmap/storage-sqlite';
import { z } from 'zod';

import { TransferError } from '../portability/transfer-errors';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import {
  ATTACHMENTS_DIRECTORY_NAME,
  DATABASE_FILE_NAME,
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  RECOVERY_DIRECTORY_NAME,
  writeFileAtomically,
} from '../workspaces/workspace-folder';

export const BACKUP_FORMAT = 'mmap-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'backup.json';
const SNAPSHOTS = 'snapshots';
const FILES = 'files';

/** Generated attachment storage paths: a two-character shard, then the stored file name. */
const STORED_PATH = /^[a-z0-9]{2}\/[a-z0-9][a-z0-9-]{1,63}(\.[a-z0-9]{1,16})?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;

const manifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().positive(),
  snapshotId: z.string().regex(SNAPSHOT_ID),
  workspaceId: z.uuid(),
  workspaceName: z.string().max(200),
  createdAt: z.string().max(40),
  appVersion: z.string().max(100),
  schemaVersion: z.number().int().nonnegative(),
  database: z.strictObject({
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256),
  }),
  attachments: z
    .array(
      z.strictObject({
        relativePath: z.string().regex(STORED_PATH),
        sha256: z.string().regex(SHA256),
        byteSize: z.number().int().nonnegative(),
      }),
    )
    .max(1_000_000),
  missingAttachments: z.number().int().nonnegative(),
});

export type SnapshotManifest = z.infer<typeof manifestSchema>;

export interface SnapshotSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly workspaceName: string;
  readonly folder: string;
  readonly attachmentCount: number;
  /** Attachments whose file was missing or changed when the snapshot was taken. */
  readonly missingAttachments: number;
  readonly databaseBytes: number;
}

export function workspaceBackupFolder(destination: string, workspaceId: string): string {
  return join(destination, workspaceId);
}

/**
 * Takes a snapshot of the open workspace into `destination`.
 *
 * @throws TransferError `BACKUP_FAILED` (with the cause) when anything fails; no partial snapshot
 *   is left behind.
 */
export async function createSnapshot(
  workspace: OpenWorkspace,
  destination: string,
  options: { readonly appVersion: string; readonly now: () => Date },
): Promise<SnapshotSummary> {
  const root = workspaceBackupFolder(destination, workspace.id);
  const createdAt = options.now();
  const snapshotId = createdAt.toISOString().replace(/[:.]/gu, '-');
  const partial = join(root, SNAPSHOTS, `.partial-${randomUUID()}`);
  try {
    await mkdir(partial, { recursive: true });
    await mkdir(join(root, FILES), { recursive: true });
    const databasePath = join(partial, DATABASE_FILE_NAME);
    // The writer connection: writes made through it during the copy are part of the image,
    // so the backup never has to restart while the user keeps editing.
    await createVerifiedBackup(workspace.connections.writerConnection, databasePath);
    const contents = inspectDatabaseFile(databasePath);

    const attachments: SnapshotManifest['attachments'][number][] = [];
    let missing = 0;
    for (const attachment of contents.attachments) {
      if (!STORED_PATH.test(attachment.relativePath) || !SHA256.test(attachment.sha256)) {
        missing += 1;
        continue;
      }
      const source = await workspace.attachmentStore.resolveExisting(attachment.relativePath);
      if (source === null || !(await storeFile(root, source, attachment.sha256))) {
        missing += 1;
        continue;
      }
      attachments.push(attachment);
    }

    const database = await fileDigest(databasePath);
    const manifest: SnapshotManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      snapshotId,
      workspaceId: contents.workspaceId,
      workspaceName: contents.workspaceName,
      createdAt: createdAt.toISOString(),
      appVersion: options.appVersion,
      schemaVersion: contents.schemaVersion,
      database,
      attachments,
      missingAttachments: missing,
    };
    await writeFileAtomically(
      join(partial, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const finalFolder = join(root, SNAPSHOTS, snapshotId);
    await rename(partial, finalFolder);
    return summarize(manifest, finalFolder);
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw new TransferError('BACKUP_FAILED', describeWriteFailure(error), { cause: error });
  }
}

/** Snapshots of a workspace, newest first. Incomplete or damaged folders are skipped. */
export async function listSnapshots(
  destination: string,
  workspaceId: string,
): Promise<SnapshotSummary[]> {
  const folder = join(workspaceBackupFolder(destination, workspaceId), SNAPSHOTS);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }
  const summaries: SnapshotSummary[] = [];
  for (const name of names) {
    if (!SNAPSHOT_ID.test(name)) continue;
    try {
      const manifest = await readSnapshotManifest(join(folder, name));
      if (manifest.workspaceId === workspaceId)
        summaries.push(summarize(manifest, join(folder, name)));
    } catch {
      // Not a complete snapshot; never offered for restore.
    }
  }
  return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Reads and validates a snapshot's manifest. @throws TransferError `BACKUP_DAMAGED`. */
export async function readSnapshotManifest(snapshotFolder: string): Promise<SnapshotManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(snapshotFolder, MANIFEST_NAME), 'utf8'));
  } catch (error) {
    throw new TransferError('BACKUP_DAMAGED', 'This folder is not a complete mmap backup.', {
      cause: error,
    });
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new TransferError('BACKUP_DAMAGED', 'The backup description is damaged.');
  }
  if (result.data.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new TransferError(
      'ARCHIVE_TOO_NEW',
      'This backup was made by a newer version of mmap. Update mmap to restore it.',
    );
  }
  return result.data;
}

/**
 * Deletes the snapshots not in `keep`, then attachment files no remaining snapshot uses.
 * Failures to delete are ignored and retried on the next run.
 */
export async function pruneSnapshots(
  destination: string,
  workspaceId: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  const root = workspaceBackupFolder(destination, workspaceId);
  const snapshots = await listSnapshots(destination, workspaceId);
  for (const snapshot of snapshots) {
    if (!keep.has(snapshot.id)) {
      await rm(snapshot.folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  // Partial folders older than a day are leftovers of interrupted backups.
  const snapshotsFolder = join(root, SNAPSHOTS);
  for (const name of await readdir(snapshotsFolder).catch(() => [] as string[])) {
    if (!name.startsWith('.partial-')) continue;
    const info = await stat(join(snapshotsFolder, name)).catch(() => null);
    if (info !== null && Date.now() - info.mtimeMs > 86_400_000) {
      await rm(join(snapshotsFolder, name), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  const used = new Set<string>();
  for (const snapshot of await listSnapshots(destination, workspaceId)) {
    for (const attachment of (await readSnapshotManifest(snapshot.folder)).attachments) {
      used.add(attachment.sha256);
    }
  }
  const files = join(root, FILES);
  for (const shard of await readdir(files).catch(() => [] as string[])) {
    for (const name of await readdir(join(files, shard)).catch(() => [] as string[])) {
      if (SHA256.test(name) && !used.has(name)) {
        await rm(join(files, shard, name), { force: true }).catch(() => undefined);
      }
    }
  }
}

/**
 * Builds a complete workspace folder at `targetFolder` (which must not exist) from a snapshot,
 * verifying every byte. Removes the folder again on failure.
 *
 * @returns the workspace identity found in the restored database.
 * @throws TransferError `BACKUP_DAMAGED`, `ARCHIVE_TOO_NEW` or `RESTORE_FAILED`.
 */
export async function buildWorkspaceFromSnapshot(
  snapshotFolder: string,
  targetFolder: string,
  appVersion: string,
): Promise<{ readonly workspaceId: string; readonly workspaceName: string }> {
  const manifest = await readSnapshotManifest(snapshotFolder);
  if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new TransferError(
      'ARCHIVE_TOO_NEW',
      'This backup was made by a newer version of mmap. Update mmap to restore it.',
    );
  }
  const filesRoot = join(dirname(dirname(snapshotFolder)), FILES);
  try {
    await mkdir(targetFolder, { recursive: false });
  } catch (error) {
    throw new TransferError('RESTORE_FAILED', 'The restore folder could not be created.', {
      cause: error,
    });
  }
  try {
    await mkdir(join(targetFolder, ATTACHMENTS_DIRECTORY_NAME));
    await mkdir(join(targetFolder, RECOVERY_DIRECTORY_NAME));
    const databasePath = join(targetFolder, DATABASE_FILE_NAME);
    await copyVerified(
      join(snapshotFolder, DATABASE_FILE_NAME),
      databasePath,
      manifest.database.sha256,
    );
    let contents;
    try {
      contents = inspectDatabaseFile(databasePath);
    } catch (error) {
      throw damaged(error);
    }
    if (contents.workspaceId !== manifest.workspaceId) throw damaged();

    for (const attachment of manifest.attachments) {
      const target = join(
        targetFolder,
        ATTACHMENTS_DIRECTORY_NAME,
        ...attachment.relativePath.split('/'),
      );
      await mkdir(dirname(target), { recursive: true });
      await copyVerified(storedFilePath(filesRoot, attachment.sha256), target, attachment.sha256);
    }

    await writeFileAtomically(
      join(targetFolder, 'mmap-workspace.json'),
      `${JSON.stringify(
        {
          format: MANIFEST_FORMAT,
          formatVersion: MANIFEST_FORMAT_VERSION,
          workspaceId: manifest.workspaceId,
          createdAt: new Date().toISOString(),
          createdWithAppVersion: appVersion,
        },
        null,
        2,
      )}\n`,
    );
    return { workspaceId: manifest.workspaceId, workspaceName: contents.workspaceName };
  } catch (error) {
    await rm(targetFolder, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof TransferError) throw error;
    throw new TransferError('RESTORE_FAILED', describeWriteFailure(error), { cause: error });
  }
}

function summarize(manifest: SnapshotManifest, folder: string): SnapshotSummary {
  return {
    id: manifest.snapshotId,
    createdAt: manifest.createdAt,
    workspaceName: manifest.workspaceName,
    folder,
    attachmentCount: manifest.attachments.length,
    missingAttachments: manifest.missingAttachments,
    databaseBytes: manifest.database.byteSize,
  };
}

function storedFilePath(filesRoot: string, sha256: string): string {
  return join(filesRoot, sha256.slice(0, 2), sha256);
}

/**
 * Stores an attachment's bytes under its checksum, unless an intact copy is already there.
 * Returns false (storing nothing) when the source does not match `sha256`.
 */
async function storeFile(root: string, source: string, sha256: string): Promise<boolean> {
  const target = storedFilePath(join(root, FILES), sha256);
  if ((await fileDigest(target).catch(() => null))?.sha256 === sha256) return true;
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyVerified(source, target, sha256);
    return true;
  } catch (error) {
    if (error instanceof TransferError && error.code === 'BACKUP_DAMAGED') return false;
    throw error;
  }
}

/**
 * Copies `source` to `target` through a temporary file: copy, flush, verify the SHA-256, rename.
 * An existing target is replaced only by verified bytes.
 *
 * @throws TransferError `BACKUP_DAMAGED` when the bytes do not match `sha256`.
 */
async function copyVerified(source: string, target: string, sha256: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await fileDigest(temporary)).sha256 !== sha256) {
      throw new TransferError(
        'BACKUP_DAMAGED',
        'A file in the backup does not match its checksum.',
      );
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof TransferError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TransferError('BACKUP_DAMAGED', 'A file is missing from the backup.', {
        cause: error,
      });
    }
    throw error;
  }
}

async function fileDigest(path: string): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk: Buffer | string) => {
        hash.update(chunk);
        byteSize += chunk.length;
      })
      .on('end', resolve)
      .on('error', reject);
  });
  return { byteSize, sha256: hash.digest('hex') };
}

function damaged(cause?: unknown): TransferError {
  return new TransferError('BACKUP_DAMAGED', 'The backup database is damaged.', { cause });
}

function describeWriteFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC') return 'The backup failed: the disk is full.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'The backup failed: mmap is not allowed to write to the backup folder.';
  }
  if (code === 'ENOENT') return 'The backup failed: the backup folder or drive is not available.';
  if (error instanceof TransferError) return error.message;
  return 'The backup failed.';
}
