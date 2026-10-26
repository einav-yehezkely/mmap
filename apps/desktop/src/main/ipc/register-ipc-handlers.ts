/**
 * Registers every IPC channel from the contract catalogue with its application service.
 *
 * Channels are registered by iterating `IPC_CHANNELS`, and `services` must provide exactly one
 * function per channel, so TypeScript and the loop together guarantee that a channel added to
 * `@mmap/contracts` cannot be left unregistered or wired to the wrong service.
 */

import { IPC_CHANNELS, type IpcChannel } from '@mmap/contracts';
import { ipcMain } from 'electron';

import { createIpcHandler, type IpcHandlerDependencies, type IpcService } from './ipc-handler';

export type IpcServices = { readonly [Channel in IpcChannel]: IpcService<Channel> };

export function registerIpcHandlers(
  services: IpcServices,
  dependencies: IpcHandlerDependencies,
): void {
  for (const channel of Object.values(IPC_CHANNELS)) {
    registerChannel(channel, services, dependencies);
  }
}

function registerChannel<Channel extends IpcChannel>(
  channel: Channel,
  services: IpcServices,
  dependencies: IpcHandlerDependencies,
): void {
  ipcMain.handle(channel, createIpcHandler(channel, services[channel], dependencies));
}
