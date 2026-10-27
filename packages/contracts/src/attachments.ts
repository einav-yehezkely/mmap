/**
 * Attachment and preference contracts (PRD §5.10).
 *
 * The renderer never sends file paths. Adding files opens a native file dialog in the main
 * process (PRD §8: "Native dialogs authorize selected import/export locations only"); opening and
 * previewing refer to attachments by ID only.
 */

import { z } from 'zod';

export const attachmentViewSchema = z.strictObject({
  id: z.uuid(),
  nodeId: z.uuid(),
  displayName: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** Raster image confirmed from its bytes; may be shown inline via the preview protocol. */
  previewable: z.boolean(),
  /** False when the managed copy is missing from the workspace folder (reported, never hidden). */
  fileAvailable: z.boolean(),
  createdAt: z.string(),
});

export type AttachmentViewDto = z.infer<typeof attachmentViewSchema>;

export const attachmentContracts = {
  add: {
    request: z.strictObject({ nodeId: z.uuid() }),
    response: z.strictObject({
      cancelled: z.boolean(),
      added: z.array(attachmentViewSchema).readonly(),
      /** Files that were not added, with a user-facing reason each. */
      rejected: z.array(z.strictObject({ fileName: z.string(), reason: z.string() })).readonly(),
    }),
  },
  list: {
    request: z.strictObject({ nodeId: z.uuid() }),
    response: z.strictObject({ items: z.array(attachmentViewSchema).readonly() }),
  },
  open: {
    request: z.strictObject({ attachmentId: z.uuid() }),
    response: z.strictObject({ opened: z.boolean() }),
  },
  remove: {
    request: z.strictObject({ attachmentId: z.uuid() }),
    response: z.strictObject({ removed: z.literal(true) }),
  },
} as const;

/** Machine-local preferences (stored in the user profile, never exported). */
export const preferencesSchema = z.strictObject({
  /** Per-file attachment size limit (PRD §5.10: default 20 MB, configurable locally). */
  maxAttachmentMegabytes: z.number().int().min(1).max(1_024),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const preferenceContracts = {
  get: { request: z.undefined(), response: preferencesSchema },
  update: { request: preferencesSchema.partial(), response: preferencesSchema },
} as const;

/** URL scheme for in-app image previews: `mmap-attachment://current/<attachmentId>`. */
export const ATTACHMENT_PREVIEW_SCHEME = 'mmap-attachment';

export function attachmentPreviewUrl(attachmentId: string): string {
  return `${ATTACHMENT_PREVIEW_SCHEME}://current/${attachmentId}`;
}
