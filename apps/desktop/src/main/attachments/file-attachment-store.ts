/**
 * Filesystem side of managed attachments (PRD §5.10, §8, §9).
 *
 * Layout inside the workspace's `attachments/` folder:
 *
 *   attachments/
 *     .staging/<id>.tmp      copies in progress (never referenced by the database)
 *     3f/3f2c…a1.pdf          committed copies, sharded by the first two characters of the ID
 *
 * Invariants:
 * - Source files are only ever opened for reading; moving or deleting them later cannot affect
 *   the managed copy, which is an independent file with a generated name.
 * - A file appears outside `.staging` only after it was fully written, fsynced and its checksum
 *   re-verified, and the move into place is a same-volume rename (atomic on NTFS and POSIX).
 *   The caller commits the database row afterwards; a crash in between leaves an orphan that
 *   `reconcile` removes on the next startup.
 * - Relative paths read back from the database are treated as untrusted: they are validated
 *   lexically and again after resolving symlinks/junctions before any file is served or deleted.
 *
 * File-type policy (executables, size limits) is decided by the caller with `classifyAttachment`
 * from `@mmap/domain`; this module only enforces the byte limit while copying, because the source
 * can grow between that check and the copy.
 *
 * This module must not import `electron`, so it stays unit-testable on plain Node.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { isInsideDirectory } from '../security/resolve-renderer-asset';

export type AttachmentStoreErrorCode =
  | 'NOT_A_FILE'
  | 'SOURCE_UNREADABLE'
  | 'TOO_LARGE'
  | 'SOURCE_CHANGED'
  | 'CHECKSUM_MISMATCH'
  | 'DISK_FULL'
  | 'PERMISSION_DENIED';

/**
 * Expected attachment storage failures. Messages are English and safe to show to the user; they
 * never contain file contents.
 */
export class AttachmentStoreError extends Error {
  public constructor(
    public readonly code: AttachmentStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AttachmentStoreError';
  }
}

export interface StoredAttachmentFile {
  /** POSIX-style path relative to the attachments directory, e.g. `3f/3f2c…a1.pdf`. */
  readonly relativePath: string;
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  readonly sha256: string;
}

export interface ReconcileReport {
  /** Relative paths of files deleted because no database row references them. */
  readonly removedOrphans: readonly string[];
  /**
   * Known relative paths whose file is missing on disk (reported, never "fixed" by deleting
   * rows).
   */
  readonly missingFiles: readonly string[];
  /** Orphans that could not be deleted now (e.g. locked by another program); retried next time. */
  readonly failedRemovals: readonly string[];
}

/** Folder for in-progress copies; everything in it is disposable. */
const STAGING_DIRECTORY_NAME = '.staging';
const STAGING_SUFFIX = '.tmp';
const COPY_CHUNK_BYTES = 256 * 1024;
const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;
/** Generated IDs become file names, so they are restricted to a portable, case-stable alphabet. */
const STORAGE_ID_PATTERN = /^[a-z0-9]{2}[a-z0-9-]{0,62}$/;
const MAX_RELATIVE_PATH_LENGTH = 512;

export class FileAttachmentStore {
  private readonly root: string;
  private readonly newId: () => string;

  /**
   * `attachmentsDirectory` is the workspace's `attachments/` folder (it exists). `newId` defaults
   * to `crypto.randomUUID`.
   */
  public constructor(attachmentsDirectory: string, options?: { newId?: () => string }) {
    this.root = resolve(attachmentsDirectory);
    this.newId = options?.newId ?? randomUUID;
  }

