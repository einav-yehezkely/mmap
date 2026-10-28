/**
 * Errors crossing the worker-thread boundary (`import-writer.ts`). Structured cloning keeps only
 * an error's name and message, so domain errors are sent as plain data and rebuilt in the main
 * process, where the IPC layer turns them into their code and message for the renderer.
 */

import { DomainError, isDomainError } from '@mmap/domain';
import { describe, expect, it } from 'vitest';

import { fromTransferredError, toTransferredError } from './import-writer';

describe('errors from the import worker', () => {
  it('rebuilds a domain error with its code and message', () => {
    const sent = structuredClone(
      toTransferredError(new DomainError('VALIDATION_FAILED', 'The archive is inconsistent.')),
    );
    const received = fromTransferredError(sent);

    expect(isDomainError(received)).toBe(true);
    expect(received).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'The archive is inconsistent.',
    });
  });

  it('keeps other errors as plain errors, so they are logged and reported generically', () => {
    const sqliteError = Object.assign(new Error('UNIQUE constraint failed: knowledge_nodes.id'), {
      code: 'ERR_SQLITE_ERROR',
    });
    const received = fromTransferredError(structuredClone(toTransferredError(sqliteError)));

    expect(isDomainError(received)).toBe(false);
    expect(received.message).toBe('UNIQUE constraint failed: knowledge_nodes.id');
  });

  it('does not trust a domain error code it does not know', () => {
    const received = fromTransferredError({
      name: 'DomainError',
      message: 'Forged',
      code: 'NOT_A_REAL_CODE',
    });

    expect(isDomainError(received)).toBe(false);
  });

  it('describes values thrown that are not errors', () => {
    expect(toTransferredError('worker gave up')).toEqual({
      name: 'Error',
      message: 'worker gave up',
    });
  });
});
