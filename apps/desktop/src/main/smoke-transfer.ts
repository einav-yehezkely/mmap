/**
 * Smoke check for export and import inside the packaged app (PRD §11: installed-app end-to-end
 * "export/import").
 *
 * Native dialogs cannot be driven in an unattended run, so the transfer services get stand-in
 * dialogs that return a file in a scratch folder; everything else is the real code path,
 * including the bundled ZIP libraries. The workspace is exported and imported back into itself
 * (as copies); the copied nodes and maps are removed again afterwards.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createTransferIpcServices } from './services/transfer-ipc-services';
import type { WorkspaceManager } from './workspaces/workspace-manager';

export async function checkExportImport(
  workspaces: WorkspaceManager,
  scratchDirectory: string,
): Promise<void> {
  const workspace = workspaces.current;
  if (workspace === null) throw new Error('No workspace is open.');
  const archivePath = join(scratchDirectory, 'smoke-export.mmap.zip');
  const transfer = createTransferIpcServices({
    currentWorkspace: () => workspaces.current,
    maxAttachmentBytes: () => Promise.resolve(20 * 1024 * 1024),
    native: {
      chooseExportDestination: () => Promise.resolve(archivePath),
      chooseArchiveToImport: () => Promise.resolve(archivePath),
    },
    appVersion: 'smoke',
    ids: { newId: () => randomUUID() },
  });

  const title = `Smoke export ${randomUUID()}`;
  const original = await workspace.services.nodes.create({ title, summary: 'Round trip' });
  const before = await workspace.services.snapshots.read(workspace.id);
  const nodesBefore = new Set<string>(before.nodes.map((node) => node.id));
  const mapsBefore = new Set<string>(before.maps.map((map) => map.id));
  try {
    const exported = await transfer['transfer:export-zip']({});
    if (exported.status !== 'exported') throw new Error('export was cancelled');

    const preview = await transfer['transfer:preview-import']({});
    if (preview.status !== 'ready') throw new Error('import preview was cancelled');
    if (!preview.sameWorkspace) throw new Error('the archive did not identify its workspace');
    if (preview.summary.nodes !== exported.counts.nodes) {
      throw new Error(
        `preview counts ${preview.summary.nodes} nodes, export ${exported.counts.nodes}`,
      );
    }
    await transfer['transfer:apply-import']({
      importToken: preview.importToken,
      acceptDuplicate: true,
    });

    const after = await workspace.services.snapshots.read(workspace.id);
    const copies = after.nodes.filter((node) => node.title === title);
    if (copies.length !== 2 || copies.some((node) => node.summary !== 'Round trip')) {
      throw new Error(`expected 2 copies of the exported node, found ${copies.length}`);
    }
  } finally {
    // Removes what the import added (copies of every node and map), and the test node itself.
    const after = await workspace.services.snapshots.read(workspace.id);
    for (const map of after.maps) {
      if (!mapsBefore.has(map.id)) await workspace.services.maps.deleteMap(map.id);
    }
    for (const node of after.nodes) {
      if (!nodesBefore.has(node.id) || node.id === original.id) {
        await workspace.services.nodes.delete(node.id, node.revision);
      }
    }
  }
}
