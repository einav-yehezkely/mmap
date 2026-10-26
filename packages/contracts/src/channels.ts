/**
 * IPC channel names.
 *
 * This file intentionally has no dependencies so the sandboxed preload script can import it
 * without bundling validation libraries. Every channel listed here must also have request and
 * response schemas in `catalogue.ts`; a unit test enforces that the two lists match.
 *
 * Naming: `<area>:<verb-noun>`. Channels are an allow-list: the preload bridge refuses to call
 * anything not listed, and the main process only registers handlers for listed channels.
 */
export const IPC_CHANNELS = {
  appGetInfo: 'app:get-info',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
