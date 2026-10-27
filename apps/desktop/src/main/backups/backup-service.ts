/**
 * Backups of the open workspace (PRD §9).
 *
 * - **When:** shortly after a workspace is opened (the first time each local day), again every hour
 *   while the app runs (so a session left open overnight still gets its daily backup), and on
 *   request. The delay after opening keeps the backup's database work away from the moments when
 *   the user starts working, because parts of it (the integrity check) run on the main thread.
 * - **Where:** a configurable destination; by default `<app data>/backups`. The status says when
 *   the destination is on the same drive as the workspace, which does not protect against a drive
 *   failure, so the user can choose a folder on another drive.
 * - **How many:** seven daily and four weekly snapshots by default (`snapshotsToKeep`), pruned
 *   after every successful backup.
 * - **Status:** the last successful backup (the newest snapshot on disk) and the last failure
 *   are shown in Settings.
 * - **Restore:** a snapshot replaces the open workspace's content after a safety backup of the
 *   current state, or is restored as a new workspace from a backup folder chosen by the user.
 *
 * Backups never block the user: they run in the background, one at a time, and a failure is
 * recorded and shown, not thrown at whoever opened the workspace.
 */

import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { WorkspaceState } from '@mmap/contracts';
import { isBackupDue, snapshotsToKeep } from '@mmap/domain';

import { TransferError } from '../portability/transfer-errors';
import type { BackupSettings, SettingsStore } from '../workspaces/app-settings';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';
import type { WorkspaceManager } from '../workspaces/workspace-manager';
import {
  buildWorkspaceFromSnapshot,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  readSnapshotManifest,
  type SnapshotSummary,
} from './snapshot-store';

export const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
/** How long after a workspace opens the daily backup check runs. */
export const BACKUP_DELAY_AFTER_OPEN_MS = 2 * 60 * 1_000;

export interface BackupStatus {
  readonly destination: string;
  readonly isDefaultDestination: boolean;
  /** True when backups would be lost together with the workspace if its drive failed. */
  readonly sameDriveAsWorkspace: boolean;
  readonly retention: { readonly daily: number; readonly weekly: number };
  readonly running: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastFailure: { readonly at: string; readonly message: string } | null;
  readonly snapshots: readonly Pick<
    SnapshotSummary,
    'id' | 'createdAt' | 'attachmentCount' | 'missingAttachments' | 'databaseBytes'
  >[];
}

export interface BackupServiceDependencies {
  readonly workspaces: WorkspaceManager;
  readonly settings: SettingsStore;
  /** `<userData>/backups`. */
  readonly defaultDestination: string;
  readonly appVersion: string;
  readonly now?: () => Date;
  readonly logFailure?: (operation: string, error: unknown) => void;
}

export class BackupService {
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private readonly failures = new Map<string, { at: string; message: string }>();
  private timer: NodeJS.Timeout | null = null;
  private afterOpen: NodeJS.Timeout | null = null;

  public constructor(private readonly dependencies: BackupServiceDependencies) {}

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  /** Starts the hourly check. Call once at startup; `stop` on quit. */
  public start(): void {
    this.timer ??= setInterval(() => {
      const workspace = this.dependencies.workspaces.current;
      if (workspace !== null) void this.backUpIfDue(workspace);
    }, BACKUP_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  /** Schedules the daily backup check for a workspace that was just opened. */
  public scheduleAfterOpen(workspace: OpenWorkspace, delayMs = BACKUP_DELAY_AFTER_OPEN_MS): void {
    if (this.afterOpen !== null) clearTimeout(this.afterOpen);
    this.afterOpen = setTimeout(() => {
      this.afterOpen = null;
      void this.backUpIfDue(workspace);
    }, delayMs);
    this.afterOpen.unref();
  }

  public stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.afterOpen !== null) clearTimeout(this.afterOpen);
    this.timer = null;
    this.afterOpen = null;
  }

  /** Resolves when every backup operation started so far has finished. */
  public async idle(): Promise<void> {
    await this.queue;
  }

  /** Takes today's backup if there is none yet. Never throws; failures appear in the status. */
  public backUpIfDue(workspace: OpenWorkspace): Promise<void> {
    return this.serialize(async () => {
      if (this.dependencies.workspaces.current?.id !== workspace.id) return;
      try {
        const settings = await this.backupSettings();
        const [latest] = await listSnapshots(this.destinationOf(settings), workspace.id);
        if (isBackupDue(latest?.createdAt ?? null, this.now().toISOString(), this.timezone())) {
          await this.backUp(workspace, settings);
        }
      } catch (error) {
        this.recordFailure(workspace.id, error);
      }
    });
  }

  /** Takes a backup now (Settings › Back up now). */
  public backUpNow(): Promise<BackupStatus> {
    return this.serialize(async () => {
      const workspace = this.requireWorkspace();
      try {
        await this.backUp(workspace, await this.backupSettings());
      } catch (error) {
        this.recordFailure(workspace.id, error);
      }
      return this.statusOf(workspace);
    });
  }

  public status(): Promise<BackupStatus> {
    return this.serialize(() => this.statusOf(this.requireWorkspace()));
  }

