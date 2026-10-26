import type { AttachmentId } from '@mmap/domain';
import { describe, expect, it, vi } from 'vitest';

import { resolveAttachmentPreview, type PreviewDependencies } from './attachment-preview';

const PNG_ID = '90000000-0000-4000-8000-00000000000a';
const SVG_ID = '90000000-0000-4000-8000-00000000000b';
const MISSING_FILE_ID = '90000000-0000-4000-8000-00000000000c';

function dependencies(): PreviewDependencies & {
  findAttachment: ReturnType<typeof vi.fn<PreviewDependencies['findAttachment']>>;
} {
  const records: Record<string, { relativePath: string; mimeType: string }> = {
    [PNG_ID]: { relativePath: '90/png.png', mimeType: 'image/png' },
    [SVG_ID]: { relativePath: '90/svg.svg', mimeType: 'image/svg+xml' },
    [MISSING_FILE_ID]: { relativePath: '90/gone.png', mimeType: 'image/png' },
  };
  return {
    findAttachment: vi.fn((id: AttachmentId) => Promise.resolve(records[id] ?? null)),
    resolveStoredFile: (relativePath) =>
      Promise.resolve(relativePath === '90/png.png' ? 'C:\\ws\\attachments\\90\\png.png' : null),
  };
}

describe('resolveAttachmentPreview', () => {
  it('serves a previewable image from the open workspace with its recorded type', async () => {
    await expect(
      resolveAttachmentPreview(`mmap-attachment://current/${PNG_ID}`, dependencies()),
    ).resolves.toEqual({
      kind: 'file',
      absolutePath: 'C:\\ws\\attachments\\90\\png.png',
      mimeType: 'image/png',
    });
  });

  it('refuses SVG, which can contain scripts', async () => {
    await expect(
      resolveAttachmentPreview(`mmap-attachment://current/${SVG_ID}`, dependencies()),
    ).resolves.toEqual({ kind: 'rejected', status: 403 });
  });

  it.each([
    ['another host (workspace)', `mmap-attachment://other/${PNG_ID}`, 403],
    ['a path instead of an ID', 'mmap-attachment://current/../../etc/passwd', 400],
    ['an encoded path', 'mmap-attachment://current/90%2Fpng.png', 400],
    ['an uppercase ID', `mmap-attachment://current/${PNG_ID.toUpperCase()}`, 400],
    ['extra path segments', `mmap-attachment://current/${PNG_ID}/x`, 400],
    ['a query string', `mmap-attachment://current/${PNG_ID}?download=1`, 400],
    ['another scheme', `app://current/${PNG_ID}`, 403],
    [
      'an unknown attachment',
      'mmap-attachment://current/90000000-0000-4000-8000-0000000000ff',
      404,
    ],
    ['a row whose file is missing', `mmap-attachment://current/${MISSING_FILE_ID}`, 404],
    ['garbage', 'not a url', 400],
  ])('rejects %s', async (_label, url, status) => {
    await expect(resolveAttachmentPreview(url, dependencies())).resolves.toEqual({
      kind: 'rejected',
      status,
    });
  });

  it('never consults the database for malformed requests', async () => {
    const deps = dependencies();

    await resolveAttachmentPreview('mmap-attachment://current/../secret', deps);

    expect(deps.findAttachment).not.toHaveBeenCalled();
  });
});
