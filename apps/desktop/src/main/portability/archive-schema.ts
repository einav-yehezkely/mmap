/**
 * Shape validation of untrusted archive files (PRD §5.11: "schema validation").
 *
 * These schemas only check structure and bounds: field types, string and array lengths, finite
 * numbers, checksum formats. Unknown fields are rejected (`strictObject`), so a hand-made archive
 * cannot smuggle data through. Meaning (references that resolve, unique labels, valid titles and
 * notes) is checked afterwards by `planImport` in the domain, with the same rules as user input.
 */

import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MAP_MODES,
  RELATIONSHIP_DIRECTIONALITIES,
  TIMELINE_EVENT_TYPES,
  type ArchiveData,
  type ArchiveManifest,
} from '@mmap/domain';
import { z } from 'zod';

import { TransferError } from './transfer-errors';

/** Archive IDs are only used as keys while importing; they are never stored. */
const archiveId = z.string().min(1).max(100);
const timestamp = z.string().min(1).max(40);
const text = (max: number) => z.string().max(max);
const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const many = <Item extends z.ZodType>(item: Item, max: number) => z.array(item).max(max);

const MAX_RECORDS = 1_000_000;

export const archiveManifestSchema = z.strictObject({
  format: z.literal(ARCHIVE_FORMAT),
  formatVersion: z.number().int().positive(),
  exportId: z.uuid(),
  exportedAt: timestamp,
  appVersion: text(100),
  schemaVersion: z.number().int().nonnegative(),
  workspace: z.strictObject({ id: archiveId, name: text(200), timezone: text(100) }),
  counts: z.strictObject({
    nodes: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    relationshipTypes: z.number().int().nonnegative(),
    relationships: z.number().int().nonnegative(),
    maps: z.number().int().nonnegative(),
    placements: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
    timelineEvents: z.number().int().nonnegative(),
    attachments: z.number().int().nonnegative(),
  }),
  files: many(
    z.strictObject({
      path: text(200),
      byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sha256,
    }),
    MAX_RECORDS,
  ),
});

export const archiveDataSchema = z.strictObject({
  nodes: many(
    z.strictObject({
      id: archiveId,
      title: text(2_000),
      summary: text(20_000).nullable(),
      // Validated by `parseNoteDocument`, which bounds depth, node count and size.
      note: z.unknown(),
      noteSchemaVersion: z.number().int(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    MAX_RECORDS,
  ),
  tags: many(
    z.strictObject({ id: archiveId, label: text(500), createdAt: timestamp, updatedAt: timestamp }),
    MAX_RECORDS,
  ),
  nodeTags: many(
    z.strictObject({ nodeId: archiveId, tagId: archiveId, createdAt: timestamp }),
    MAX_RECORDS,
  ),
  relationshipTypes: many(
    z.strictObject({
      id: archiveId,
      label: text(500),
      directionality: z.enum(RELATIONSHIP_DIRECTIONALITIES),
      isArchived: z.boolean(),
      isBuiltin: z.boolean(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    10_000,
  ),
  relationships: many(
    z.strictObject({
      id: archiveId,
      sourceNodeId: archiveId,
      targetNodeId: archiveId,
      typeId: archiveId,
      description: text(10_000).nullable(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    MAX_RECORDS,
  ),
  maps: many(
    z.strictObject({
      id: archiveId,
      title: text(2_000),
      mode: z.enum(MAP_MODES),
      viewport: z.strictObject({
        x: coordinate,
        y: coordinate,
        zoom: z.number().finite().positive().max(1_000),
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    100_000,
  ),
  placements: many(
    z.strictObject({
      id: archiveId,
      mapId: archiveId,
      nodeId: archiveId,
      x: coordinate,
      y: coordinate,
      parentPlacementId: archiveId.nullable(),
      siblingOrder: z.number().int().min(-1_000_000_000).max(1_000_000_000),
      isCollapsed: z.boolean(),
      color: text(50).nullable(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    MAX_RECORDS,
  ),
  connections: many(
    z.strictObject({
      id: archiveId,
      mapId: archiveId,
      sourcePlacementId: archiveId,
      targetPlacementId: archiveId,
      relationshipId: archiveId.nullable(),
      label: text(2_000).nullable(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    MAX_RECORDS,
  ),
  timelineEvents: many(
    z.strictObject({
      id: archiveId,
      nodeId: archiveId.nullable(),
      nodeTitleSnapshot: text(2_000).nullable(),
      eventType: z.enum(TIMELINE_EVENT_TYPES),
      occurredAt: timestamp,
      lastActivityAt: timestamp,
      learnedAt: timestamp.nullable(),
      title: text(2_000).nullable(),
      reflection: text(20_000).nullable(),
      isImported: z.boolean(),
      importOrigin: text(1_000).nullable(),
    }),
    5 * MAX_RECORDS,
  ),
  attachments: many(
    z.strictObject({
      id: z.uuid(),
      nodeId: archiveId,
      originalName: text(1_000),
      mimeType: z
        .string()
        .max(200)
        .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u),
      byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      sha256,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    MAX_RECORDS,
  ),
  graphPositions: many(
    z.strictObject({ nodeId: archiveId, x: coordinate, y: coordinate }),
    MAX_RECORDS,
  ),
});

/**
 * Parses the manifest. The format version is checked first, so an archive from a newer mmap gets
 * an actionable message instead of a schema error (PRD §14).
 *
 * @throws TransferError `ARCHIVE_INVALID` or `ARCHIVE_TOO_NEW`.
 */
export function parseArchiveManifest(json: unknown): ArchiveManifest {
  const header = z
    .looseObject({ format: z.literal(ARCHIVE_FORMAT), formatVersion: z.number().int() })
    .safeParse(json);
  if (!header.success) {
    throw new TransferError('ARCHIVE_INVALID', 'This file is not an mmap workspace export.');
  }
  if (header.data.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new TransferError(
      'ARCHIVE_TOO_NEW',
      'This archive was exported by a newer version of mmap. Update mmap to import it.',
    );
  }
  const result = archiveManifestSchema.safeParse(json);
  if (!result.success) {
    throw new TransferError('ARCHIVE_INVALID', 'The archive manifest is damaged.');
  }
  return result.data;
}

/** @throws TransferError `ARCHIVE_INVALID` when the data file does not have the archive shape. */
export function parseArchiveData(json: unknown): ArchiveData {
  const result = archiveDataSchema.safeParse(json);
  if (!result.success) {
    throw new TransferError('ARCHIVE_INVALID', 'The archive data is damaged or incomplete.');
  }
  return result.data;
}
