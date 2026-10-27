/**
 * Attachments of one node (PRD §5.10): list with size, open with the default application, and
 * remove. Removing an attachment deletes the managed copy; a reference left in the note then shows
 * the file name without content.
 */

import type { AttachmentViewDto } from '@mmap/contracts';
import { ExternalLink, FileText, Image as ImageIcon, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { errorMessage, unwrap } from '../lib/ipc';

/** Human-readable size using binary multiples, as Windows Explorer does. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function NodeAttachments({
  nodeId,
  version,
  notices,
}: {
  nodeId: string;
  /** Changes whenever attachments were added elsewhere, to trigger a reload. */
  version: number;
  /** Messages from the last attach action (e.g. rejected files). */
  notices: readonly string[];
}) {
  const [items, setItems] = useState<readonly AttachmentViewDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AttachmentViewDto | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.attachments.list({ nodeId })).then(
      ({ items: loaded }) => {
        if (!cancelled) setItems(loaded);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, version, reloadToken]);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  if (items === null && error === null) return null;

  return (
    <section aria-labelledby={`attachments-${nodeId}`} className="space-y-2">
      <h3 id={`attachments-${nodeId}`} className="text-sm font-medium">
        Attachments
      </h3>
      {notices.map((notice) => (
        <p key={notice} role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items !== null && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No files yet. Use the paperclip in the note toolbar to attach files.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="divide-y rounded-md border">
          {items.map((item) => {
            const Icon = item.previewable ? ImageIcon : FileText;
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span dir="auto" className="min-w-0 flex-1 truncate" title={item.displayName}>
                  {item.displayName}
                </span>
                {item.fileAvailable ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatByteSize(item.byteSize)}
                  </span>
                ) : (
                  <span
                    className="shrink-0 rounded-full border border-destructive px-2 text-xs text-destructive"
                    title="The copy in the workspace folder is missing. Remove this entry and attach the file again."
                  >
                    File missing
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={!item.fileAvailable}
                  aria-label={`Open ${item.displayName}`}
                  title="Open with the default application"
                  onClick={() =>
                    void run(async () => {
                      const { opened } = await unwrap(
                        window.mmap.attachments.open({ attachmentId: item.id }),
                      );
                      if (!opened) setError('This file could not be opened.');
                    })
                  }
                >
                  <ExternalLink aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${item.displayName}`}
                  onClick={() => setConfirmRemove(item)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        title={`Remove “${confirmRemove?.displayName ?? ''}”?`}
        confirmLabel="Remove file"
        onConfirm={() =>
          void run(async () => {
            if (confirmRemove === null) return;
            await unwrap(window.mmap.attachments.remove({ attachmentId: confirmRemove.id }));
            setConfirmRemove(null);
            setReloadToken((token) => token + 1);
          })
        }
      >
        <p>
          The workspace copy of this file is deleted. Your original file elsewhere on this computer
          is not affected. Mentions of it in the note remain as a label.
        </p>
      </ConfirmDialog>
    </section>
  );
}
