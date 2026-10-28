/**
 * Progress of a long operation (export, import, backup, restore) with a Cancel button.
 *
 * The caller creates an operation ID with `newOperationId()`, passes it with the request that
 * starts the work, and shows this component while the request is pending. The component asks the
 * main process for the progress a few times a second (there is no push channel; see
 * `operations/operation-progress.ts` in the main process). Cancel is enabled only while the
 * current phase can stop safely; the request then fails with `OPERATION_CANCELLED`
 * (`isCancelled`), which callers show as a neutral message, not an error.
 */

import type { IpcResponse } from '@mmap/contracts';
import { useEffect, useState } from 'react';

import { IpcFailure, unwrap } from '../lib/ipc';
import { Button } from './ui/button';

const POLL_MS = 250;

export function newOperationId(): string {
  return crypto.randomUUID();
}

/** True for the failure of a request the user cancelled. */
export function isCancelled(error: unknown): boolean {
  return error instanceof IpcFailure && error.code === 'OPERATION_CANCELLED';
}

type ProgressState = IpcResponse<'operations:get-progress'>;

export function OperationProgress({
  operationId,
  fallback,
}: {
  readonly operationId: string;
  /** Shown until the main process reports a phase (for example while a dialog is open). */
  readonly fallback: string;
}) {
  const [state, setState] = useState<ProgressState | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      unwrap(window.mmap.operations.getProgress({ operationId })).then(
        (next) => {
          if (!stopped) setState(next);
        },
        () => undefined,
      );
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [operationId]);

  const running = state?.running === true ? state : null;
  const label = running?.phase ?? fallback;
  const percent =
    running !== null && running.total !== null && running.total > 0
      ? Math.min(100, Math.round((running.done / running.total) * 100))
      : null;

  const cancel = () => {
    setCancelling(true);
    void unwrap(window.mmap.operations.cancel({ operationId })).then(
      ({ cancelling: accepted }) => {
        if (!accepted) setCancelling(false);
      },
      () => setCancelling(false),
    );
  };

  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          {cancelling ? 'Cancelling…' : label}
          {percent !== null && !cancelling && (
            <span className="text-muted-foreground"> · {percent}%</span>
          )}
        </span>
        {running !== null && (
          <Button
            size="sm"
            variant="outline"
            disabled={!running.cancellable || cancelling}
            title={running.cancellable ? undefined : 'This step cannot be stopped.'}
            onClick={cancel}
          >
            Cancel
          </Button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {percent === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}
