/**
 * Export and import contracts (PRD §5.11).
 *
 * Security: the renderer never sends file paths. The main process asks for the export
 * destination or the archive to import with a native dialog (PRD §8: "Native dialogs authorize
 * selected import/export locations only"), and only the chosen file's name comes back for
 * display. An import is a two-step exchange: `preview-import` validates the whole archive and
 * returns what would happen plus an opaque token; `apply-import` with that token performs it.
 */

import { z } from 'zod';

export const TRANSFER_ERROR_CODES = [
  /** The file is not an mmap archive, or it is damaged or inconsistent. */
  'ARCHIVE_INVALID',
  /** The archive contains unsafe entries (traversal, links, encrypted or unexpected files). */
  'ARCHIVE_UNSAFE',
  /** The archive exceeds a size or count limit. */
  'ARCHIVE_TOO_LARGE',
  /** The archive was written by a newer mmap version. */
  'ARCHIVE_TOO_NEW',
  /** A file's bytes do not match the checksum recorded in the archive. */
  'ARCHIVE_CHECKSUM_MISMATCH',
  /** Writing the export or copying files failed (disk full, no permission, …). */
  'TRANSFER_FAILED',
  /** The previewed import is no longer available (it expired or another workspace was opened). */
  'IMPORT_EXPIRED',
] as const;

export type TransferErrorCode = (typeof TRANSFER_ERROR_CODES)[number];

const countsSchema = z.strictObject({
  nodes: z.number().int().nonnegative(),
  tags: z.number().int().nonnegative(),
  relationshipTypes: z.number().int().nonnegative(),
  relationships: z.number().int().nonnegative(),
  maps: z.number().int().nonnegative(),
  placements: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
  timelineEvents: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
});

export const importSummarySchema = z.strictObject({
  nodes: z.number().int().nonnegative(),
  newTags: z.number().int().nonnegative(),
  reusedTags: z.number().int().nonnegative(),
  newRelationshipTypes: z.number().int().nonnegative(),
  reusedRelationshipTypes: z.number().int().nonnegative(),
  relationships: z.number().int().nonnegative(),
  maps: z.number().int().nonnegative(),
  placements: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
  timelineEvents: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
});

const noRequest = z.strictObject({});
const cancelled = z.strictObject({ status: z.literal('cancelled') });

export const transferContracts = {
  /** Asks where to save, then writes the lossless ZIP archive of the open workspace. */
  exportZip: {
    request: noRequest,
    response: z.discriminatedUnion('status', [
      cancelled,
      z.strictObject({
        status: z.literal('exported'),
        fileName: z.string(),
        counts: countsSchema,
        /** For example attachments whose file was missing and could not be included. */
        warnings: z.array(z.string()).readonly(),
      }),
    ]),
  },
  /** Asks for an archive, validates all of it and describes the import without changing data. */
  previewImport: {
    request: noRequest,
    response: z.discriminatedUnion('status', [
      cancelled,
      z.strictObject({
        status: z.literal('ready'),
        importToken: z.uuid(),
        fileName: z.string(),
        source: z.strictObject({
          workspaceName: z.string(),
          exportedAt: z.string(),
          appVersion: z.string(),
        }),
        summary: importSummarySchema,
        warnings: z.array(z.string()).readonly(),
        /** When this archive was imported into this workspace before (empty if never). */
        previousImports: z.array(z.string()).readonly(),
        /** The archive was exported from the open workspace itself. */
        sameWorkspace: z.boolean(),
      }),
    ]),
  },
  /**
   * Performs a previewed import. When the archive was imported before, `acceptDuplicate` must be
   * true: the user saw the duplicate warning and chose to import again.
   */
  applyImport: {
    request: z.strictObject({ importToken: z.uuid(), acceptDuplicate: z.boolean() }),
    response: z.strictObject({ summary: importSummarySchema }),
  },
  /** Forgets a previewed import (the user cancelled after the preview). */
  discardImport: {
    request: z.strictObject({ importToken: z.uuid() }),
    response: z.strictObject({ discarded: z.literal(true) }),
  },
} as const;
