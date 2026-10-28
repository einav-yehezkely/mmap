/**
 * Shape of the API that the preload script exposes to the renderer as `window.mmap`.
 *
 * The renderer sees named, typed methods only. It cannot choose a channel name, send raw IPC
 * messages, or reach Node/Electron APIs (PRD §8: narrow preload API).
 */

import type { IpcRequest, IpcResponse } from './catalogue';
import type { IpcChannel } from './channels';
import type { IpcResult } from './envelope';

/** A bridge method for one channel: takes the channel's request, resolves with its envelope. */
type BridgeCall<Channel extends IpcChannel> =
  IpcRequest<Channel> extends undefined
    ? () => Promise<IpcResult<IpcResponse<Channel>>>
    : (request: IpcRequest<Channel>) => Promise<IpcResult<IpcResponse<Channel>>>;

export interface MmapRendererApi {
  readonly app: {
    readonly getInfo: BridgeCall<'app:get-info'>;
    readonly openExternalLink: BridgeCall<'app:open-external-link'>;
    readonly openWindow: BridgeCall<'app:open-window'>;
  };
  readonly workspace: {
    readonly getState: BridgeCall<'workspace:get-state'>;
    readonly getChangeCount: BridgeCall<'workspace:get-change-count'>;
    readonly listRecent: BridgeCall<'workspace:list-recent'>;
    readonly create: BridgeCall<'workspace:create'>;
    readonly openFolder: BridgeCall<'workspace:open-folder'>;
    readonly openRecent: BridgeCall<'workspace:open-recent'>;
    readonly forgetRecent: BridgeCall<'workspace:forget-recent'>;
    readonly rename: BridgeCall<'workspace:rename'>;
    readonly revealFolder: BridgeCall<'workspace:reveal-folder'>;
    readonly move: BridgeCall<'workspace:move'>;
    readonly delete: BridgeCall<'workspace:delete'>;
    readonly setTimezone: BridgeCall<'workspace:set-timezone'>;
  };
  readonly nodes: {
    readonly list: BridgeCall<'nodes:list'>;
    readonly get: BridgeCall<'nodes:get'>;
    readonly create: BridgeCall<'nodes:create'>;
    readonly update: BridgeCall<'nodes:update'>;
    readonly duplicate: BridgeCall<'nodes:duplicate'>;
    readonly previewDelete: BridgeCall<'nodes:preview-delete'>;
    readonly delete: BridgeCall<'nodes:delete'>;
    readonly lookup: BridgeCall<'nodes:lookup'>;
    readonly backlinks: BridgeCall<'nodes:backlinks'>;
    readonly resolveLinks: BridgeCall<'nodes:resolve-links'>;
    readonly addTag: BridgeCall<'nodes:add-tag'>;
    readonly removeTag: BridgeCall<'nodes:remove-tag'>;
  };
  readonly search: {
    readonly query: BridgeCall<'search:query'>;
  };
  readonly tags: {
    readonly list: BridgeCall<'tags:list'>;
    readonly create: BridgeCall<'tags:create'>;
    readonly rename: BridgeCall<'tags:rename'>;
    readonly delete: BridgeCall<'tags:delete'>;
  };
  readonly attachments: {
    readonly add: BridgeCall<'attachments:add'>;
    readonly list: BridgeCall<'attachments:list'>;
    readonly open: BridgeCall<'attachments:open'>;
    readonly remove: BridgeCall<'attachments:remove'>;
  };
  readonly preferences: {
    readonly get: BridgeCall<'preferences:get'>;
    readonly update: BridgeCall<'preferences:update'>;
  };
  readonly relationshipTypes: {
    readonly list: BridgeCall<'relationship-types:list'>;
    readonly create: BridgeCall<'relationship-types:create'>;
    readonly rename: BridgeCall<'relationship-types:rename'>;
    readonly setArchived: BridgeCall<'relationship-types:set-archived'>;
    readonly setDirectionality: BridgeCall<'relationship-types:set-directionality'>;
  };
  readonly relationships: {
    readonly listForNode: BridgeCall<'relationships:list-for-node'>;
    readonly create: BridgeCall<'relationships:create'>;
    readonly update: BridgeCall<'relationships:update'>;
    readonly delete: BridgeCall<'relationships:delete'>;
  };
  readonly graph: {
    readonly overview: BridgeCall<'graph:overview'>;
    readonly neighborhood: BridgeCall<'graph:neighborhood'>;
    readonly getPositions: BridgeCall<'graph:get-positions'>;
    readonly savePositions: BridgeCall<'graph:save-positions'>;
  };
  readonly timeline: {
    readonly list: BridgeCall<'timeline:list'>;
    readonly window: BridgeCall<'timeline:window'>;
    readonly markReviewed: BridgeCall<'timeline:mark-reviewed'>;
    readonly addMilestone: BridgeCall<'timeline:add-milestone'>;
    readonly updateEntry: BridgeCall<'timeline:update-entry'>;
    readonly deleteEntry: BridgeCall<'timeline:delete-entry'>;
  };
  readonly transfer: {
    readonly exportZip: BridgeCall<'transfer:export-zip'>;
    readonly exportMarkdown: BridgeCall<'transfer:export-markdown'>;
    readonly previewImport: BridgeCall<'transfer:preview-import'>;
    readonly applyImport: BridgeCall<'transfer:apply-import'>;
    readonly discardImport: BridgeCall<'transfer:discard-import'>;
  };
  readonly backups: {
    readonly getStatus: BridgeCall<'backups:get-status'>;
    readonly createNow: BridgeCall<'backups:create-now'>;
    readonly chooseDestination: BridgeCall<'backups:choose-destination'>;
    readonly useDefaultDestination: BridgeCall<'backups:use-default-destination'>;
    readonly setRetention: BridgeCall<'backups:set-retention'>;
    readonly restore: BridgeCall<'backups:restore'>;
    readonly restoreFromFolder: BridgeCall<'backups:restore-from-folder'>;
  };
  readonly operations: {
    readonly getProgress: BridgeCall<'operations:get-progress'>;
    readonly cancel: BridgeCall<'operations:cancel'>;
  };
  readonly maps: {
    readonly list: BridgeCall<'maps:list'>;
    readonly listForNode: BridgeCall<'maps:list-for-node'>;
    readonly addNode: BridgeCall<'maps:add-node'>;
    readonly create: BridgeCall<'maps:create'>;
    readonly get: BridgeCall<'maps:get'>;
    readonly rename: BridgeCall<'maps:rename'>;
    readonly duplicate: BridgeCall<'maps:duplicate'>;
    readonly delete: BridgeCall<'maps:delete'>;
    readonly setViewport: BridgeCall<'maps:set-viewport'>;
    readonly addPlacement: BridgeCall<'maps:add-placement'>;
    readonly removePlacement: BridgeCall<'maps:remove-placement'>;
    readonly movePlacements: BridgeCall<'maps:move-placements'>;
    readonly reparent: BridgeCall<'maps:reparent'>;
    readonly setCollapsed: BridgeCall<'maps:set-collapsed'>;
    readonly setPlacementColor: BridgeCall<'maps:set-placement-color'>;
    readonly addConnection: BridgeCall<'maps:add-connection'>;
    readonly removeConnection: BridgeCall<'maps:remove-connection'>;
    readonly setConnectionLabel: BridgeCall<'maps:set-connection-label'>;
    readonly setConnectionRelationship: BridgeCall<'maps:set-connection-relationship'>;
    readonly proposeHierarchy: BridgeCall<'maps:propose-hierarchy'>;
    readonly switchMode: BridgeCall<'maps:switch-mode'>;
  };
}
