/**
 * Shape of the API that the preload script exposes to the renderer as `window.mmap`.
 *
 * The renderer sees named, typed methods only. It cannot choose a channel name, send raw IPC
 * messages, or reach Node/Electron APIs (PRD §8: narrow preload API).
 */

import type { AppInfo } from './app-info';
import type { IpcResult } from './envelope';

export interface MmapRendererApi {
  readonly app: {
    getInfo(): Promise<IpcResult<AppInfo>>;
  };
}
