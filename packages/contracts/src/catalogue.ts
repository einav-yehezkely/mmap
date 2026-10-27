/**
 * IPC contract catalogue: the single place that pairs each channel with its request and
 * success-response schemas.
 *
 * The main process validates every incoming request against `request` before any handler runs
 * (PRD §7.2: "Main-process handlers validate input and sender"). Schemas use strict objects so
 * that unexpected properties are rejected rather than silently ignored.
 */

import type { z } from 'zod';

import { appInfoRequestSchema, appInfoSchema, openExternalLinkContract } from './app-info';
import { attachmentContracts, preferenceContracts } from './attachments';
import { IPC_CHANNELS, type IpcChannel } from './channels';
import { nodeContracts, searchContracts, tagContracts } from './nodes';
import { graphContracts, timelineContracts } from './graph-timeline';
import { mapContracts } from './maps';
import { relationshipContracts, relationshipTypeContracts } from './relationships';
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
  [IPC_CHANNELS.appOpenExternalLink]: openExternalLinkContract,
  [IPC_CHANNELS.workspaceGetState]: workspaceContracts.getState,
  [IPC_CHANNELS.workspaceListRecent]: workspaceContracts.listRecent,
  [IPC_CHANNELS.workspaceCreate]: workspaceContracts.create,
  [IPC_CHANNELS.workspaceOpenFolder]: workspaceContracts.openFolder,
  [IPC_CHANNELS.workspaceOpenRecent]: workspaceContracts.openRecent,
  [IPC_CHANNELS.workspaceForgetRecent]: workspaceContracts.forgetRecent,
  [IPC_CHANNELS.workspaceRename]: workspaceContracts.rename,
  [IPC_CHANNELS.workspaceRevealFolder]: workspaceContracts.revealFolder,
  [IPC_CHANNELS.workspaceMove]: workspaceContracts.move,
  [IPC_CHANNELS.workspaceDelete]: workspaceContracts.delete,
  [IPC_CHANNELS.workspaceSetTimezone]: workspaceContracts.setTimezone,
  [IPC_CHANNELS.nodesList]: nodeContracts.list,
  [IPC_CHANNELS.nodesGet]: nodeContracts.get,
  [IPC_CHANNELS.nodesCreate]: nodeContracts.create,
  [IPC_CHANNELS.nodesUpdate]: nodeContracts.update,
  [IPC_CHANNELS.nodesDuplicate]: nodeContracts.duplicate,
  [IPC_CHANNELS.nodesPreviewDelete]: nodeContracts.previewDelete,
  [IPC_CHANNELS.nodesDelete]: nodeContracts.delete,
  [IPC_CHANNELS.nodesLookup]: nodeContracts.lookup,
  [IPC_CHANNELS.nodesBacklinks]: nodeContracts.backlinks,
  [IPC_CHANNELS.nodesResolveLinks]: nodeContracts.resolveLinks,
  [IPC_CHANNELS.searchQuery]: searchContracts.query,
  [IPC_CHANNELS.nodesAddTag]: nodeContracts.addTag,
  [IPC_CHANNELS.nodesRemoveTag]: nodeContracts.removeTag,
  [IPC_CHANNELS.tagsList]: tagContracts.list,
  [IPC_CHANNELS.tagsCreate]: tagContracts.create,
  [IPC_CHANNELS.tagsRename]: tagContracts.rename,
  [IPC_CHANNELS.tagsDelete]: tagContracts.delete,
  [IPC_CHANNELS.attachmentsAdd]: attachmentContracts.add,
  [IPC_CHANNELS.attachmentsList]: attachmentContracts.list,
  [IPC_CHANNELS.attachmentsOpen]: attachmentContracts.open,
  [IPC_CHANNELS.attachmentsRemove]: attachmentContracts.remove,
  [IPC_CHANNELS.preferencesGet]: preferenceContracts.get,
  [IPC_CHANNELS.preferencesUpdate]: preferenceContracts.update,
  [IPC_CHANNELS.relationshipTypesList]: relationshipTypeContracts.list,
  [IPC_CHANNELS.relationshipTypesCreate]: relationshipTypeContracts.create,
  [IPC_CHANNELS.relationshipTypesRename]: relationshipTypeContracts.rename,
  [IPC_CHANNELS.relationshipTypesSetArchived]: relationshipTypeContracts.setArchived,
  [IPC_CHANNELS.relationshipTypesSetDirectionality]: relationshipTypeContracts.setDirectionality,
  [IPC_CHANNELS.relationshipsListForNode]: relationshipContracts.listForNode,
  [IPC_CHANNELS.relationshipsCreate]: relationshipContracts.create,
  [IPC_CHANNELS.relationshipsUpdate]: relationshipContracts.update,
  [IPC_CHANNELS.relationshipsDelete]: relationshipContracts.delete,
  [IPC_CHANNELS.mapsList]: mapContracts.list,
  [IPC_CHANNELS.mapsCreate]: mapContracts.create,
  [IPC_CHANNELS.mapsGet]: mapContracts.get,
  [IPC_CHANNELS.mapsRename]: mapContracts.rename,
  [IPC_CHANNELS.mapsDuplicate]: mapContracts.duplicate,
  [IPC_CHANNELS.mapsDelete]: mapContracts.delete,
  [IPC_CHANNELS.mapsSetViewport]: mapContracts.setViewport,
  [IPC_CHANNELS.mapsAddPlacement]: mapContracts.addPlacement,
  [IPC_CHANNELS.mapsRemovePlacement]: mapContracts.removePlacement,
  [IPC_CHANNELS.mapsMovePlacements]: mapContracts.movePlacements,
  [IPC_CHANNELS.mapsReparent]: mapContracts.reparent,
  [IPC_CHANNELS.mapsSetCollapsed]: mapContracts.setCollapsed,
  [IPC_CHANNELS.mapsSetPlacementColor]: mapContracts.setPlacementColor,
  [IPC_CHANNELS.mapsAddConnection]: mapContracts.addConnection,
  [IPC_CHANNELS.mapsRemoveConnection]: mapContracts.removeConnection,
  [IPC_CHANNELS.mapsProposeHierarchy]: mapContracts.proposeHierarchy,
  [IPC_CHANNELS.mapsSwitchMode]: mapContracts.switchMode,
  [IPC_CHANNELS.graphOverview]: graphContracts.overview,
  [IPC_CHANNELS.graphNeighborhood]: graphContracts.neighborhood,
  [IPC_CHANNELS.graphGetPositions]: graphContracts.getPositions,
  [IPC_CHANNELS.graphSavePositions]: graphContracts.savePositions,
  [IPC_CHANNELS.timelineList]: timelineContracts.list,
  [IPC_CHANNELS.timelineMarkReviewed]: timelineContracts.markReviewed,
  [IPC_CHANNELS.timelineUpdateReflection]: timelineContracts.updateReflection,
  [IPC_CHANNELS.timelineDeleteReviewed]: timelineContracts.deleteReviewed,
} as const satisfies Record<IpcChannel, IpcContract>;

export type IpcCatalogue = typeof IPC_CATALOGUE;

/** Parsed request type for a channel. */
export type IpcRequest<Channel extends IpcChannel> = z.infer<IpcCatalogue[Channel]['request']>;

/** Success data type for a channel (the `data` field of a successful envelope). */
export type IpcResponse<Channel extends IpcChannel> = z.infer<IpcCatalogue[Channel]['response']>;