  /**
   * Reads up to `count` leading bytes of the source (for type sniffing).
   *
   * @throws AttachmentStoreError `NOT_A_FILE` / `SOURCE_UNREADABLE`.
   */
  public async readLeadingBytes(sourcePath: string, count: number): Promise<Uint8Array> {
    const handle = await openSource(sourcePath);
    try {
      await sourceSize(handle);
      const buffer = Buffer.alloc(Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0);
      let filled = 0;
      while (filled < buffer.length) {
        const bytesRead = await readSource(handle, buffer, filled, buffer.length - filled);
        if (bytesRead === 0) {
          break;
        }
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } finally {
      await closeQuietly(handle);
    }
  }

  /**
   * Returns the source's size in bytes after checking it is a regular file. Symlinks are followed
   * here on purpose: the user chose this file.
   */
  public async statSource(sourcePath: string): Promise<{ byteSize: number }> {
    let info;
    try {
      info = await stat(sourcePath);
    } catch (error) {
      throw toSourceError(error);
    }
    if (!info.isFile()) {
      throw notAFile();
    }
    return { byteSize: info.size };
  }

  /**
   * Copies `sourcePath` into the store: stage, fsync, verify size and checksum, then rename into
   * its shard directory. On any failure the staged/partial file is removed and the source is never
   * modified. `extension` is lowercase without dot; anything not matching /^[a-z0-9]{1,16}$/ is
   * omitted from the stored name.
   */
  public async importFile(
    sourcePath: string,
    extension: string | null,
    maxBytes: number,
  ): Promise<StoredAttachmentFile> {
    const source = await openSource(sourcePath);
    let stagedPath: string | null = null;
    try {
      const expectedSize = await sourceSize(source);
      if (expectedSize > maxBytes) {
        throw tooLarge();
      }

      // The ID is generated after the source was opened and measured; tests rely on this order
      // to simulate a source that changes during the copy.
      const id = this.generateId();
      const shard = id.slice(0, 2);
      const fileName =
        extension !== null && EXTENSION_PATTERN.test(extension) ? `${id}.${extension}` : id;

      const stagingDirectory = await this.ensureContainedDirectory(STAGING_DIRECTORY_NAME);
      const target = join(stagingDirectory, `${id}${STAGING_SUFFIX}`);
      const copied = await copyIntoStaging(source, target, maxBytes);
      stagedPath = target;

      if (copied.byteSize !== expectedSize) {
        throw new AttachmentStoreError(
          'SOURCE_CHANGED',
          'The file changed while it was being copied. Wait until it is no longer being edited ' +
            'and try again.',
        );
      }
      if ((await hashFile(stagedPath)) !== copied.sha256) {
        throw new AttachmentStoreError(
          'CHECKSUM_MISMATCH',
          'The copied file could not be verified. Check the disk for errors and try again.',
        );
      }

      const shardDirectory = await this.ensureContainedDirectory(shard);
      const finalPath = join(shardDirectory, fileName);
      await assertAbsent(finalPath);
      await withDestinationErrors(() => rename(target, finalPath));
      stagedPath = null;

      return {
        relativePath: `${shard}/${fileName}`,
        byteSize: copied.byteSize,
        sha256: copied.sha256,
      };
    } catch (error) {
      if (stagedPath !== null) {
        await rm(stagedPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      await closeQuietly(source);
    }
  }

  /**
   * Absolute (real) path of a stored file, or null if it is missing or the path is not acceptable.
   *
   * Security: `relativePath` comes from the database, which may have been tampered with. It is
   * validated lexically (see `toSafeSegments`), then the resolved path must stay inside the
   * attachments directory both lexically and after `realpath` (symlink/junction escape), must not
   * point into `.staging`, and must be a regular file.
   */
  public async resolveExisting(relativePath: string): Promise<string | null> {
    const lexicalPath = this.lexicalPath(relativePath);
    if (lexicalPath === null) {
      return null;
    }
    let realRoot: string;
    let realPath: string;
    try {
      [realRoot, realPath] = await Promise.all([realpath(this.root), realpath(lexicalPath)]);
    } catch {
      return null;
    }
    if (!isStorableLocation(realRoot, realPath)) {
      return null;
    }
    try {
      return (await stat(realPath)).isFile() ? realPath : null;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a stored file; idempotent (a missing file is fine). Invalid paths are a no-op.
   *
   * Only the final entry is removed, never what a symlink points to, and only when its parent
   * directory really lies inside the store: a junctioned shard folder pointing elsewhere must not
   * let a tampered row delete files outside the workspace. Directories are never deleted here.
   */
  public async remove(relativePath: string): Promise<void> {
    const lexicalPath = this.lexicalPath(relativePath);
    if (lexicalPath === null) {
      return;
    }
    let realRoot: string;
    let realParent: string;
    try {
      [realRoot, realParent] = await Promise.all([
        realpath(this.root),
        realpath(dirname(lexicalPath)),
      ]);
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    if (!isInsideDirectory(realRoot, realParent) || isInStaging(realRoot, realParent)) {
      return;
    }
    const entry = join(realParent, basename(lexicalPath));
    const info = await lstatOrNull(entry);
    if (info === null || info.isDirectory()) {
      return;
    }
    try {
      await unlink(entry);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  /**
   * Startup reconciliation for interrupted operations. Must run before any import starts, because
   * it discards everything under `.staging`.
   *
   * - Deletes all staging leftovers.
   * - Walks the store without following symlinks/junctions and deletes entries whose POSIX
   *   relative path is not in `knownRelativePaths` (a link is deleted itself, never its target).
   * - Removes two-character shard directories left empty.
   * - Reports known paths whose file is missing; the rows are left for the caller to surface.
   * Deletion failures (for example a file locked by another program) are collected in
   * `failedRemovals` and retried on the next run.
   */
  public async reconcile(knownRelativePaths: ReadonlySet<string>): Promise<ReconcileReport> {
    const removedOrphans: string[] = [];
    const failedRemovals: string[] = [];

    await removeTreeWithoutFollowing(
      join(this.root, STAGING_DIRECTORY_NAME),
      STAGING_DIRECTORY_NAME,
      failedRemovals,
    );
    await this.removeOrphans(this.root, '', knownRelativePaths, removedOrphans, failedRemovals);

    const missingFiles: string[] = [];
    for (const known of knownRelativePaths) {
      if ((await this.resolveExisting(known)) === null) {
        missingFiles.push(known);
      }
    }

    return {
      removedOrphans: removedOrphans.sort(),
      missingFiles: missingFiles.sort(),
      failedRemovals: failedRemovals.sort(),
    };
  }

  private async removeOrphans(
    directory: string,
    prefix: string,
    known: ReadonlySet<string>,
    removed: string[],
    failed: string[],
  ): Promise<void> {
    const names = await readdirOrEmpty(directory);
    for (const name of names) {
      if (prefix === '' && name === STAGING_DIRECTORY_NAME) {
        continue;
      }
      const relativePath = prefix === '' ? name : `${prefix}/${name}`;
      const absolutePath = join(directory, name);
      const info = await lstatOrNull(absolutePath);
      if (info === null) {
        continue;
      }
      // lstat reports symlinks and junctions as links, never as directories, so they are not
      // descended into.
      if (info.isDirectory()) {
        await this.removeOrphans(absolutePath, relativePath, known, removed, failed);
        if (prefix === '' && name.length === 2) {
          await rmdir(absolutePath).catch(() => undefined); // Fails harmlessly unless empty.
        }
        continue;
      }
      if (known.has(relativePath)) {
        continue;
      }
      const outcome = await unlinkEntry(absolutePath);
      if (outcome === 'removed') {
        removed.push(relativePath);
      } else if (outcome === 'failed') {
        failed.push(relativePath);
      }
    }
  }

  /** Lexically validated absolute path inside the store, or null for unacceptable input. */
  private lexicalPath(relativePath: string): string | null {
    const segments = toSafeSegments(relativePath);
    if (segments === null) {
      return null;
    }
    const candidate = resolve(join(this.root, ...segments));
    return isInsideDirectory(this.root, candidate) && candidate !== this.root ? candidate : null;
  }

  private generateId(): string {
    const id = this.newId().toLowerCase();
    if (!STORAGE_ID_PATTERN.test(id)) {
      throw new Error('The attachment ID generator returned an unusable file name.');
    }
    return id;
  }

  /**
   * Creates `<root>/<name>` if needed and returns its real path, refusing to write through a
   * symlink or junction that leads outside the store.
   */
  private async ensureContainedDirectory(name: string): Promise<string> {
    const directory = join(this.root, name);
    await withDestinationErrors(() => mkdir(directory, { recursive: true }));
    const [realRoot, realDirectory] = await Promise.all([realpath(this.root), realpath(directory)]);
    if (!isInsideDirectory(realRoot, realDirectory) || realDirectory === realRoot) {
      throw new AttachmentStoreError(
        'PERMISSION_DENIED',
        'The attachments folder contains a link that points outside the workspace.',
      );
    }
    return realDirectory;
  }
}

/**
 * Splits a database-provided relative path into segments, or returns null when it is not a plain
 * relative POSIX path. Rejected: empty input, NUL, backslashes, colons (drive letters and NTFS
 * alternate data streams), leading `/`, empty/`.`/`..` segments, segments ending in a dot or space
 * (Windows silently strips those, which would defeat name comparisons) and the staging folder.
 */
function toSafeSegments(relativePath: string): readonly string[] | null {
  if (relativePath.length === 0 || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
    return null;
  }
  if (/[\0\\:]/.test(relativePath) || relativePath.startsWith('/')) {
    return null;
  }
  const segments = relativePath.split('/');
  const unsafe = segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment),
  );
  if (unsafe || segments[0]?.toLowerCase() === STAGING_DIRECTORY_NAME) {
    return null;
  }
  return segments;
}

/** True when `realPath` is inside the real store root and not inside its staging folder. */
function isStorableLocation(realRoot: string, realPath: string): boolean {
  return isInsideDirectory(realRoot, realPath) && !isInStaging(realRoot, realPath);
}

function isInStaging(realRoot: string, realPath: string): boolean {
  return isInsideDirectory(join(realRoot, STAGING_DIRECTORY_NAME), realPath);
}

/**
 * Stream-copies the open source into a new staging file (`wx`: never overwrite), hashing while
 * copying and stopping as soon as more than `maxBytes` were read. The staged file is fsynced and
 * closed on success, and removed on failure.
 */
async function copyIntoStaging(
  source: FileHandle,
  stagedPath: string,
  maxBytes: number,
): Promise<{ byteSize: number; sha256: string }> {
  const destination = await withDestinationErrors(() => open(stagedPath, 'wx'));
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let byteSize = 0;
    for (;;) {
      const bytesRead = await readSource(source, buffer, 0, buffer.length);
      if (bytesRead === 0) {
        break;
      }
      byteSize += bytesRead;
      if (byteSize > maxBytes) {
        throw tooLarge();
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeFully(destination, chunk);
    }
    await withDestinationErrors(() => destination.sync());
    await withDestinationErrors(() => destination.close());
    return { byteSize, sha256: hash.digest('hex') };
  } catch (error) {
    await closeQuietly(destination);
    await rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeFully(destination: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await withDestinationErrors(() =>
      destination.write(chunk, offset, chunk.length - offset),
    );
    offset += bytesWritten;
  }
}

/** Re-reads a file from disk and returns its lowercase hex SHA-256. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Guards against overwriting an existing stored file (rename replaces targets on Windows). */
async function assertAbsent(path: string): Promise<void> {
  if ((await lstatOrNull(path)) !== null) {
    throw new Error('An attachment with the generated storage name already exists.');
  }
}

async function openSource(sourcePath: string): Promise<FileHandle> {
  try {
    return await open(sourcePath, 'r');
  } catch (error) {
    throw toSourceError(error);
  }
}

/** Size of an opened source after checking that it is a regular file. */
async function sourceSize(handle: FileHandle): Promise<number> {
  let info;
  try {
    info = await handle.stat();
  } catch (error) {
    throw toSourceError(error);
  }
  if (!info.isFile()) {
    throw notAFile();
  }
  return info.size;
}

async function readSource(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
): Promise<number> {
  try {
    return (await handle.read(buffer, offset, length, null)).bytesRead;
  } catch (error) {
    throw toSourceError(error);
  }
}

/** Runs a write-side operation inside the workspace, mapping disk-full and permission errors. */
async function withDestinationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDestinationError(error);
  }
}

function toSourceError(error: unknown): AttachmentStoreError {
  if (error instanceof AttachmentStoreError) {
    return error;
  }
  if (errorCode(error) === 'EISDIR') {
    return notAFile(error);
  }
  return new AttachmentStoreError(
    'SOURCE_UNREADABLE',
    'The selected file could not be read. It may have been moved, deleted or be in use.',
    { cause: error },
  );
}

const DISK_FULL_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT']);
const PERMISSION_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Maps disk-full and permission errors; anything else is unexpected and passed through as is. */
function toDestinationError(error: unknown): unknown {
  const code = errorCode(error) ?? '';
  if (DISK_FULL_CODES.has(code)) {
    return new AttachmentStoreError(
      'DISK_FULL',
      'There is not enough disk space to store the attachment. Free some space and try again.',
      { cause: error },
    );
  }
  if (PERMISSION_CODES.has(code)) {
    return new AttachmentStoreError(
      'PERMISSION_DENIED',
      'mmap does not have permission to write to the workspace attachments folder.',
      { cause: error },
    );
  }
  return error;
}

function notAFile(cause?: unknown): AttachmentStoreError {
  return new AttachmentStoreError('NOT_A_FILE', 'Only regular files can be attached.', { cause });
}

function tooLarge(): AttachmentStoreError {
  return new AttachmentStoreError(
    'TOO_LARGE',
    'The file is larger than the attachment size limit.',
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function readdirOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Deletes one non-directory entry (file or link). Missing entries count as neither outcome. */
async function unlinkEntry(path: string): Promise<'removed' | 'missing' | 'failed'> {
  try {
    await unlink(path);
    return 'removed';
  } catch (error) {
    return isMissing(error) ? 'missing' : 'failed';
  }
}

/**
 * Deletes `path` and, if it is a real directory, everything below it, without ever following a
 * symlink or junction (a link is unlinked itself). Entries that cannot be deleted are recorded in
 * `failed` by POSIX relative path instead of throwing.
 */
async function removeTreeWithoutFollowing(
  path: string,
  relativePath: string,
  failed: string[],
): Promise<void> {
  const info = await lstatOrNull(path);
  if (info === null) {
    return;
  }
  if (!info.isDirectory()) {
    if ((await unlinkEntry(path)) === 'failed') {
      failed.push(relativePath);
    }
    return;
  }
  for (const name of await readdirOrEmpty(path)) {
    await removeTreeWithoutFollowing(join(path, name), `${relativePath}/${name}`, failed);
  }
  await rmdir(path).catch(() => undefined); // Not empty only when a removal above failed.
}
