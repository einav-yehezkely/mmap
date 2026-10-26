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

import type { MmapRendererApi } from '@mmap/contracts';
import { IPC_CHANNELS } from '@mmap/contracts/channels';
import { contextBridge, ipcRenderer } from 'electron';

const api: MmapRendererApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
    openExternalLink: (request) => ipcRenderer.invoke(IPC_CHANNELS.appOpenExternalLink, request),
  },
  workspace: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGetState),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceListRecent),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceCreate, request),
    openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFolder),
    openRecent: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenRecent, request),
    forgetRecent: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceForgetRecent, request),
    rename: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceRename, request),
    revealFolder: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceRevealFolder),
  },
  nodes: {
    list: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesList, request),
    get: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesGet, request),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesCreate, request),
    update: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesUpdate, request),
    duplicate: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesDuplicate, request),
    previewDelete: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesPreviewDelete, request),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesDelete, request),
    addTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesAddTag, request),
    removeTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesRemoveTag, request),
  },
  tags: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.tagsList),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.tagsCreate, request),
    rename: (request) => ipcRenderer.invoke(IPC_CHANNELS.tagsRename, request),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.tagsDelete, request),
  },
  attachments: {
    add: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentsAdd, request),
    list: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentsList, request),
    open: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentsOpen, request),
    remove: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentsRemove, request),
  },
  preferences: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.preferencesGet),
    update: (request) => ipcRenderer.invoke(IPC_CHANNELS.preferencesUpdate, request),
  },
};

contextBridge.exposeInMainWorld('mmap', api);
