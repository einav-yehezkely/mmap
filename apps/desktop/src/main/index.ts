/**
 * Main-process composition root.
 *
 * Startup order matters for security:
 * 1. Register the privileged `app://` scheme (only allowed before `ready`).
 * 2. Install process-wide web-contents guards before any window exists.
 * 3. After `ready`: harden the session, serve the renderer, register IPC, create the window.
 *
 * No network calls are made anywhere in this process (PRD §8: core workflows are offline).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, Menu, session } from 'electron';

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
import { isSmokeTestRun, runSmokeTest, smokeReportPath, writeSmokeReport } from './smoke-test';

const mainDirectory = import.meta.dirname;
const smokeTest = isSmokeTestRun(process.argv);

if (smokeTest) {
  // Isolate the smoke test from the user's real profile and from a running mmap instance:
  // the single-instance lock and Chromium profile both live under `userData`.
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'mmap-smoke-profile-')));
}

const rendererLocation = resolveRendererLocation(app.isPackaged, process.env.ELECTRON_RENDERER_URL);
const logger = createRedactedLogger({ includeStacks: !app.isPackaged });

registerAppSchemeAsPrivileged();
guardAllWebContents(rendererLocation);

// A second instance would open the same workspace database from another process. Until the
// workspace lock arrives in Phase 1, the simplest safe behaviour is to focus the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existingWindow] = BrowserWindow.getAllWindows();
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.whenReady().then(startApplication, (error: unknown) => {
    logger.error('startup', error);
    app.exit(1);
  });
}

async function startApplication(): Promise<void> {
  if (app.isPackaged) {
    // Removes the default menu, which exposes developer tools and reload shortcuts.
    Menu.setApplicationMenu(null);
  }

  hardenSession(session.defaultSession, rendererLocation);
  serveRendererFromAppProtocol(resolveRendererRoot(mainDirectory));

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
    },
    {
      trustedOrigins: rendererLocation.trustedOrigins,
      logFailure: (channel, error) => logger.error(`ipc ${channel}`, error),
    },
  );

  const window = createMainWindow({
    entryUrl: rendererLocation.entryUrl,
    preloadPath: resolvePreloadPath(mainDirectory),
    allowDevTools: !app.isPackaged,
    showWhenReady: !smokeTest,
  });

  if (smokeTest) {
    const report = await runSmokeTest(window);
    writeSmokeReport(report, smokeReportPath(process.argv));
    app.exit(report.passed ? 0 : 1);
  }
}
