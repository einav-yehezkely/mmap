/**
 * Settings › Backups (PRD §9): when the last backup succeeded or failed, where backups go (with a
 * warning when that is the workspace's own drive), how many are kept, "Back up now", and
 * restoring a snapshot.
 *
 * Restoring replaces the workspace's content, so it always asks for confirmation and explains
 * that the current state is backed up first and the current folder goes to the Recycle Bin.
 * After a restore the window reloads, so every view shows the restored data.
 *
 * "Back up now" and restores show their progress (`OperationProgress`); a backup can be
 * cancelled until its last step, a restore cannot (it swaps folders).
 */

import type { BackupStatusDto } from '@mmap/contracts';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { isCancelled, newOperationId, OperationProgress } from '../components/operation-progress';
import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { formatDateTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';

export function BackupSettings({ timeZone }: { timeZone: string }) {
  const [status, setStatus] = useState<BackupStatusDto | null>(null);
  /** What is running; long operations carry the ID their progress is read with. */
  const [busy, setBusy] = useState<{
    readonly text: string;
    readonly operationId: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupStatusDto['snapshots'][number] | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.backups.getStatus({})).then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Runs an action that returns the new status, showing `label` meanwhile, with progress when
   * the action reports it under `operationId`.
   */
  const run = async (
    label: string,
    action: () => Promise<BackupStatusDto>,
    operationId: string | null = null,
  ) => {
    setBusy({ text: label, operationId });
    setError(null);
    setNotice(null);
    try {
      setStatus(await action());
    } catch (caught) {
      if (isCancelled(caught)) setNotice('Backup cancelled. Nothing was changed.');
      else setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const backUpNow = () => {
    const operationId = newOperationId();
    void run(
      'Backing up…',
      () => unwrap(window.mmap.backups.createNow({ operationId })),
      operationId,
    );
  };

  const restore = async (snapshotId: string) => {
    setRestoreTarget(null);
    const operationId = newOperationId();
    setBusy({ text: 'Restoring…', operationId });
    setError(null);
    try {
      await unwrap(window.mmap.backups.restore({ snapshotId, operationId }));
      window.location.reload();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  };

  const restoreFromFolder = async () => {
    const operationId = newOperationId();
    setBusy({ text: 'Restoring…', operationId });
    setError(null);
    try {
      const result = await unwrap(window.mmap.backups.restoreFromFolder({ operationId }));
      if (result.status === 'restored') {
        window.location.reload();
        return;
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(null);
  };

  if (status === null) {
    return error === null ? (
      <p className="text-sm text-muted-foreground">Loading…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <div aria-live="polite" className="space-y-1">
        <p>
          {status.lastSuccessAt === null
            ? 'No backup yet.'
            : `Last backup: ${formatDateTime(status.lastSuccessAt, timeZone)}.`}{' '}
          <span className="text-muted-foreground">
            mmap backs up automatically once a day when the workspace is open.
          </span>
        </p>
        {busy !== null &&
          (busy.operationId === null ? (
            <p className="text-muted-foreground">{busy.text}</p>
          ) : (
            <OperationProgress
              key={busy.operationId}
              operationId={busy.operationId}
              fallback={busy.text}
            />
          ))}
        {notice !== null && <p>{notice}</p>}
      </div>
      {status.lastFailure !== null && (
        <p role="alert" className="text-destructive">
          The last backup failed ({formatDateTime(status.lastFailure.at, timeZone)}):{' '}
          {status.lastFailure.message}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <p className="font-medium">Backup folder</p>
        <p className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {status.destination}
        </p>
        {status.sameDriveAsWorkspace && (
          <p className="text-amber-700 dark:text-amber-400">
            Backups are on the same drive as the workspace, so a drive failure would lose both.
            Choose a folder on another drive, such as an external disk, to protect against that.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void run('Saving…', () => unwrap(window.mmap.backups.chooseDestination({})))
            }
          >
            Change folder…
          </Button>
          {!status.isDefaultDestination && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() =>
                void run('Saving…', () => unwrap(window.mmap.backups.useDefaultDestination({})))
              }
            >
              Use the default folder
            </Button>
          )}
          <Button disabled={busy !== null} onClick={backUpNow}>
            Back up now
          </Button>
        </div>
      </div>

      <RetentionForm
        key={`${status.retention.daily}-${status.retention.weekly}`}
        retention={status.retention}
        disabled={busy !== null}
        onSave={(daily, weekly) =>
          void run('Saving…', () => unwrap(window.mmap.backups.setRetention({ daily, weekly })))
        }
      />

      <div className="space-y-2">
        <p className="font-medium">Backups of this workspace</p>
        {status.snapshots.length === 0 ? (
          <p className="text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {status.snapshots.map((snapshot) => (
              <li
                key={snapshot.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
              >
                <span className="font-medium">{formatDateTime(snapshot.createdAt, timeZone)}</span>
                <span className="text-muted-foreground">
                  {formatBytes(snapshot.databaseBytes)} of notes,{' '}
                  {snapshot.attachmentCount === 1
                    ? '1 attachment'
                    : `${snapshot.attachmentCount} attachments`}
                  {snapshot.missingAttachments > 0 &&
                    ` (${snapshot.missingAttachments} missing at backup time)`}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy !== null}
                  onClick={() => setRestoreTarget(snapshot)}
                >
                  Restore…
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="ghost" disabled={busy !== null} onClick={() => void restoreFromFolder()}>
          Restore from a backup folder…
        </Button>
        <p className="text-xs text-muted-foreground">
          Use this on a new computer or after losing a drive: choose a folder inside
          &quot;snapshots&quot; in a backup folder. It is restored as a new workspace.
        </p>
      </div>

      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this backup?"
        confirmLabel="Restore"
        onConfirm={() => restoreTarget !== null && void restore(restoreTarget.id)}
      >
        <p>
          The workspace will be replaced by the backup from{' '}
          {restoreTarget !== null && formatDateTime(restoreTarget.createdAt, timeZone)}. Changes
          made since then will no longer be in the workspace.
        </p>
        <p className="mt-2">
          A backup of the current state is made first, so you can return to it, and the current
          workspace folder is moved to the Recycle Bin.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function RetentionForm({
  retention,
  disabled,
  onSave,
}: {
  retention: { daily: number; weekly: number };
  disabled: boolean;
  onSave: (daily: number, weekly: number) => void;
}) {
  const [daily, setDaily] = useState(String(retention.daily));
  const [weekly, setWeekly] = useState(String(retention.weekly));
  const dailyId = useId();
  const weeklyId = useId();
  const dailyValue = Number(daily);
  const weeklyValue = Number(weekly);
  const valid =
    Number.isInteger(dailyValue) &&
    dailyValue >= 0 &&
    dailyValue <= 60 &&
    Number.isInteger(weeklyValue) &&
    weeklyValue >= 0 &&
    weeklyValue <= 104;
  const changed = dailyValue !== retention.daily || weeklyValue !== retention.weekly;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && changed) onSave(dailyValue, weeklyValue);
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <p className="font-medium">How many backups to keep</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor={dailyId} className="block text-muted-foreground">
            Daily (last days)
          </label>
          <Input
            id={dailyId}
            type="number"
            min={0}
            max={60}
            className="w-24"
            value={daily}
            onChange={(event) => setDaily(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={weeklyId} className="block text-muted-foreground">
            Weekly (last weeks)
          </label>
          <Input
            id={weeklyId}
            type="number"
            min={0}
            max={104}
            className="w-24"
            value={weekly}
            onChange={(event) => setWeekly(event.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={disabled || !valid || !changed}>
          Save
        </Button>
      </div>
      {!valid && (
        <p role="alert" className="text-destructive">
          Enter 0–60 daily and 0–104 weekly backups.
        </p>
      )}
    </form>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
