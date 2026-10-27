/**
 * Smoke check for attachments inside the packaged app (PRD §11: installed-app end-to-end).
 *
 * The native file dialog cannot be driven in an unattended run, so this check performs the steps
 * the add flow performs after the dialog: classify a real file, import it through the file store,
 * and record it. It then asks the renderer to display it through `mmap-attachment://`, which
 * exercises the store in the packaged runtime, the preview protocol and the CSP together, and
 * confirms that an unknown attachment ID does not load.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { attachmentPreviewUrl } from '@mmap/contracts';
import { classifyAttachment, SNIFF_BYTES } from '@mmap/domain';
import type { BrowserWindow } from 'electron';

import type { WorkspaceManager } from './workspaces/workspace-manager';

/** A valid 1×1 PNG. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export async function checkAttachmentPreview(
  window: BrowserWindow,
  workspaces: WorkspaceManager,
  scratchDirectory: string,
): Promise<void> {
  const workspace = workspaces.current;
  if (workspace === null) {
    throw new Error('No workspace is open.');
  }
  const sourcePath = join(scratchDirectory, 'smoke-pixel.png');
  writeFileSync(sourcePath, ONE_PIXEL_PNG);
  const node = await workspace.services.nodes.create({ title: 'Smoke attachment node' });
  try {
    const store = workspace.attachmentStore;
    const { byteSize } = await store.statSource(sourcePath);
    const classification = classifyAttachment({
      originalName: 'smoke-pixel.png',
      byteSize,
      leadingBytes: await store.readLeadingBytes(sourcePath, SNIFF_BYTES),
    });
    if (!classification.accepted) {
      throw new Error(`Test image was rejected: ${classification.reason}`);
    }
    const stored = await store.importFile(sourcePath, 'png', byteSize);
    const attachment = await workspace.services.attachments.register(node.id, {
      relativePath: stored.relativePath,
      displayName: classification.displayName,
      mimeType: classification.mimeType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
    });

    const result = (await window.webContents.executeJavaScript(`
      (async () => {
        const load = (src) => new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image.naturalWidth);
          image.onerror = () => resolve(-1);
          image.src = src;
        });
        return {
          known: await load(${JSON.stringify(attachmentPreviewUrl(attachment.id))}),
          unknown: await load(${JSON.stringify(attachmentPreviewUrl('00000000-0000-4000-8000-000000000000'))}),
        };
      })()`)) as { known: number; unknown: number };

    if (result.known !== 1) {
      throw new Error('The stored image did not load through the preview protocol.');
    }
    if (result.unknown !== -1) {
      throw new Error('An unknown attachment ID loaded an image.');
    }
  } finally {
    await workspace.services.nodes.delete(node.id, 1).catch(() => undefined);
    rmSync(sourcePath, { force: true });
  }
}
