/**
 * Verified directory copy used to move a workspace to a new location (PRD §5.1: "Move only a
 * closed, checkpointed workspace through a verified copy. Preserve the original until the
 * destination opens successfully.").
 *
 * The workspace manager closes the workspace, calls `copyDirectoryVerified`, opens the copy and
 * only then recycles the original. This module therefore guarantees:
 * - A successful return means every included source file exists in the destination with the same
 *   relative path, size and SHA-256, and the destination contains nothing else (empty directories
 *   are recreated as well, so the copy has the same shape as the source).
 * - A failure after the destination folder was created removes that folder again, so no partial
 *   copy is ever left behind for the user to mistake for a complete workspace.
 * - The source is only ever read: it is scanned with `lstat`, copied from and hashed, never
 *   written, renamed or deleted.
 * - Symbolic links and junctions anywhere under the source are refused before anything is copied:
 *   following them could copy data from outside the workspace (or loop forever), and recreating
 *   them would make the copy depend on the original location.
 *
 * Durability: each copied file is fsynced. Directory entries are not fsynced because Windows has no
 * portable way to do so; the caller opens the copy before deleting the original, which is the
 * real safety net.
 *
 * This module must not import `electron`, so it stays unit-testable on plain Node.
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { isInsideDirectory } from '../security/resolve-renderer-asset';

export type WorkspaceCopyErrorCode =
  | 'SOURCE_HAS_LINKS'
  | 'DESTINATION_EXISTS'
  | 'DESTINATION_INSIDE_SOURCE'
  | 'DISK_FULL'
  | 'PERMISSION_DENIED'
  | 'VERIFICATION_FAILED'
  | 'IO_ERROR';

/**
 * Expected workspace copy failures. Messages are English and safe to show to the user; they never
 * contain file contents.
 */
export class WorkspaceCopyError extends Error {
  public constructor(
    public readonly code: WorkspaceCopyErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceCopyError';
  }
}

export interface CopyOptions {
  /** Return true to skip an entry. `relativePath` uses forward slashes, relative to the source root. */
  readonly exclude?: (relativePath: string, isDirectory: boolean) => boolean;
  /** Optional progress callback in bytes (copied so far, total to copy). */
  readonly onProgress?: (copiedBytes: number, totalBytes: number) => void;
}

export interface CopyResult {
  readonly fileCount: number;
  readonly byteCount: number;
}

/** A regular file found while scanning the source, as expected in the destination. */
export interface ScannedFile {
  /** Forward-slash path relative to the tree root. */
  readonly relativePath: string;
  readonly byteSize: number;
}

type EntryKind = 'file' | 'directory' | 'link' | 'other';

interface TreeEntry {
  readonly relativePath: string;
  readonly kind: EntryKind;
  readonly byteSize: number;
}

interface SourcePlan {
  /** Included directories in pre-order (parents before children), so they can be created in order. */
  readonly directories: readonly string[];
  readonly files: readonly ScannedFile[];
  readonly totalBytes: number;
}

/**
 * Copies `source` to the new folder `destination` and verifies the result.
 *
 * 1. Validate: source is an existing directory; destination does not exist; destination not
 *    inside source (checked lexically and after resolving links, case-insensitively where file
 *    systems usually are).
 * 2. Scan the source tree with `lstat`, never following links. Any symbolic link or junction →
 *    `SOURCE_HAS_LINKS`; other non-regular entries (sockets, devices…) that are not excluded →
 *    `IO_ERROR`.
 * 3. Create the destination folder (its parent must already exist), its directories, and copy each
 *    file with `COPYFILE_EXCL`, fsyncing it afterwards.
 * 4. Verify with `verifyCopy`.
 * 5. On any failure after step 3 started, remove the destination folder (created by this call)
 *    and throw the mapped `WorkspaceCopyError`. The source is never touched.
 *
 * Progress is reported once before copying and after each file; large single files do not report
 * intermediate progress.
 */
export async function copyDirectoryVerified(
  source: string,
  destination: string,
  options?: CopyOptions,
): Promise<CopyResult> {
  const sourceRoot = resolve(source);
  const destinationRoot = resolve(destination);

  await validateLocations(sourceRoot, destinationRoot);
  const plan = await withMappedErrors(() => planSourceCopy(sourceRoot, options?.exclude));

  try {
    await mkdir(destinationRoot);
  } catch (error) {
    // Lost a race with another process creating the same folder: it is not ours to remove.
    throw errorCode(error) === 'EEXIST' ? destinationExists(error) : toCopyError(error);
  }

  try {
    await withMappedErrors(() => copyPlan(sourceRoot, destinationRoot, plan, options?.onProgress));
    await withMappedErrors(() => verifyCopy(sourceRoot, destinationRoot, plan.files));
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true, maxRetries: 3 }).catch(
      () => undefined,
    );
    throw error;
  }

  return { fileCount: plan.files.length, byteCount: plan.totalBytes };
}

