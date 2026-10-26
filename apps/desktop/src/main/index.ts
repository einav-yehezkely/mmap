/**
 * Main-process composition root.
 *
 * Startup order matters for security:
 * 1. Register the privileged `app://` scheme (only allowed before `ready`).
 * 2. Install process-wide web-contents guards before any window exists.
 * 3. After `ready`: harden the session, serve the renderer, open the workspace, register IPC,
 *    create the window.
 *
 * Shutdown: quitting waits for the workspace to flush queued writes and release its lock
 * (PRD §5.1: "Flush pending saves on close").
 *
 * No network calls are made anywhere in this process (PRD §8: core workflows are offline).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { toUtcTimestamp } from '@mmap/domain';
import type { BrowserWindow } from 'electron';
import { app, dialog, Menu, session, shell } from 'electron';

import { registerIpcHandlers } from './ipc/register-ipc-handlers';
import { createRedactedLogger } from './logging';
import { createMainWindow, resolvePreloadPath, resolveRendererRoot } from './main-window';
import {
  registerAppSchemeAsPrivileged,
  serveRendererFromAppProtocol,
} from './security/app-protocol';
import { guardAllWebContents, hardenSession } from './security/harden-electron';
import { resolveRendererLocation } from './security/trusted-origins';
import { createAppInfoService } from './services/app-info-service';
import {
  createWorkspaceIpcServices,
  type NativeWorkspaceInteractions,
} from './services/workspace-ipc-services';
import { isSmokeTestRun, runSmokeTest, smokeReportPath, writeSmokeReport } from './smoke-test';
import { createFileSettingsStore } from './workspaces/app-settings';
import { WorkspaceManager } from './workspaces/workspace-manager';
import { isProcessAlive } from './workspaces/workspace-lock';

const mainDirectory = import.meta.dirname;
const smokeTest = isSmokeTestRun(process.argv);

if (smokeTest) {
  // Isolate the smoke test from the user's real profile, settings and workspaces, and from a
  // running mmap instance: all of them live under `userData`.
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'mmap-smoke-profile-')));
}

const rendererLocation = resolveRendererLocation(app.isPackaged, process.env.ELECTRON_RENDERER_URL);
const logger = createRedactedLogger({ includeStacks: !app.isPackaged });

registerAppSchemeAsPrivileged();
guardAllWebContents(rendererLocation);

const workspaces = new WorkspaceManager({
  settings: createFileSettingsStore(app.getPath('userData')),
  defaultWorkspacesRoot: join(app.getPath('userData'), 'workspaces'),
  appVersion: app.getVersion(),
  timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  clock: { now: () => toUtcTimestamp(new Date()) },
  ids: { newId: () => randomUUID() },
  lockEnvironment: {
    pid: process.pid,
    hostname: hostname(),
    instanceId: randomUUID(),
    now: () => new Date(),
    isProcessAlive,
  },
});

let mainWindow: BrowserWindow | null = null;

// One app instance per user profile; a second launch focuses the existing window. The workspace
// lock additionally protects a workspace folder opened from another profile or computer.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  let workspaceClosed = false;
  app.on('before-quit', (event) => {
    if (workspaceClosed) {
      return;
    }
    // Delay quitting until queued writes are committed and the lock is released.
    event.preventDefault();
    workspaces
      .close()
      .catch((error: unknown) => logger.error('workspace close', error))
      .finally(() => {
        workspaceClosed = true;
        app.quit();
      });
  });

  app.whenReady().then(startApplication, (error: unknown) => {
    logger.error('startup', error);
    app.exit(1);
  });
}

const nativeInteractions: NativeWorkspaceInteractions = {
  async chooseFolder(purpose) {
    const options: Electron.OpenDialogOptions = {
      title:
        purpose === 'open-workspace'
          ? 'Open an mmap workspace folder'
          : 'Choose where to create the workspace',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  async revealFolder(folderPath) {
    // `openPath` resolves with an error message, or an empty string on success.
    return (await shell.openPath(folderPath)) === '';
  },
};

async function startApplication(): Promise<void> {
  if (app.isPackaged) {
    // Removes the default menu, which exposes developer tools and reload shortcuts.
    Menu.setApplicationMenu(null);
  }

  hardenSession(session.defaultSession, rendererLocation);
  serveRendererFromAppProtocol(resolveRendererRoot(mainDirectory));

  try {
    await workspaces.startup();
  } catch (error) {
    // The window still opens; the renderer shows the workspace chooser for state "none".
    logger.error('workspace startup', error);
  }

  registerIpcHandlers(
    {
      'app:get-info': createAppInfoService({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
      }),
      ...createWorkspaceIpcServices(workspaces, nativeInteractions),
    },
    {
      trustedOrigins: rendererLocation.trustedOrigins,
      logFailure: (channel, error) => logger.error(`ipc ${channel}`, error),
    },
  );

  mainWindow = createMainWindow({
    entryUrl: rendererLocation.entryUrl,
    preloadPath: resolvePreloadPath(mainDirectory),
    allowDevTools: !app.isPackaged,
    showWhenReady: !smokeTest,
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (smokeTest) {
    const report = await runSmokeTest(mainWindow);
    await workspaces.close();
    writeSmokeReport(report, smokeReportPath(process.argv));
    app.exit(report.passed ? 0 : 1);
  }
}
