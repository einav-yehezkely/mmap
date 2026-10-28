/**
 * Imports a workspace archive (PRD §5.11) in two steps.
 *
 * `prepareImport` validates the whole package before anything changes:
 * 1. The ZIP's central directory: size and count limits, safe names, no links or encrypted
 *    entries (`ZipReader`).
 * 2. The layout: only `manifest.json`, `data/workspace.json` and `attachments/<uuid>` entries, each
 *    listed in the manifest with its size and checksum, nothing missing and nothing extra.
 * 3. The manifest and data schemas, the data file's checksum, and the counts.
 * 4. Each attachment against the attachment policy, using its actual leading bytes: executables
 *    and oversized files are left out with a warning (the note then shows them as missing).
 * 5. The import plan (`planImport`): consistency, new IDs, rewritten references, merged labels.
 * It also reports earlier imports of the same archive, so the user is warned before a duplicate.
 *
 * Both report progress; cancelling is possible until the records are written (the last step).
 *
 * `applyImport` then copies each attachment out of the archive into a temporary folder, checks
 * its bytes against the recorded checksum, stores it with the attachment store (which verifies
 * again and only then moves it into place), and writes every record in one transaction (in the
 * app, in a worker thread: see `import-writer.ts`). If
 * anything fails, the files stored so far are removed: nothing of the import stays visible, and
 * completion is reported only after all files and records are in place. A crash in between
 * leaves only unreferenced files, which startup reconciliation removes.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_ATTACHMENTS_DIRECTORY,
  ARCHIVE_DATA_PATH,
  ARCHIVE_MANIFEST_PATH,
  archiveAttachmentPath,
  archiveCounts,
  classifyAttachment,
  isCanonicalUuid,
  planImport,
  SNIFF_BYTES,
  type ApprovedAttachment,
  type ArchiveCounts,
  type ArchiveData,
  type ArchiveManifest,
  type AttachmentId,
  type IdGenerator,
  type ImportPlan,
  type ImportRecord,
} from '@mmap/domain';

import { describeRejection, extensionOf } from '../services/attachment-ipc-services';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { parseArchiveData, parseArchiveManifest } from './archive-schema';
import { writeImportInProcess, type ImportRecordWriter } from './import-writer';
import { NO_PROGRESS, type Progress } from '../operations/operation-progress';
import { toWriteError, TransferError } from './transfer-errors';
import { ZipReader, type ZipLimits } from './zip-reader';

export const IMPORT_LIMITS: ZipLimits & {
  readonly maxManifestBytes: number;
  readonly maxDataBytes: number;
} = {
  maxArchiveBytes: 4 * 1024 ** 3,
  maxEntries: 200_000,
  maxTotalUncompressedBytes: 8 * 1024 ** 3,
  maxManifestBytes: 64 * 1024 ** 2,
  maxDataBytes: 256 * 1024 ** 2,
};

export interface PreparedImport {
  readonly workspaceId: string;
  readonly manifest: ArchiveManifest;
  readonly plan: ImportPlan;
  readonly warnings: readonly string[];
  readonly earlierImports: readonly ImportRecord[];
  /** Kept open between preview and apply, so the archive cannot be swapped in between. */
  readonly reader: ZipReader;
  readonly maxAttachmentBytes: number;
}

export interface PrepareOptions {
  readonly ids: IdGenerator;
  readonly maxAttachmentBytes: number;
  readonly limits?: typeof IMPORT_LIMITS;
  readonly progress?: Progress;
}

/**
 * Validates `archivePath` and plans its import into `workspace`. Nothing is written.
 *
 * @throws TransferError for archive problems, DomainError `VALIDATION_FAILED` for inconsistent
 *   data.
 */
