/**
 * Smoke check for backups inside the packaged app (PRD §11: installed-app end-to-end
 * "backup/restore").
 *
 * Takes a backup through the backup service, then rebuilds a complete workspace folder from the
 * newest snapshot in a scratch folder: the same verified path a restore uses, without swapping
 * out the workspace the remaining checks run in.
 */

import { join } from 'node:path';

import type { BackupService } from './backups/backup-service';
import { buildWorkspaceFromSnapshot, listSnapshots } from './backups/snapshot-store';
import type { WorkspaceManager } from './workspaces/workspace-manager';

export async function checkBackupAndRestore(
  workspaces: WorkspaceManager,
  backups: BackupService,
  scratchDirectory: string,
): Promise<void> {
  const workspace = workspaces.current;
  if (workspace === null) throw new Error('No workspace is open.');
  const node = await workspace.services.nodes.create({ title: 'Smoke backup node' });
  try {
    const status = await backups.backUpNow();
    if (status.lastFailure !== null) {
      throw new Error(`backup failed: ${status.lastFailure.message}`);
    }
    const [newest] = await listSnapshots(status.destination, workspace.id);
    if (newest === undefined || newest.createdAt !== status.lastSuccessAt) {
      throw new Error('the backup was not listed');
    }
    const restored = await buildWorkspaceFromSnapshot(
      newest.folder,
      join(scratchDirectory, 'restored'),
      'smoke',
    );
    if (restored.workspaceId !== workspace.id) throw new Error('the restored workspace differs');
  } finally {
    await workspace.services.nodes.delete(node.id, node.revision);
  }
}
