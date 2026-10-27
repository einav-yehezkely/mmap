/**
 * IPC-facing backups and restore (PRD §9). Folders come from native dialogs only (PRD §8).
 */

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { BackupService } from '../backups/backup-service';

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
): Pick<IpcServices, BackupChannel> {
  return {
    'backups:get-status': () => backups.status(),
    'backups:create-now': () => backups.backUpNow(),
    'backups:choose-destination': async () => {
      const folder = await native.chooseBackupFolder();
      return folder === null ? backups.status() : backups.setDestination(folder);
    },
    'backups:use-default-destination': () => backups.setDestination(null),
    'backups:set-retention': ({ daily, weekly }) => backups.setRetention(daily, weekly),
    'backups:restore': async ({ snapshotId }) => ({
      state: await backups.restoreSnapshot(snapshotId),
    }),
    'backups:restore-from-folder': async () => {
      const folder = await native.chooseSnapshotFolder();
      if (folder === null) return { status: 'cancelled' as const };
      return { status: 'restored' as const, state: await backups.restoreFromFolder(folder) };
    },
  };
}