export async function prepareImport(
  workspace: OpenWorkspace,
  archivePath: string,
  options: PrepareOptions,
): Promise<PreparedImport> {
  const limits = options.limits ?? IMPORT_LIMITS;
  const progress = options.progress ?? NO_PROGRESS;
  progress.phase('Reading the archive', null);
  const reader = await ZipReader.open(archivePath, limits);
  try {
    const manifest = parseArchiveManifest(
      parseJson(await reader.readEntry(ARCHIVE_MANIFEST_PATH, limits.maxManifestBytes), 'manifest'),
    );
    checkLayout(reader, manifest);

    const dataBytes = await reader.readEntry(ARCHIVE_DATA_PATH, limits.maxDataBytes);
    const dataEntry = manifest.files.find((file) => file.path === ARCHIVE_DATA_PATH)!;
    if (dataBytes.length !== dataEntry.byteSize || sha256Of(dataBytes) !== dataEntry.sha256) {
      throw new TransferError(
        'ARCHIVE_CHECKSUM_MISMATCH',
        'The archive data does not match its checksum. The file may be damaged.',
      );
    }
    const data = parseArchiveData(parseJson(dataBytes, 'data'));
    checkCounts(manifest.counts, archiveCounts(data));
    checkAttachmentEntries(manifest, data);

    progress.checkCancelled();
    progress.phase('Checking attached files', data.attachments.length);
    const { approved, warnings: attachmentWarnings } = await checkAttachmentPolicy(
      reader,
      data,
      options.maxAttachmentBytes,
      progress,
    );
    progress.phase('Planning the import', null);
    const destination = await workspace.services.importer.describeDestination(manifest.exportId);
    const plan = planImport(data, {
      workspaceId: workspace.id,
      existingTypes: destination.existingTypes,
      existingTags: destination.existingTags,
      ids: options.ids,
      importOrigin: importOrigin(manifest),
      approvedAttachments: approved,
    });

    const warnings = [...plan.warnings, ...attachmentWarnings];
    if (manifest.workspace.id === workspace.id) {
      warnings.unshift(
        'This archive was exported from this workspace. Importing it adds a second copy of ' +
          'everything in it.',
      );
    }
    return {
      workspaceId: workspace.id,
      manifest,
      plan,
      warnings,
      earlierImports: destination.earlierImports,
      reader,
      maxAttachmentBytes: options.maxAttachmentBytes,
    };
  } catch (error) {
    reader.close();
    throw error;
  }
}

/**
 * Applies a prepared import. Closes the archive in every case. `writeRecords` writes the
 * database records; the app passes the worker-thread writer, tests use the in-process default.
 *
 * @throws TransferError `ARCHIVE_CHECKSUM_MISMATCH` or `TRANSFER_FAILED`; storage errors pass
 *   through. On failure nothing of the import remains.
 */
