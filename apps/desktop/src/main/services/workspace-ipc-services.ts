/**
 * IPC-facing workspace operations. Translates renderer requests into workspace-manager calls and
 * performs the native interactions (folder dialogs, revealing a folder in Explorer).
 *
 * Paths reach the manager only from a native dialog the user just confirmed or from the manager's
 * own settings, never from the renderer (PRD §8).
 */

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { WorkspaceManager } from '../workspaces/workspace-manager';

export interface NativeWorkspaceInteractions {
  /** Shows a folder picker. Resolves with the chosen absolute path, or null when cancelled. */
  chooseFolder(
    purpose: 'create-workspace-in' | 'open-workspace' | 'move-workspace-to',
  ): Promise<string | null>;
  /** Opens a folder in the OS file manager. Resolves false when the OS reports a failure. */
  revealFolder(folderPath: string): Promise<boolean>;
}

type WorkspaceChannel = Extract<keyof IpcServices, `workspace:${string}`>;

export function createWorkspaceIpcServices(
  manager: WorkspaceManager,
  native: NativeWorkspaceInteractions,
): Pick<IpcServices, WorkspaceChannel> {
  return {
    'workspace:get-state': () => Promise.resolve(manager.getState()),

    'workspace:get-change-count': () =>
      Promise.resolve({ count: manager.current?.connections.commitCount ?? 0 }),

    'workspace:list-recent': async () => ({ items: await manager.listRecent() }),

    'workspace:create': async ({ name, location }) => {
      let parentFolder: string | null = null;
      if (location === 'choose-folder') {
        parentFolder = await native.chooseFolder('create-workspace-in');
        if (parentFolder === null) {
          return { cancelled: true, state: manager.getState() };
        }
      }
      return { cancelled: false, state: await manager.create(name, parentFolder) };
    },

    'workspace:open-folder': async () => {
      const folder = await native.chooseFolder('open-workspace');
      if (folder === null) {
        return { cancelled: true, state: manager.getState() };
      }
      return { cancelled: false, state: await manager.openFolder(folder) };
    },

    'workspace:open-recent': ({ workspaceId }) => manager.openRecent(workspaceId),

    'workspace:forget-recent': async ({ workspaceId }) => ({
      items: await manager.forgetRecent(workspaceId),
    }),

    'workspace:rename': ({ name }) => manager.rename(name),
    'workspace:set-timezone': ({ timezone }) => manager.setTimezone(timezone),

    'workspace:reveal-folder': async () => {
      const folder = manager.current?.paths.folder;
      return { revealed: folder === undefined ? false : await native.revealFolder(folder) };
    },

    'workspace:move': async () => {
      const target = await native.chooseFolder('move-workspace-to');
      if (target === null) {
        return {
          cancelled: true,
          state: manager.getState(),
          originalRemoved: false,
          originalFolder: null,
        };
      }
      const result = await manager.move(target);
      return { cancelled: false, ...result };
    },

    'workspace:delete': async ({ confirmName }) => ({
      state: await manager.deleteCurrent(confirmName),
    }),
  };
}
