/**
 * Progress and cancellation of long operations in the main process: exports, imports, backups
 * and restores (PRD §9: long work must keep the user informed and stay responsive).
 *
 * IPC is request and response only, so progress is read, not pushed: the renderer generates an
 * operation ID, passes it with the request that starts the work, and while that request is
 * pending asks `operations:get-progress` for it a few times a second; `operations:cancel` asks
 * the work to stop. Nothing here is visible to the renderer except the phase text and counts.
 *
 * Cancellation is cooperative and only possible while it is safe: the work marks each phase as
 * cancellable or not, and checks `progress.checkCancelled()` at points where stopping leaves
 * nothing behind (its own cleanup removes partial files). Phases that make changes visible, such
 * as an import's final transaction or the swap of a restore, are never cancellable: a cancel
 * that arrived just after the commit could otherwise report "cancelled" for work that happened.
 */

import { DomainError } from '@mmap/domain';

import { TransferError } from '../portability/transfer-errors';

/** What the renderer is told about a running operation. */
export interface ProgressSnapshot {
  /** Short English text for the current phase, e.g. "Copying attached files". */
  readonly phase: string;
  readonly done: number;
  /** Units of the phase, or null when the amount of work is not known. */
  readonly total: number | null;
  readonly cancellable: boolean;
}

/** Handed to the work; reports progress and tells it whether to stop. */
export interface Progress {
  /** Starts a phase. `total` null means indeterminate. Phases are cancellable unless stated. */
  phase(label: string, total: number | null, options?: { readonly cancellable?: boolean }): void;
  /** Advances the current phase by `units` (1 by default). */
  advance(units?: number): void;
  /** Throws `OPERATION_CANCELLED` when the user cancelled. Call only where stopping is safe. */
  checkCancelled(): void;
  /** Aborted when the user cancels, for APIs that accept a signal (streams). */
  readonly signal: AbortSignal;
}

/** For callers without an operation ID (tests, scheduled backups): reports nothing, never stops. */
export const NO_PROGRESS: Progress = {
  phase: () => undefined,
  advance: () => undefined,
  checkCancelled: () => undefined,
  signal: new AbortController().signal,
};

/**
 * The same progress, but nothing reported through it can be cancelled: for work that swaps
 * folders (a restore), where stopping half-way would be worse than finishing.
 */
export function withoutCancel(progress: Progress): Progress {
  return {
    phase: (label, total) => progress.phase(label, total, { cancellable: false }),
    advance: (units) => progress.advance(units),
    checkCancelled: () => undefined,
    signal: new AbortController().signal,
  };
}

export function operationCancelled(): TransferError {
  return new TransferError('OPERATION_CANCELLED', 'Cancelled. Nothing was changed.');
}

/** At most this many operations are tracked at once; the UI starts one at a time. */
const MAX_RUNNING = 8;

interface Entry {
  snapshot: ProgressSnapshot;
  readonly controller: AbortController;
}

export class OperationRegistry {
  private readonly running = new Map<string, Entry>();

  /**
   * Runs `work` with progress reported under `operationId`. Without an ID the work runs untracked
   * and cannot be cancelled.
   */
  public async run<Result>(
    operationId: string | undefined,
    work: (progress: Progress) => Promise<Result>,
  ): Promise<Result> {
    if (operationId === undefined) return work(NO_PROGRESS);
    if (this.running.has(operationId) || this.running.size >= MAX_RUNNING) {
      throw new DomainError('VALIDATION_FAILED', 'This operation is already running.');
    }
    const entry: Entry = {
      snapshot: { phase: 'Starting', done: 0, total: null, cancellable: true },
      controller: new AbortController(),
    };
    this.running.set(operationId, entry);
    const progress: Progress = {
      phase: (label, total, options) => {
        entry.snapshot = {
          phase: label,
          done: 0,
          total,
          cancellable: options?.cancellable ?? true,
        };
      },
      advance: (units = 1) => {
        const { snapshot } = entry;
        const done = snapshot.done + units;
        entry.snapshot = {
          ...snapshot,
          done: snapshot.total === null ? done : Math.min(done, snapshot.total),
        };
      },
      checkCancelled: () => {
        if (entry.controller.signal.aborted) throw operationCancelled();
      },
      signal: entry.controller.signal,
    };
    try {
      return await work(progress);
    } finally {
      this.running.delete(operationId);
    }
  }

  /** The operation's progress, or null when it is not (or no longer) running. */
  public progress(operationId: string): ProgressSnapshot | null {
    return this.running.get(operationId)?.snapshot ?? null;
  }

  /** Asks the operation to stop; false when it is not running or its phase cannot be cancelled. */
  public cancel(operationId: string): boolean {
    const entry = this.running.get(operationId);
    if (entry === undefined || !entry.snapshot.cancellable) return false;
    entry.controller.abort();
    return true;
  }
}
