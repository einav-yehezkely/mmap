/**
 * Progress and cancellation registry (`operation-progress.ts`).
 */

import { describe, expect, it } from 'vitest';

import { OperationRegistry, withoutCancel } from './operation-progress';

const ID = '11111111-1111-4111-8111-111111111111';

describe('operation progress', () => {
  it('reports the current phase while the work runs, and forgets it afterwards', async () => {
    const registry = new OperationRegistry();
    const seen: unknown[] = [];
    await registry.run(ID, async (progress) => {
      progress.phase('Copying attached files', 3);
      progress.advance();
      progress.advance(5);
      seen.push(registry.progress(ID));
      progress.phase('Reading the archive', null);
      progress.advance(7);
      seen.push(registry.progress(ID));
    });

    expect(seen).toEqual([
      // Advances never go past the total.
      { phase: 'Copying attached files', done: 3, total: 3, cancellable: true },
      { phase: 'Reading the archive', done: 7, total: null, cancellable: true },
    ]);
    expect(registry.progress(ID)).toBeNull();
  });

  it('cancels only while the phase allows it, and the work stops where it checks', async () => {
    const registry = new OperationRegistry();
    const outcome = registry.run(ID, async (progress) => {
      progress.phase('Saving to the workspace', null, { cancellable: false });
      expect(registry.cancel(ID)).toBe(false);
      progress.checkCancelled();
      progress.phase('Copying attached files', 2);
      expect(registry.cancel(ID)).toBe(true);
      expect(progress.signal.aborted).toBe(true);
      progress.checkCancelled();
      return 'finished';
    });

    await expect(outcome).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(registry.cancel(ID)).toBe(false);
  });

  it('runs untracked work without an ID, and refuses an ID that is already running', async () => {
    const registry = new OperationRegistry();
    await expect(registry.run(undefined, async () => 'done')).resolves.toBe('done');

    let release!: () => void;
    const first = registry.run(ID, () => new Promise<void>((resolve) => (release = resolve)));
    await expect(registry.run(ID, async () => undefined)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    release();
    await first;
  });

  it('withoutCancel makes every phase uncancellable and ignores a cancel request', async () => {
    const registry = new OperationRegistry();
    await registry.run(ID, async (progress) => {
      const steady = withoutCancel(progress);
      steady.phase('Restoring attached files', 4);
      steady.advance();
      expect(registry.progress(ID)).toEqual({
        phase: 'Restoring attached files',
        done: 1,
        total: 4,
        cancellable: false,
      });
      expect(registry.cancel(ID)).toBe(false);
      expect(() => steady.checkCancelled()).not.toThrow();
    });
  });
});
