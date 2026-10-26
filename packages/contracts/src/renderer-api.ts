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
  };
  readonly workspace: {
    readonly getState: BridgeCall<'workspace:get-state'>;
    readonly listRecent: BridgeCall<'workspace:list-recent'>;
    readonly create: BridgeCall<'workspace:create'>;
    readonly openFolder: BridgeCall<'workspace:open-folder'>;
    readonly openRecent: BridgeCall<'workspace:open-recent'>;
    readonly forgetRecent: BridgeCall<'workspace:forget-recent'>;
    readonly rename: BridgeCall<'workspace:rename'>;
    readonly revealFolder: BridgeCall<'workspace:reveal-folder'>;
  };
  readonly nodes: {
    readonly list: BridgeCall<'nodes:list'>;
    readonly get: BridgeCall<'nodes:get'>;
    readonly create: BridgeCall<'nodes:create'>;
    readonly update: BridgeCall<'nodes:update'>;
    readonly duplicate: BridgeCall<'nodes:duplicate'>;
    readonly previewDelete: BridgeCall<'nodes:preview-delete'>;
    readonly delete: BridgeCall<'nodes:delete'>;
    readonly addTag: BridgeCall<'nodes:add-tag'>;
    readonly removeTag: BridgeCall<'nodes:remove-tag'>;
  };
  readonly tags: {
    readonly list: BridgeCall<'tags:list'>;
    readonly create: BridgeCall<'tags:create'>;
    readonly rename: BridgeCall<'tags:rename'>;
    readonly delete: BridgeCall<'tags:delete'>;
  };
}
