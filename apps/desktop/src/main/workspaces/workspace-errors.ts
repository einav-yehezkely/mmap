/**
 * Expected workspace lifecycle failures. Each has a stable code (mirrored in `@mmap/contracts`)
 * and an English message written for the user; messages may include the folder path because the
 * user chose that folder, but never workspace content.
 */

import type { WorkspaceErrorCode } from '@mmap/contracts';

export class WorkspaceError extends Error {
  public constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

export function isWorkspaceError(value: unknown): value is WorkspaceError {
  return value instanceof WorkspaceError;
}
