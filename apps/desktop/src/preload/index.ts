/**
 * Preload bridge (PRD §7.2: "The renderer calls a minimal typed preload bridge").
 *
 * Runs sandboxed with context isolation. Exposes `window.mmap` with one named method per
 * operation. The renderer never sees `ipcRenderer`, cannot pick a channel name, and cannot
 * send arbitrary messages. Inputs are validated again in the main process; this layer is
 * intentionally thin and holds no logic.
 *
 * Only `@mmap/contracts/channels` (no runtime dependencies) and types are imported, keeping the
 * preload bundle tiny.
 */

import { IPC_CHANNELS } from '@mmap/contracts/channels';
import type { MmapRendererApi } from '@mmap/contracts';
import { contextBridge, ipcRenderer } from 'electron';

const api: MmapRendererApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
  },
};

contextBridge.exposeInMainWorld('mmap', api);
