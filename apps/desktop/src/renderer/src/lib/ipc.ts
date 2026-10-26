/**
 * Helpers for calling the preload bridge from React code.
 *
 * Bridge calls resolve with a result envelope instead of throwing (see `@mmap/contracts`).
 * `unwrap` converts a failed envelope into an `IpcFailure`, so components can use ordinary
 * try/catch and show `error.message`, which the main process guarantees is safe to display.
 */

import type { IpcError, IpcErrorCode, IpcResult } from '@mmap/contracts';

export class IpcFailure extends Error {
  public readonly code: IpcErrorCode;

  public constructor(error: IpcError) {
    super(error.message);
    this.name = 'IpcFailure';
    this.code = error.code;
  }
}

export async function unwrap<Data>(call: Promise<IpcResult<Data>>): Promise<Data> {
  let result: IpcResult<Data>;
  try {
    result = await call;
  } catch {
    // Only happens if the bridge itself fails (e.g. the main process is shutting down).
    throw new IpcFailure({
      code: 'INTERNAL_ERROR',
      message: 'Could not reach the application service.',
    });
  }
  if (!result.ok) {
    throw new IpcFailure(result.error);
  }
  return result.data;
}

/** Message to show for any error caught in UI code. */
export function errorMessage(error: unknown): string {
  return error instanceof IpcFailure ? error.message : 'Something went wrong. Please try again.';
}
