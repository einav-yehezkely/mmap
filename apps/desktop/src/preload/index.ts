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
    move: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceMove),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceDelete, request),
    setTimezone: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSetTimezone, request),
  },
  nodes: {
    list: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesList, request),
    get: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesGet, request),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesCreate, request),
    update: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesUpdate, request),
    duplicate: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesDuplicate, request),
    previewDelete: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesPreviewDelete, request),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesDelete, request),
    lookup: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesLookup, request),
    backlinks: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesBacklinks, request),
    resolveLinks: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesResolveLinks, request),
    addTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesAddTag, request),
    removeTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.nodesRemoveTag, request),
  },
  search: {
    query: (request) => ipcRenderer.invoke(IPC_CHANNELS.searchQuery, request),
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
  relationshipTypes: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.relationshipTypesList),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.relationshipTypesCreate, request),
    rename: (request) => ipcRenderer.invoke(IPC_CHANNELS.relationshipTypesRename, request),
    setArchived: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.relationshipTypesSetArchived, request),
    setDirectionality: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.relationshipTypesSetDirectionality, request),
  },
  relationships: {
    listForNode: (request) => ipcRenderer.invoke(IPC_CHANNELS.relationshipsListForNode, request),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.relationshipsCreate, request),
    update: (request) => ipcRenderer.invoke(IPC_CHANNELS.relationshipsUpdate, request),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.relationshipsDelete, request),
  },
  graph: {
    overview: (request) => ipcRenderer.invoke(IPC_CHANNELS.graphOverview, request),
    neighborhood: (request) => ipcRenderer.invoke(IPC_CHANNELS.graphNeighborhood, request),
    getPositions: (request) => ipcRenderer.invoke(IPC_CHANNELS.graphGetPositions, request),
    savePositions: (request) => ipcRenderer.invoke(IPC_CHANNELS.graphSavePositions, request),
  },
  timeline: {
    list: (request) => ipcRenderer.invoke(IPC_CHANNELS.timelineList, request),
    window: (request) => ipcRenderer.invoke(IPC_CHANNELS.timelineWindow, request),
    markReviewed: (request) => ipcRenderer.invoke(IPC_CHANNELS.timelineMarkReviewed, request),
    addMilestone: (request) => ipcRenderer.invoke(IPC_CHANNELS.timelineAddMilestone, request),
    updateEntry: (request) => ipcRenderer.invoke(IPC_CHANNELS.timelineUpdateEntry, request),
    deleteEntry: (request) => ipcRenderer.invoke(IPC_CHANNELS.timelineDeleteEntry, request),
  },
  transfer: {
    exportZip: (request) => ipcRenderer.invoke(IPC_CHANNELS.transferExportZip, request),
    exportMarkdown: (request) => ipcRenderer.invoke(IPC_CHANNELS.transferExportMarkdown, request),
    previewImport: (request) => ipcRenderer.invoke(IPC_CHANNELS.transferPreviewImport, request),
    applyImport: (request) => ipcRenderer.invoke(IPC_CHANNELS.transferApplyImport, request),
    discardImport: (request) => ipcRenderer.invoke(IPC_CHANNELS.transferDiscardImport, request),
  },
  backups: {
    getStatus: (request) => ipcRenderer.invoke(IPC_CHANNELS.backupsGetStatus, request),
    createNow: (request) => ipcRenderer.invoke(IPC_CHANNELS.backupsCreateNow, request),
    chooseDestination: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.backupsChooseDestination, request),
    useDefaultDestination: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.backupsUseDefaultDestination, request),
    setRetention: (request) => ipcRenderer.invoke(IPC_CHANNELS.backupsSetRetention, request),
    restore: (request) => ipcRenderer.invoke(IPC_CHANNELS.backupsRestore, request),
    restoreFromFolder: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.backupsRestoreFromFolder, request),
  },
  maps: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.mapsList),
    create: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsCreate, request),
    get: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsGet, request),
    rename: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsRename, request),
    duplicate: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsDuplicate, request),
    delete: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsDelete, request),
    setViewport: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsSetViewport, request),
    addPlacement: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsAddPlacement, request),
    removePlacement: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsRemovePlacement, request),
    movePlacements: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsMovePlacements, request),
    reparent: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsReparent, request),
    setCollapsed: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsSetCollapsed, request),
    setPlacementColor: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsSetPlacementColor, request),
    addConnection: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsAddConnection, request),
    removeConnection: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsRemoveConnection, request),
    proposeHierarchy: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsProposeHierarchy, request),
    switchMode: (request) => ipcRenderer.invoke(IPC_CHANNELS.mapsSwitchMode, request),
  },
};

contextBridge.exposeInMainWorld('mmap', api);
