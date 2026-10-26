/**
 * Workspace lifecycle for the desktop app (PRD §5.1): first-run setup, create, open, switch,
 * rename, recent list, and graceful close.
 *
 * Invariants:
 * - At most one workspace is open. Operations are serialized, so two quick clicks cannot open
 *   two workspaces or close one while another is opening.
 * - Switching keeps the current workspace open until the new one has opened successfully, so a
 *   failed switch never leaves the user with nothing (PRD §5.1: preserve the original until the
 *   destination opens).
 * - A missing or unusable workspace is reported, never replaced by an empty one (PRD §5.1).
 * - Paths come only from settings written by this process or from native dialogs.
 */

import { access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { RecentWorkspace, WorkspaceState } from '@mmap/contracts';
import {
  normalizeWorkspaceName,
  toWorkspaceFolderName,
  type WorkspaceId,
  type WorkspaceRecord,
} from '@mmap/domain';

import {
  forgetWorkspace,
  rememberWorkspace,
  type AppSettings,
  type SettingsStore,
} from './app-settings';
import {
  createOpenWorkspace,
  createWorkspaceServices,
  loadWorkspaceRecord,
  openWorkspaceStorage,
  type OpenWorkspace,
  type ServiceDependencies,
} from './open-workspace';
import { isWorkspaceError, WorkspaceError } from './workspace-errors';
import {
  createWorkspaceFolder,
  directoryExists,
  MANIFEST_FORMAT,
  MANIFEST_FORMAT_VERSION,
  readManifest,
  workspacePaths,
} from './workspace-folder';
import { assessWorkspaceLocation } from './workspace-location';
import { acquireWorkspaceLock, type LockEnvironment } from './workspace-lock';

export const DEFAULT_WORKSPACE_NAME = 'My Knowledge';

export interface WorkspaceManagerDependencies extends ServiceDependencies {
  readonly settings: SettingsStore;
  /** Parent folder for workspaces created in the default location (`<userData>/workspaces`). */
  readonly defaultWorkspacesRoot: string;
  readonly appVersion: string;
  readonly lockEnvironment: LockEnvironment;
  /** IANA timezone recorded for new workspaces. */
  readonly timezone: () => string;
}

interface OpenedState {
  readonly workspace: OpenWorkspace;
  readonly record: WorkspaceRecord;
  readonly cloudSyncProvider: string | null;
}

export class WorkspaceManager {
  private opened: OpenedState | null = null;
  private unavailable: Extract<WorkspaceState, { status: 'unavailable' }> | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly dependencies: WorkspaceManagerDependencies) {}

  /** The open workspace, for services that need its database. */
  public get current(): OpenWorkspace | null {
    return this.opened?.workspace ?? null;
  }

  public getState(): WorkspaceState {
    if (this.opened !== null) {
      const { workspace, record, cloudSyncProvider } = this.opened;
      return {
        status: 'open',
        workspace: {
          id: workspace.id,
          name: record.name,
          folderPath: workspace.paths.folder,
          timezone: record.timezone,
          schemaVersion: workspace.schemaVersion,
          cloudSyncProvider,
        },
      };
    }
    return this.unavailable ?? { status: 'none' };
  }

  /**
   * Called once at launch. Opens the last workspace; on the very first run creates (or adopts)
   * the default workspace so the user can start immediately without any setup (PRD §5.1).
   */
  public startup(): Promise<WorkspaceState> {
    return this.serialize(async () => {
      const settings = await this.dependencies.settings.load();

      if (settings.lastWorkspacePath !== null) {
        await this.openOrRecordFailure(settings.lastWorkspacePath, settings);
        return this.getState();
      }

      if (settings.recentWorkspaces.length === 0) {
        const defaultFolder = join(this.dependencies.defaultWorkspacesRoot, DEFAULT_WORKSPACE_NAME);
        if (await directoryExists(defaultFolder)) {
          // Settings were reset but the default workspace survived: adopt it, never overwrite it.
          await this.openOrRecordFailure(defaultFolder, settings);
        } else {
          await this.createInFolder(
            DEFAULT_WORKSPACE_NAME,
            this.dependencies.defaultWorkspacesRoot,
          );
        }
      }
      return this.getState();
    });
  }

  /** Creates a workspace under `parentFolder` (default root when null) and switches to it. */
  public create(rawName: string, parentFolder: string | null): Promise<WorkspaceState> {
    return this.serialize(async () => {
      await this.createInFolder(rawName, parentFolder ?? this.dependencies.defaultWorkspacesRoot);
      return this.getState();
    });
  }

  /** Opens an existing workspace folder and switches to it. */
  public openFolder(folderPath: string): Promise<WorkspaceState> {
    return this.serialize(async () => {
      await this.switchTo(folderPath);
      return this.getState();
    });
  }

  public openRecent(workspaceId: string): Promise<WorkspaceState> {
    return this.serialize(async () => {
      const settings = await this.dependencies.settings.load();
      const entry = settings.recentWorkspaces.find((recent) => recent.workspaceId === workspaceId);
      if (entry === undefined) {
        throw new WorkspaceError('WORKSPACE_MISSING', 'This workspace is no longer in the list.');
      }
      await this.switchTo(entry.folderPath);
      return this.getState();
    });
  }

  public rename(rawName: string): Promise<WorkspaceState> {
    return this.serialize(async () => {
      const opened = this.requireOpen();
      const record = await opened.workspace.services.workspace.rename(opened.workspace.id, rawName);
      this.opened = { ...opened, record };
      await this.remember(opened.workspace, record);
      return this.getState();
    });
  }

  public listRecent(): Promise<RecentWorkspace[]> {
    return this.serialize(() => this.readRecent());
  }

  /** Removes a workspace from the recent list. Never deletes any files. */
  public forgetRecent(workspaceId: string): Promise<RecentWorkspace[]> {
    return this.serialize(async () => {
      if (this.opened?.workspace.id === workspaceId) {
        throw new WorkspaceError(
          'WORKSPACE_INVALID',
          'The open workspace cannot be removed from the list.',
        );
      }
      const settings = await this.dependencies.settings.load();
      await this.dependencies.settings.save(forgetWorkspace(settings, workspaceId));
      return this.readRecent();
    });
  }

  /** Flushes pending writes and closes the open workspace (app quit). */
  public close(): Promise<void> {
    return this.serialize(async () => {
      const opened = this.opened;
      this.opened = null;
      await opened?.workspace.close();
    });
  }

  private async readRecent(): Promise<RecentWorkspace[]> {
    const settings = await this.dependencies.settings.load();
    const currentId = this.opened?.workspace.id ?? null;
    return Promise.all(
      settings.recentWorkspaces.map(async (entry) => ({
        workspaceId: entry.workspaceId,
        name: entry.name,
        folderPath: entry.folderPath,
        lastOpenedAt: entry.lastOpenedAt,
        isAvailable: await directoryExists(entry.folderPath),
        isCurrent: entry.workspaceId === currentId,
      })),
    );
  }

  private requireOpen(): OpenedState {
    if (this.opened === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return this.opened;
  }

  /** Runs operations one at a time, in call order, regardless of earlier failures. */
  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  private async openOrRecordFailure(folderPath: string, settings: AppSettings): Promise<void> {
    try {
      await this.switchTo(folderPath);
    } catch (error) {
      if (!isWorkspaceError(error)) {
        throw error;
      }
      const known = settings.recentWorkspaces.find((recent) => recent.folderPath === folderPath);
      this.unavailable = {
        status: 'unavailable',
        reason: error.code,
        message: error.message,
        lastWorkspace: { name: known?.name ?? folderPath, folderPath },
      };
    }
  }

  /** Opens `folderPath`; only after success closes the previously open workspace. */
  private async switchTo(rawFolderPath: string): Promise<void> {
    const folderPath = resolve(rawFolderPath);
    if (this.opened?.workspace.paths.folder === folderPath) {
      return;
    }

    const next = await this.openWorkspaceAt(folderPath);
    const previous = this.opened;
    this.opened = next;
    this.unavailable = null;
    await previous?.workspace.close();
    await this.remember(next.workspace, next.record);
  }

  private async openWorkspaceAt(folderPath: string): Promise<OpenedState> {
    const location = assessWorkspaceLocation(folderPath);
    if (location.kind === 'unsupported-network') {
      throw new WorkspaceError(
        'WORKSPACE_UNSUPPORTED_LOCATION',
        'Workspaces on network shares are not supported. Copy the folder to a local drive.',
      );
    }

    const manifest = await readManifest(folderPath);
    const paths = workspacePaths(folderPath);
    if (!(await fileExists(paths.database))) {
      // Never create a fresh database here: that would silently replace the user's data.
      throw new WorkspaceError(
        'WORKSPACE_DAMAGED',
        'The workspace database file is missing. Restore it from a backup.',
      );
    }

    const lock = await acquireWorkspaceLock(paths.lock, this.dependencies.lockEnvironment);
    try {
      const { connections, schemaVersion } = await openWorkspaceStorage(paths);
      const services = createWorkspaceServices(
        connections,
        manifest.workspaceId as WorkspaceId,
        this.dependencies,
      );
      const workspace = createOpenWorkspace({
        paths,
        manifest,
        schemaVersion,
        connections,
        services,
        lock,
      });
      try {
        const record = await loadWorkspaceRecord(services, workspace.id);
        return {
          workspace,
          record,
          cloudSyncProvider: location.kind === 'cloud-sync-warning' ? location.provider : null,
        };
      } catch (error) {
        await workspace.close();
        throw error;
      }
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  private async createInFolder(rawName: string, parentFolder: string): Promise<void> {
    const name = normalizeWorkspaceName(rawName);
    const parent = resolve(parentFolder);
    if (assessWorkspaceLocation(parent).kind === 'unsupported-network') {
      throw new WorkspaceError(
        'WORKSPACE_UNSUPPORTED_LOCATION',
        'Workspaces on network shares are not supported. Choose a folder on a local drive.',
      );
    }

    const folder = await chooseUnusedFolder(parent, toWorkspaceFolderName(name));
    const workspaceId = this.dependencies.ids.newId() as WorkspaceId;
    const { createdFolder } = await createWorkspaceFolder(folder, {
      format: MANIFEST_FORMAT,
      formatVersion: MANIFEST_FORMAT_VERSION,
      workspaceId,
      createdAt: this.dependencies.clock.now(),
      createdWithAppVersion: this.dependencies.appVersion,
    });

    try {
      await this.initializeDatabase(folder, workspaceId, name);
    } catch (error) {
      if (createdFolder) {
        // Only remove a folder this call created (it holds nothing but the files we just wrote).
        await rm(folder, { recursive: true, force: true });
      }
      throw error;
    }

    await this.switchTo(folder);
  }

  private async initializeDatabase(
    folder: string,
    workspaceId: WorkspaceId,
    name: string,
  ): Promise<void> {
    const paths = workspacePaths(folder);
    const lock = await acquireWorkspaceLock(paths.lock, this.dependencies.lockEnvironment);
    try {
      const { connections } = await openWorkspaceStorage(paths);
      try {
        await createWorkspaceServices(
          connections,
          workspaceId,
          this.dependencies,
        ).workspace.initialize(workspaceId, name, this.dependencies.timezone());
      } finally {
        await connections.close();
      }
    } finally {
      await lock.release();
    }
  }

  private async remember(workspace: OpenWorkspace, record: WorkspaceRecord): Promise<void> {
    const settings = await this.dependencies.settings.load();
    await this.dependencies.settings.save(
      rememberWorkspace(settings, {
        workspaceId: workspace.id,
        name: record.name,
        folderPath: workspace.paths.folder,
        lastOpenedAt: this.dependencies.clock.now(),
      }),
    );
  }
}

/** Returns `parent/baseName`, or `parent/baseName (2)`, … for the first that does not exist. */
async function chooseUnusedFolder(parent: string, baseName: string): Promise<string> {
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = join(parent, suffix === 1 ? baseName : `${baseName} (${suffix})`);
    if (!(await directoryExists(candidate))) {
      return candidate;
    }
  }
  throw new WorkspaceError('WORKSPACE_FOLDER_NOT_EMPTY', 'Could not find a free folder name.');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
