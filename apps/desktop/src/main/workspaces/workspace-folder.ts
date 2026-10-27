/**
 * Workspace folder layout and manifest (PRD §5.1: "A workspace folder contains a version
 * manifest, SQLite database, managed attachments directory, and recovery metadata").
 *
 *   <workspace>/
 *     mmap-workspace.json   manifest: format version and workspace ID (identity check)
 *     mmap.sqlite           database (+ -wal / -shm while open)
 *     attachments/          managed attachment copies (Phase 1, slice 5)
 *     recovery/             pre-migration backups and recovery metadata
 *     .lock                 process lock while the workspace is open
 *
 * The manifest exists so that "open folder" can tell a workspace from a random directory before
 * touching any database file, and so a folder copied elsewhere keeps its identity.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { WorkspaceError } from './workspace-errors';

export const MANIFEST_FILE_NAME = 'mmap-workspace.json';
export const DATABASE_FILE_NAME = 'mmap.sqlite';
export const ATTACHMENTS_DIRECTORY_NAME = 'attachments';
export const RECOVERY_DIRECTORY_NAME = 'recovery';
export const LOCK_FILE_NAME = '.lock';

export const MANIFEST_FORMAT = 'mmap-workspace';
export const MANIFEST_FORMAT_VERSION = 1;

const manifestSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  formatVersion: z.number().int().positive(),
  workspaceId: z.uuid({ version: 'v4' }).or(z.uuid()),
  createdAt: z.string(),
  createdWithAppVersion: z.string(),
});

export type WorkspaceManifest = z.infer<typeof manifestSchema>;

export interface WorkspacePaths {
  readonly folder: string;
  readonly manifest: string;
  readonly database: string;
  readonly attachments: string;
  readonly recovery: string;
  readonly lock: string;
}

export function workspacePaths(folder: string): WorkspacePaths {
  return {
    folder,
    manifest: join(folder, MANIFEST_FILE_NAME),
    database: join(folder, DATABASE_FILE_NAME),
    attachments: join(folder, ATTACHMENTS_DIRECTORY_NAME),
    recovery: join(folder, RECOVERY_DIRECTORY_NAME),
    lock: join(folder, LOCK_FILE_NAME),
  };
}

/**
 * Reads and validates the manifest of an existing workspace folder.
 *
 * @throws WorkspaceError `WORKSPACE_MISSING` when the folder is gone, `WORKSPACE_INVALID` when it
 *   is not an mmap workspace, `WORKSPACE_TOO_NEW` when a newer manifest format is found.
 */
export async function readManifest(folder: string): Promise<WorkspaceManifest> {
  const paths = workspacePaths(folder);
  let text: string;
  try {
    text = await readFile(paths.manifest, 'utf8');
  } catch (error) {
    if (isNotFound(error) && !(await directoryExists(folder))) {
      throw new WorkspaceError(
        'WORKSPACE_MISSING',
        `The workspace folder was not found: ${folder}`,
      );
    }
    throw new WorkspaceError(
      'WORKSPACE_INVALID',
      `This folder is not an mmap workspace (no ${MANIFEST_FILE_NAME}): ${folder}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'The workspace manifest is damaged.', {
      cause: error,
    });
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'The workspace manifest is damaged.');
  }
  if (result.data.formatVersion > MANIFEST_FORMAT_VERSION) {
    throw new WorkspaceError(
      'WORKSPACE_TOO_NEW',
      'This workspace was created by a newer version of mmap. Update mmap to open it.',
    );
  }
  return result.data;
}

/**
 * Creates the folder structure and manifest for a new workspace. The target folder must not
 * exist or must be empty, so an existing directory's files are never mixed with a workspace.
 *
 * @returns `createdFolder: true` when this call created the folder itself, so the caller knows it
 *   may delete the folder again if a later step of workspace creation fails.
 */
export async function createWorkspaceFolder(
  folder: string,
  manifest: WorkspaceManifest,
): Promise<{ readonly createdFolder: boolean }> {
  const existed = await directoryExists(folder);
  if (existed && (await readdir(folder)).length > 0) {
    throw new WorkspaceError(
      'WORKSPACE_FOLDER_NOT_EMPTY',
      `The folder already contains files. Choose an empty folder: ${folder}`,
    );
  }

  const paths = workspacePaths(folder);
  await mkdir(paths.attachments, { recursive: true });
  await mkdir(paths.recovery, { recursive: true });
  await writeFileAtomically(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { createdFolder: !existed };
}

/**
 * Writes a file via a temporary sibling and rename, so a crash never leaves a half-written file
 * (rename within one directory is atomic on NTFS and POSIX filesystems).
 */
export async function writeFileAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
