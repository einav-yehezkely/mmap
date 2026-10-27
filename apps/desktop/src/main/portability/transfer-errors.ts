/**
 * Expected export and import failures (PRD §5.11). Each has a stable code (mirrored in
 * `@mmap/contracts`) and an English message for the user. Messages may name the archive file the
 * user chose, but never contain workspace content.
 */

import type { TransferErrorCode } from '@mmap/contracts';

export class TransferError extends Error {
  public constructor(
    public readonly code: TransferErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransferError';
  }
}

export function isTransferError(value: unknown): value is TransferError {
  return value instanceof TransferError;
}

/** Maps file system failures while writing an export or copying files to a user message. */
export function toWriteError(error: unknown, what: string): TransferError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC') {
    return new TransferError('TRANSFER_FAILED', `${what} failed: the disk is full.`, {
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new TransferError(
      'TRANSFER_FAILED',
      `${what} failed: mmap is not allowed to write to this location.`,
      { cause: error },
    );
  }
  return new TransferError('TRANSFER_FAILED', `${what} failed.`, { cause: error });
}
