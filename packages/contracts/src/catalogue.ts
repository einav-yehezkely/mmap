/**
 * IPC contract catalogue: the single place that pairs each channel with its request and
 * success-response schemas.
 *
 * The main process validates every incoming request against `request` before any handler runs
 * (PRD §7.2: "Main-process handlers validate input and sender"). Schemas use strict objects so
 * that unexpected properties are rejected rather than silently ignored.
 */

import type { z } from 'zod';

import { appInfoRequestSchema, appInfoSchema } from './app-info';
import { IPC_CHANNELS, type IpcChannel } from './channels';
import { nodeContracts } from './nodes';
import { workspaceContracts } from './workspace';

export interface IpcContract<
  RequestSchema extends z.ZodType = z.ZodType,
  ResponseSchema extends z.ZodType = z.ZodType,
> {
  readonly request: RequestSchema;
  readonly response: ResponseSchema;
}

export const IPC_CATALOGUE = {
  [IPC_CHANNELS.appGetInfo]: { request: appInfoRequestSchema, response: appInfoSchema },
  [IPC_CHANNELS.workspaceGetState]: workspaceContracts.getState,
  [IPC_CHANNELS.workspaceListRecent]: workspaceContracts.listRecent,
  [IPC_CHANNELS.workspaceCreate]: workspaceContracts.create,
  [IPC_CHANNELS.workspaceOpenFolder]: workspaceContracts.openFolder,
  [IPC_CHANNELS.workspaceOpenRecent]: workspaceContracts.openRecent,
  [IPC_CHANNELS.workspaceForgetRecent]: workspaceContracts.forgetRecent,
  [IPC_CHANNELS.workspaceRename]: workspaceContracts.rename,
  [IPC_CHANNELS.workspaceRevealFolder]: workspaceContracts.revealFolder,
  [IPC_CHANNELS.nodesList]: nodeContracts.list,
  [IPC_CHANNELS.nodesGet]: nodeContracts.get,
  [IPC_CHANNELS.nodesCreate]: nodeContracts.create,
  [IPC_CHANNELS.nodesUpdate]: nodeContracts.update,
  [IPC_CHANNELS.nodesDuplicate]: nodeContracts.duplicate,
  [IPC_CHANNELS.nodesPreviewDelete]: nodeContracts.previewDelete,
  [IPC_CHANNELS.nodesDelete]: nodeContracts.delete,
} as const satisfies Record<IpcChannel, IpcContract>;

export type IpcCatalogue = typeof IPC_CATALOGUE;

/** Parsed request type for a channel. */
export type IpcRequest<Channel extends IpcChannel> = z.infer<IpcCatalogue[Channel]['request']>;

/** Success data type for a channel (the `data` field of a successful envelope). */
export type IpcResponse<Channel extends IpcChannel> = z.infer<IpcCatalogue[Channel]['response']>;