export async function applyImport(
  workspace: OpenWorkspace,
  prepared: PreparedImport,
  writeRecords: ImportRecordWriter = writeImportInProcess,
  progress: Progress = NO_PROGRESS,
): Promise<void> {
  const { plan, reader } = prepared;
  const stored = new Map<AttachmentId, string>();
  let temporaryDirectory: string | null = null;
  try {
    if (plan.attachments.length > 0) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'mmap-import-')).catch((error: unknown) => {
        throw toWriteError(error, 'The import');
      });
    }
    progress.phase('Copying attached files', plan.attachments.length);
    for (const [index, attachment] of plan.attachments.entries()) {
      progress.checkCancelled();
      // The temporary name is ours; the archive name only selects which entry to read.
      const temporaryPath = join(temporaryDirectory!, `${index}.bin`);
      const extracted = await reader
        .extractEntry(
          archiveAttachmentPath(attachment.archiveAttachmentId),
          temporaryPath,
          prepared.maxAttachmentBytes,
        )
        .catch((error: unknown) => {
          throw error instanceof TransferError ? error : toWriteError(error, 'The import');
        });
      if (extracted.byteSize !== attachment.byteSize || extracted.sha256 !== attachment.sha256) {
        throw new TransferError(
          'ARCHIVE_CHECKSUM_MISMATCH',
          'An attachment in the archive does not match its checksum. The file may be damaged.',
        );
      }
      const file = await workspace.attachmentStore
        .importFile(
          temporaryPath,
          extensionOf(attachment.originalName),
          prepared.maxAttachmentBytes,
        )
        .catch((error: unknown) => {
          throw toWriteError(error, 'The import');
        });
      stored.set(attachment.id, file.relativePath);
      await rm(temporaryPath, { force: true });
      progress.advance();
    }
    progress.checkCancelled();
    // From here on the import becomes visible: no cancelling, so a cancel can never be reported
    // for an import that was in fact committed.
    progress.phase('Saving to the workspace', null, { cancellable: false });
    await writeRecords(workspace, plan, prepared.manifest.exportId, stored);
  } catch (error) {
    for (const relativePath of stored.values()) {
      await workspace.attachmentStore.remove(relativePath).catch(() => undefined);
    }
    throw error;
  } finally {
    reader.close();
    if (temporaryDirectory !== null) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Shown on imported timeline events, e.g. `Physics (exported 2026-10-27)`. */
function importOrigin(manifest: ArchiveManifest): string {
  return `${manifest.workspace.name.slice(0, 100)} (exported ${manifest.exportedAt.slice(0, 10)})`;
}

/**
 * Every entry must be part of the layout and listed in the manifest with its size, and every
 * listed file must be present: nothing unexpected is accepted, nothing required is missing.
 */
function checkLayout(reader: ZipReader, manifest: ArchiveManifest): void {
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  if (listed.size !== manifest.files.length) {
    throw new TransferError('ARCHIVE_INVALID', 'The archive manifest lists a file twice.');
  }
  if (!listed.has(ARCHIVE_DATA_PATH)) {
    throw new TransferError('ARCHIVE_INVALID', 'The archive has no workspace data.');
  }
  for (const entry of reader.entries()) {
    if (entry.name === ARCHIVE_MANIFEST_PATH) continue;
    if (!isLayoutPath(entry.name)) {
      throw new TransferError('ARCHIVE_UNSAFE', 'The archive contains unexpected files.');
    }
    const file = listed.get(entry.name);
    if (file === undefined) {
      throw new TransferError(
        'ARCHIVE_INVALID',
        'The archive contains files its manifest does not list.',
      );
    }
    if (file.byteSize !== entry.uncompressedSize) {
      throw new TransferError('ARCHIVE_INVALID', 'A file in the archive has an unexpected size.');
    }
  }
  for (const path of listed.keys()) {
    if (!reader.has(path)) {
      throw new TransferError(
        'ARCHIVE_INVALID',
        'The archive is missing files its manifest lists.',
      );
    }
  }
}

function isLayoutPath(name: string): boolean {
  if (name === ARCHIVE_DATA_PATH) return true;
  const prefix = `${ARCHIVE_ATTACHMENTS_DIRECTORY}/`;
  return name.startsWith(prefix) && isCanonicalUuid(name.slice(prefix.length));
}

function checkCounts(declared: ArchiveCounts, actual: ArchiveCounts): void {
  for (const key of Object.keys(actual) as (keyof ArchiveCounts)[]) {
    if (declared[key] !== actual[key]) {
      throw new TransferError('ARCHIVE_INVALID', 'The archive data does not match its manifest.');
    }
  }
}

/** Each attachment has exactly one file, with the size and checksum the manifest records. */
function checkAttachmentEntries(manifest: ArchiveManifest, data: ArchiveData): void {
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  for (const attachment of data.attachments) {
    const file = listed.get(archiveAttachmentPath(attachment.id));
    if (file?.byteSize !== attachment.byteSize || file.sha256 !== attachment.sha256) {
      throw new TransferError('ARCHIVE_INVALID', 'An attachment file is missing from the archive.');
    }
  }
  const attachmentFiles = manifest.files.filter((file) => file.path !== ARCHIVE_DATA_PATH).length;
  if (attachmentFiles !== data.attachments.length) {
    throw new TransferError('ARCHIVE_INVALID', 'The archive contains files no attachment uses.');
  }
}

/** Applies the attachment policy to each file's actual name, size and leading bytes. */
async function checkAttachmentPolicy(
  reader: ZipReader,
  data: ArchiveData,
  maxBytes: number,
  progress: Progress,
): Promise<{ approved: Map<string, ApprovedAttachment>; warnings: string[] }> {
  const approved = new Map<string, ApprovedAttachment>();
  const reasons = new Map<string, number>();
  for (const attachment of data.attachments) {
    progress.checkCancelled();
    progress.advance();
    const leadingBytes =
      attachment.byteSize > maxBytes
        ? new Uint8Array(0)
        : await reader.readEntryStart(archiveAttachmentPath(attachment.id), SNIFF_BYTES);
    const result = classifyAttachment(
      {
        originalName: attachment.originalName,
        byteSize: attachment.byteSize,
        // Oversized files are rejected on size before the bytes are looked at.
        leadingBytes: attachment.byteSize > maxBytes ? new Uint8Array(SNIFF_BYTES) : leadingBytes,
      },
      maxBytes,
    );
    if (result.accepted) {
      approved.set(attachment.id, { displayName: result.displayName, mimeType: result.mimeType });
    } else {
      const reason = describeRejection(result.reason, maxBytes);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const warnings = [...reasons].map(
    ([reason, count]) =>
      `${count === 1 ? '1 attachment is' : `${count} attachments are`} not imported: ${reason}`,
  );
  return { approved, warnings };
}

function parseJson(bytes: Buffer, what: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new TransferError('ARCHIVE_INVALID', `The archive ${what} is not valid JSON.`, {
      cause: error,
    });
  }
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
