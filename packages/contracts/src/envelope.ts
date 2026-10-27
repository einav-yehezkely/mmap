/**
 * IPC result envelope.
 *
 * Electron flattens errors thrown in `ipcMain.handle` into a string message, which loses the error
 * code and may leak internal details. Instead, every handler resolves with an explicit envelope:
 * either `{ ok: true, data }` or `{ ok: false, error }` with a stable code and a safe message.
 */

import { DOMAIN_ERROR_CODES } from '@mmap/domain';
import { z } from 'zod';

import { TRANSFER_ERROR_CODES } from './transfer';
import { WORKSPACE_ERROR_CODES } from './workspace';

/** Error codes produced by the transport layer itself, in addition to domain error codes. */
export const TRANSPORT_ERROR_CODES = [
  /** The request payload did not match the channel's schema. */
  'INVALID_REQUEST',
  /** The request did not come from the application's own renderer. */
  'FORBIDDEN_SENDER',
  /** An unexpected failure. Details are logged locally (redacted), never returned. */
  'INTERNAL_ERROR',
] as const;

export const IPC_ERROR_CODES = [
  ...DOMAIN_ERROR_CODES,
  ...WORKSPACE_ERROR_CODES,
  ...TRANSFER_ERROR_CODES,
  ...TRANSPORT_ERROR_CODES,
] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export const ipcErrorSchema = z.strictObject({
  code: z.enum(IPC_ERROR_CODES),
  /** English message safe to show to the user. Never contains stack traces or note content. */
  message: z.string(),
});

export type IpcError = z.infer<typeof ipcErrorSchema>;

export type IpcResult<Data> =
  { readonly ok: true; readonly data: Data } | { readonly ok: false; readonly error: IpcError };