  /** Stores the destination (null for the default) and returns the new status. */
  public setDestination(destination: string | null): Promise<BackupStatus> {
    return this.serialize(async () => {
      await this.updateSettings({
        destination: destination === null ? null : resolve(destination),
      });
      return this.statusOf(this.requireWorkspace());
    });
  }

  public setRetention(daily: number, weekly: number): Promise<BackupStatus> {
    return this.serialize(async () => {
      await this.updateSettings({ daily, weekly });
      const workspace = this.requireWorkspace();
      const settings = await this.backupSettings();
      await this.prune(workspace, settings);
      return this.statusOf(workspace);
    });
  }

  /**
   * Replaces the open workspace with one of its snapshots. A safety backup of the current state
   * is taken first, so the restore itself can be undone by restoring that one.
   */
  public restoreSnapshot(snapshotId: string): Promise<WorkspaceState> {
    return this.serialize(async () => {
      const workspace = this.requireWorkspace();
      const settings = await this.backupSettings();
      const snapshot = (await listSnapshots(this.destinationOf(settings), workspace.id)).find(
        (item) => item.id === snapshotId,
      );
      if (snapshot === undefined) {
        throw new TransferError('BACKUP_DAMAGED', 'This backup is no longer available.');
      }
      return this.dependencies.workspaces.restoreCurrent(
        async (target) => {
          await buildWorkspaceFromSnapshot(snapshot.folder, target, this.dependencies.appVersion);
        },
        async () => {
          await createSnapshot(workspace, this.destinationOf(settings), {
            appVersion: this.dependencies.appVersion,
            now: () => this.now(),
          });
        },
      );
    });
  }

  /** Restores a snapshot folder chosen by the user as a new workspace and opens it. */
  public restoreFromFolder(snapshotFolder: string): Promise<WorkspaceState> {
    return this.serialize(async () => {
      const manifest = await readSnapshotManifest(snapshotFolder);
      return this.dependencies.workspaces.restoreAsNew(
        manifest.workspaceId,
        manifest.workspaceName,
        async (target) => {
          await buildWorkspaceFromSnapshot(snapshotFolder, target, this.dependencies.appVersion);
        },
      );
    });
  }

  private async backUp(workspace: OpenWorkspace, settings: BackupSettings): Promise<void> {
    this.running = true;
    try {
      await createSnapshot(workspace, this.destinationOf(settings), {
        appVersion: this.dependencies.appVersion,
        now: () => this.now(),
      });
      this.failures.delete(workspace.id);
      await this.prune(workspace, settings);
    } finally {
      this.running = false;
    }
  }

  private async prune(workspace: OpenWorkspace, settings: BackupSettings): Promise<void> {
    const destination = this.destinationOf(settings);
    const snapshots = await listSnapshots(destination, workspace.id);
    const keep = snapshotsToKeep(snapshots, settings, this.timezone());
    await pruneSnapshots(destination, workspace.id, keep).catch((error: unknown) =>
      this.dependencies.logFailure?.('backup pruning', error),
    );
  }

  private async statusOf(workspace: OpenWorkspace): Promise<BackupStatus> {
    const settings = await this.backupSettings();
    const destination = this.destinationOf(settings);
    const snapshots = await listSnapshots(destination, workspace.id);
    return {
      destination,
      isDefaultDestination: settings.destination === null,
      sameDriveAsWorkspace: await onSameDrive(destination, workspace.paths.folder),
      retention: { daily: settings.daily, weekly: settings.weekly },
      running: this.running,
      lastSuccessAt: snapshots[0]?.createdAt ?? null,
      lastFailure: this.failures.get(workspace.id) ?? null,
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        attachmentCount: snapshot.attachmentCount,
        missingAttachments: snapshot.missingAttachments,
        databaseBytes: snapshot.databaseBytes,
      })),
    };
  }

  private recordFailure(workspaceId: string, error: unknown): void {
    this.dependencies.logFailure?.('backup', error);
    this.failures.set(workspaceId, {
      at: this.now().toISOString(),
      message: error instanceof TransferError ? error.message : 'The backup failed.',
    });
  }

  private requireWorkspace(): OpenWorkspace {
    const workspace = this.dependencies.workspaces.current;
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace;
  }

  private timezone(): string {
    const state = this.dependencies.workspaces.getState();
    return state.status === 'open' ? state.workspace.timezone : 'UTC';
  }

  private destinationOf(settings: BackupSettings): string {
    return settings.destination ?? this.dependencies.defaultDestination;
  }

  private async backupSettings(): Promise<BackupSettings> {
    return (await this.dependencies.settings.load()).backups;
  }

  private async updateSettings(changes: Partial<BackupSettings>): Promise<void> {
    const settings = await this.dependencies.settings.load();
    await this.dependencies.settings.save({
      ...settings,
      backups: { ...settings.backups, ...changes },
    });
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * Whether two paths are on the same volume. The destination may not exist yet, so its nearest
 * existing parent is used. Unknown counts as "same drive", which errs on the side of the warning.
 */
async function onSameDrive(destination: string, workspaceFolder: string): Promise<boolean> {
  try {
    let existing = resolve(destination);
    for (;;) {
      const info = await stat(existing).catch(() => null);
      if (info !== null) {
        return info.dev === (await stat(workspaceFolder)).dev;
      }
      const parent = dirname(existing);
      if (parent === existing) return true;
      existing = parent;
    }
  } catch {
    return true;
  }
}
