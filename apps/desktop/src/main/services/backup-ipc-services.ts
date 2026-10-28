/**
 * IPC-facing backups and restore (PRD §9). Folders come from native dialogs only (PRD §8).
 */

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { BackupService } from '../backups/backup-service';
import type { OperationRegistry } from '../operations/operation-progress';

type BackupChannel = Extract<keyof IpcServices, `backups:${string}`>;

export interface BackupNativeInteractions {
  /** Folder picker for the backup destination; null when cancelled. */
  chooseBackupFolder(): Promise<string | null>;
  /** Folder picker for one snapshot folder to restore; null when cancelled. */
  chooseSnapshotFolder(): Promise<string | null>;
}

export function createBackupIpcServices(
  backups: BackupService,
  native: BackupNativeInteractions,
  operations: OperationRegistry,
): Pick<IpcServices, BackupChannel> {
  return {
    'backups:get-status': () => backups.status(),
    'backups:create-now': ({ operationId }) =>
      operations.run(operationId, (progress) => backups.backUpNow(progress)),
    'backups:choose-destination': async () => {
      const folder = await native.chooseBackupFolder();
      return folder === null ? backups.status() : backups.setDestination(folder);
    },
    'backups:use-default-destination': () => backups.setDestination(null),
    'backups:set-retention': ({ daily, weekly }) => backups.setRetention(daily, weekly),
    'backups:restore': async ({ snapshotId, operationId }) => ({
      state: await operations.run(operationId, (progress) =>
        backups.restoreSnapshot(snapshotId, progress),
      ),
    }),
    'backups:restore-from-folder': async ({ operationId }) => {
      const folder = await native.chooseSnapshotFolder();
      if (folder === null) return { status: 'cancelled' as const };
      const state = await operations.run(operationId, (progress) =>
        backups.restoreFromFolder(folder, progress),
      );
      return { status: 'restored' as const, state };
    },
  };
}
