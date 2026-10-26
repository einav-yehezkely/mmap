/**
 * In-app image previews via `mmap-attachment://current/<attachmentId>` (PRD §5.10: "sanitize
 * previews … Restrict local preview access to approved workspace files and prevent
 * traversal/symlink escapes").
 *
 * Rules, all of which must pass:
 * 1. Host is `current`: only the workspace that is open right now can be previewed, so a note
 *    can never display files of another workspace.
 * 2. The path is exactly one canonical attachment ID; no file names or paths are accepted.
 * 3. The attachment exists in the open workspace's database and is a raster image whose type was
 *    confirmed from its bytes when it was added. SVG and every other type are refused: SVG can
 *    contain scripts, and nothing but images is ever rendered inline.
 * 4. The stored relative path resolves to a regular file inside the attachments folder
 *    (`FileAttachmentStore.resolveExisting` checks traversal and symlink escapes).
 * The response carries the type recorded at import, `nosniff`, and no caching.
 */

import { isCanonicalUuid, PREVIEWABLE_IMAGE_TYPES, type AttachmentId } from '@mmap/domain';
import { ATTACHMENT_PREVIEW_SCHEME } from '@mmap/contracts';

export type PreviewResolution =
  | { readonly kind: 'file'; readonly absolutePath: string; readonly mimeType: string }
  | { readonly kind: 'rejected'; readonly status: 400 | 403 | 404 };

export interface PreviewDependencies {
  /** Looks up an attachment in the open workspace; null when none is open or it does not exist. */
  readonly findAttachment: (
    attachmentId: AttachmentId,
  ) => Promise<{ relativePath: string; mimeType: string } | null>;
  /** Resolves a stored relative path to an absolute path inside the store, or null. */
  readonly resolveStoredFile: (relativePath: string) => Promise<string | null>;
}

export async function resolveAttachmentPreview(
  requestUrl: string,
  dependencies: PreviewDependencies,
): Promise<PreviewResolution> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'rejected', status: 400 };
  }
  if (url.protocol !== `${ATTACHMENT_PREVIEW_SCHEME}:` || url.host !== 'current') {
    return { kind: 'rejected', status: 403 };
  }
  if (url.search !== '' || url.hash !== '') {
    return { kind: 'rejected', status: 400 };
  }

  const attachmentId = url.pathname.slice(1);
  if (!isCanonicalUuid(attachmentId)) {
    return { kind: 'rejected', status: 400 };
  }

  const attachment = await dependencies.findAttachment(attachmentId as AttachmentId);
  if (attachment === null) {
    return { kind: 'rejected', status: 404 };
  }
  if (!PREVIEWABLE_IMAGE_TYPES.has(attachment.mimeType)) {
    return { kind: 'rejected', status: 403 };
  }

  const absolutePath = await dependencies.resolveStoredFile(attachment.relativePath);
  if (absolutePath === null) {
    return { kind: 'rejected', status: 404 };
  }
  return { kind: 'file', absolutePath, mimeType: attachment.mimeType };
}