/**
 * Re-scans `destination` and checks that it contains exactly the regular files in `files` (no
 * links, no special entries, no extra files), each with the expected size and the same SHA-256 as
 * the corresponding file under `source`. Exported for tests.
 *
 * @throws WorkspaceCopyError `VERIFICATION_FAILED` on any difference.
 */
export async function verifyCopy(
  source: string,
  destination: string,
  files: readonly ScannedFile[],
): Promise<void> {
  const entries = await walkTree(resolve(destination), undefined);
  const found = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === 'file') {
      found.set(entry.relativePath, entry.byteSize);
    } else if (entry.kind !== 'directory') {
      throw verificationFailed();
    }
  }
  if (found.size !== files.length) {
    throw verificationFailed();
  }
  for (const file of files) {
    if (found.get(file.relativePath) !== file.byteSize) {
      throw verificationFailed();
    }
  }
  for (const file of files) {
    const [expected, actual] = await Promise.all([
      hashFile(resolve(source, ...file.relativePath.split('/'))),
      hashFile(resolve(destination, ...file.relativePath.split('/'))),
    ]);
    if (expected !== actual) {
      throw verificationFailed();
    }
  }
}

/**
 * Checks the source and destination locations before anything is written. The containment check
 * runs first so that a destination equal to the source is reported as such rather than as
 * "already exists". It is repeated on real paths so that a junction in the destination's parent
 * chain cannot smuggle the copy into the source.
 */
async function validateLocations(sourceRoot: string, destinationRoot: string): Promise<void> {
  if (isSameOrInside(sourceRoot, destinationRoot)) {
    throw destinationInsideSource();
  }

  const sourceInfo = await withMappedErrors(() => lstat(sourceRoot));
  if (sourceInfo.isSymbolicLink()) {
    throw sourceHasLinks();
  }
  if (!sourceInfo.isDirectory()) {
    throw new WorkspaceCopyError('IO_ERROR', 'The workspace folder to copy is not a folder.');
  }

  let realSource: string;
  let realParent: string;
  try {
    [realSource, realParent] = await Promise.all([
      realpath(sourceRoot),
      realpath(dirname(destinationRoot)),
    ]);
  } catch (error) {
    throw toCopyError(error);
  }
  if (isSameOrInside(realSource, join(realParent, basename(destinationRoot)))) {
    throw destinationInsideSource();
  }

  if ((await withMappedErrors(() => lstatOrNull(destinationRoot))) !== null) {
    throw destinationExists();
  }
}

/**
 * Containment check for absolute paths. Comparison is case-insensitive on Windows and macOS,
 * whose default file systems ignore case; on a case-sensitive macOS volume this can only refuse a
 * harmless destination, never allow a dangerous one.
 */
function isSameOrInside(root: string, candidate: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return isInsideDirectory(root.toLowerCase(), candidate.toLowerCase());
  }
  return isInsideDirectory(root, candidate);
}

/** Scans the source and turns it into the list of directories and files to copy. */
async function planSourceCopy(
  sourceRoot: string,
  exclude: CopyOptions['exclude'],
): Promise<SourcePlan> {
  const entries = await walkTree(sourceRoot, exclude);
  const directories: string[] = [];
  const files: ScannedFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.kind === 'link') {
      throw sourceHasLinks();
    }
    if (entry.kind === 'other') {
      throw new WorkspaceCopyError(
        'IO_ERROR',
        'The workspace folder contains an item that is neither a file nor a folder.',
      );
    }
    if (entry.kind === 'directory') {
      directories.push(entry.relativePath);
    } else {
      files.push({ relativePath: entry.relativePath, byteSize: entry.byteSize });
      totalBytes += entry.byteSize;
    }
  }
  return { directories, files, totalBytes };
}

/**
 * Lists every entry below `root` in pre-order without following links (lstat reports Windows
 * junctions as symbolic links, never as directories). Names are sorted for a deterministic order.
 *
 * Links are always reported, even where `exclude` would skip them: deciding whether a link is a
 * "directory" for the callback would require following it, and the source must be link-free anyway.
 * Excluded directories are not descended into.
 */
