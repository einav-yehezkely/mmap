/**
 * Writes the lossless workspace archive (PRD §5.11, layout in `archive-format.ts`).
 *
 * 1. Read every record in one consistent snapshot.
 * 2. Check each attachment's managed file: it must exist and still match the checksum recorded
 *    when it was attached. A file that is missing or changed is left out (with its metadata) and
 *    reported, rather than exporting bytes the archive would then vouch for.
 * 3. Write manifest, data and attachment files to a temporary file and rename it into place.
 *
 * Only workspace data is exported: no lock, recovery folder, logs, app settings, search index or
 * derived references.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

import {
  ARCHIVE_DATA_PATH,
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_MANIFEST_PATH,
  archiveAttachmentPath,
  archiveCounts,
  toArchiveData,
  type ArchiveCounts,
  type ArchiveFileEntry,
  type ArchiveManifest,
  type WorkspaceSnapshot,
} from '@mmap/domain';

import type { OpenWorkspace } from '../workspaces/open-workspace';
import { NO_PROGRESS, type Progress } from '../operations/operation-progress';
import { ZipWriter } from './zip-writer';

export interface ExportResult {
  readonly counts: ArchiveCounts;
  readonly warnings: readonly string[];
}

export interface ExportOptions {
  readonly appVersion: string;
  readonly now: () => Date;
  readonly newId?: () => string;
}

/** @throws TransferError `TRANSFER_FAILED` when the archive cannot be written. */
export async function exportWorkspaceArchive(
  workspace: OpenWorkspace,
  destinationPath: string,
  options: ExportOptions,
  progress: Progress = NO_PROGRESS,
): Promise<ExportResult> {
  progress.phase('Reading the workspace', null);
  const snapshot = await workspace.services.snapshots.read(workspace.id);
  progress.checkCancelled();
  progress.phase('Checking attached files', snapshot.attachments.length);
  const { included, warnings } = await checkAttachmentFiles(workspace, snapshot, progress);
  const data = toArchiveData({
    ...snapshot,
    attachments: snapshot.attachments.filter((attachment) => included.has(attachment.id)),
  });
  const dataBytes = Buffer.from(JSON.stringify(data), 'utf8');

  const files: ArchiveFileEntry[] = [
    { path: ARCHIVE_DATA_PATH, byteSize: dataBytes.length, sha256: sha256Of(dataBytes) },
  ];
  for (const attachment of data.attachments) {
    files.push({
      path: archiveAttachmentPath(attachment.id),
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
    });
  }
  const exportedAt = options.now();
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportId: (options.newId ?? randomUUID)(),
    exportedAt: exportedAt.toISOString(),
    appVersion: options.appVersion,
    schemaVersion: workspace.schemaVersion,
    workspace: {
      id: snapshot.workspace.id,
      name: snapshot.workspace.name,
      timezone: snapshot.workspace.timezone,
    },
    counts: archiveCounts(data),
    files,
  };

  const zip = new ZipWriter(exportedAt);
  zip.addBuffer(ARCHIVE_MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  zip.addBuffer(ARCHIVE_DATA_PATH, dataBytes);
  for (const attachment of data.attachments) {
    zip.addFile(archiveAttachmentPath(attachment.id), included.get(attachment.id)!);
  }
  progress.phase(
    'Writing the archive',
    dataBytes.length + data.attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0),
  );
  await zip.writeTo(destinationPath, 'The export', progress);
  return { counts: manifest.counts, warnings };
}

/** Attachment ID → absolute path of each managed file that exists and matches its checksum. */
async function checkAttachmentFiles(
  workspace: OpenWorkspace,
  snapshot: WorkspaceSnapshot,
  progress: Progress,
): Promise<{ included: Map<string, string>; warnings: string[] }> {
  const included = new Map<string, string>();
  let missing = 0;
  let changed = 0;
  for (const attachment of snapshot.attachments) {
    progress.checkCancelled();
    progress.advance();
    const path = await workspace.attachmentStore.resolveExisting(attachment.relativePath);
    if (path === null) {
      missing += 1;
      continue;
    }
    if ((await hashFile(path)) !== attachment.sha256) {
      changed += 1;
      continue;
    }
    included.set(attachment.id, path);
  }
  const warnings: string[] = [];
  if (missing > 0) {
    warnings.push(
      `${missing === 1 ? '1 attachment was' : `${missing} attachments were`} not exported ` +
        'because the file is missing from the workspace folder.',
    );
  }
  if (changed > 0) {
    warnings.push(
      `${changed === 1 ? '1 attachment was' : `${changed} attachments were`} not exported ` +
        'because the file was changed outside mmap and no longer matches its checksum.',
    );
  }
  return { included, warnings };
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
