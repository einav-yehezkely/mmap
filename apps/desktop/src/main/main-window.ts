/**
 * Creates the main application window with the security settings required by PRD §8.
 */

import { join } from 'node:path';

import { BrowserWindow } from 'electron';

export interface MainWindowOptions {
  readonly entryUrl: string;
  readonly preloadPath: string;
  /** Developer tools are available only in unpackaged development builds. */
  readonly allowDevTools: boolean;
  /** When false the window stays hidden (used by the packaged smoke test). */
  readonly showWhenReady: boolean;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'mmap',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: options.preloadPath,
      // The renderer runs untrusted-by-default content (notes, imported data). It gets no Node
      // APIs, runs in Chromium's OS-level sandbox, and only sees the narrow preload bridge.
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
      devTools: options.allowDevTools,
    },
  });

  if (options.showWhenReady) {
    window.once('ready-to-show', () => window.show());
  }

  void window.loadURL(options.entryUrl);
  return window;
}

/** Location of the bundled preload script relative to the bundled main script. */
export function resolvePreloadPath(mainDirectory: string): string {
  return join(mainDirectory, '../preload/index.cjs');
}

/** Location of the bundled renderer relative to the bundled main script. */
export function resolveRendererRoot(mainDirectory: string): string {
  return join(mainDirectory, '../renderer');
}