async function walkTree(
  root: string,
  exclude: CopyOptions['exclude'],
  prefix = '',
  entries: TreeEntry[] = [],
): Promise<TreeEntry[]> {
  const directory = prefix === '' ? root : join(root, ...prefix.split('/'));
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const relativePath = prefix === '' ? name : `${prefix}/${name}`;
    const info = await lstat(join(directory, name));
    const kind = entryKind(info);
    if (kind !== 'link' && exclude?.(relativePath, kind === 'directory') === true) {
      continue;
    }
    entries.push({ relativePath, kind, byteSize: kind === 'file' ? info.size : 0 });
    if (kind === 'directory') {
      await walkTree(root, exclude, relativePath, entries);
    }
  }
  return entries;
}

function entryKind(info: Stats): EntryKind {
  if (info.isSymbolicLink()) {
    return 'link';
  }
  if (info.isDirectory()) {
    return 'directory';
  }
  return info.isFile() ? 'file' : 'other';
}

/**
 * Creates the planned directories and copies the planned files into the (new, empty) destination.
 * `COPYFILE_EXCL` guarantees nothing is overwritten even if something else writes there.
 */
async function copyPlan(
  sourceRoot: string,
  destinationRoot: string,
  plan: SourcePlan,
  onProgress: CopyOptions['onProgress'],
): Promise<void> {
  for (const directory of plan.directories) {
    await mkdir(join(destinationRoot, ...directory.split('/')));
  }
  let copiedBytes = 0;
  onProgress?.(copiedBytes, plan.totalBytes);
  for (const file of plan.files) {
    const segments = file.relativePath.split('/');
    const target = join(destinationRoot, ...segments);
    await copyFile(join(sourceRoot, ...segments), target, constants.COPYFILE_EXCL);
    await syncFile(target);
    copiedBytes += file.byteSize;
    onProgress?.(copiedBytes, plan.totalBytes);
  }
}

/**
 * Flushes a copied file to disk. Windows needs write access to flush, and `copyFile` carries over
 * the read-only attribute, so a read-only copy is made writable for the flush and restored after.
 */
async function syncFile(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r+');
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }
    const { mode } = await lstat(path);
    if ((mode & 0o200) !== 0) {
      throw error;
    }
    await chmod(path, mode | 0o200);
    try {
      await syncFile(path);
    } finally {
      await chmod(path, mode);
    }
    return;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Streams a file from disk and returns its lowercase hex SHA-256. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Runs an operation and converts whatever it throws into a `WorkspaceCopyError`. */
async function withMappedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toCopyError(error);
  }
}

const DISK_FULL_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT']);
const PERMISSION_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM']);

/** Maps Node error codes; errors already classified by this module pass through unchanged. */
function toCopyError(error: unknown): WorkspaceCopyError {
  if (error instanceof WorkspaceCopyError) {
    return error;
  }
  const code = errorCode(error) ?? '';
  if (DISK_FULL_CODES.has(code)) {
    return new WorkspaceCopyError(
      'DISK_FULL',
      'There is not enough disk space to copy the workspace. Free some space and try again.',
      { cause: error },
    );
  }
  if (PERMISSION_CODES.has(code)) {
    return new WorkspaceCopyError(
      'PERMISSION_DENIED',
      'mmap does not have permission to read the workspace or write to the chosen location.',
      { cause: error },
    );
  }
  return new WorkspaceCopyError(
    'IO_ERROR',
    'The workspace could not be copied. Check that the chosen location exists and try again.',
    { cause: error },
  );
}

function sourceHasLinks(): WorkspaceCopyError {
  return new WorkspaceCopyError(
    'SOURCE_HAS_LINKS',
    'The workspace folder contains a shortcut link (symbolic link or junction) and cannot be ' +
      'copied safely. Remove the link and try again.',
  );
}

function destinationExists(cause?: unknown): WorkspaceCopyError {
  return new WorkspaceCopyError(
    'DESTINATION_EXISTS',
    'A file or folder with that name already exists at the chosen location.',
    { cause },
  );
}

function destinationInsideSource(): WorkspaceCopyError {
  return new WorkspaceCopyError(
    'DESTINATION_INSIDE_SOURCE',
    'A workspace cannot be copied into itself. Choose a location outside the workspace folder.',
  );
}

function verificationFailed(): WorkspaceCopyError {
  return new WorkspaceCopyError(
    'VERIFICATION_FAILED',
    'The copied workspace does not match the original. The original was left unchanged.',
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
