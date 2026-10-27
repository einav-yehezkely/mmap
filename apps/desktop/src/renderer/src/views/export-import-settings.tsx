/**
 * Settings › Export and import (PRD §5.11).
 *
 * - Export writes the complete, lossless ZIP archive of the workspace to a file the user picks.
 * - Import is two steps: choosing an archive validates all of it and shows what would be added
 *   (counts and warnings) without changing anything; only "Import" in that preview adds it. When
 *   the archive was imported before, the user must tick a box before it can be imported again.
 *
 * Imports always add new records with new identities; nothing that exists is changed.
 */

import type { IpcResponse } from '@mmap/contracts';
import { useId, useState } from 'react';

import { Button } from '../components/ui/button';
import { FormDialog } from '../components/ui/dialog';
import { formatDateTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import { notifyNodesChanged } from '../nodes/node-events';

type TransferPreview = Extract<IpcResponse<'transfer:preview-import'>, { status: 'ready' }>;

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly text: string }
  | { readonly kind: 'done'; readonly text: string; readonly warnings: readonly string[] }
  | { readonly kind: 'error'; readonly text: string };

export function ExportImportSettings({ timeZone }: { timeZone: string }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const busy = status.kind === 'busy';

  const exportZip = async () => {
    setStatus({ kind: 'busy', text: 'Exporting…' });
    try {
      const result = await unwrap(window.mmap.transfer.exportZip({}));
      if (result.status === 'cancelled') {
        setStatus({ kind: 'idle' });
        return;
      }
      setStatus({
        kind: 'done',
        text: `Exported ${plural(result.counts.nodes, 'node')}, ${plural(result.counts.maps, 'map')} and ${plural(result.counts.attachments, 'attachment')} to ${result.fileName}.`,
        warnings: result.warnings,
      });
    } catch (caught) {
      setStatus({ kind: 'error', text: errorMessage(caught) });
    }
  };

  const chooseArchive = async () => {
    setStatus({ kind: 'busy', text: 'Checking the archive…' });
    try {
      const result = await unwrap(window.mmap.transfer.previewImport({}));
      setStatus({ kind: 'idle' });
      if (result.status === 'ready') setPreview(result);
    } catch (caught) {
      setStatus({ kind: 'error', text: errorMessage(caught) });
    }
  };

  const closePreview = () => {
    if (preview !== null) {
      void window.mmap.transfer.discardImport({ importToken: preview.importToken });
    }
    setPreview(null);
  };

  const runImport = async (acceptDuplicate: boolean) => {
    if (preview === null) return;
    const token = preview.importToken;
    setPreview(null);
    setStatus({ kind: 'busy', text: 'Importing…' });
    try {
      const { summary } = await unwrap(
        window.mmap.transfer.applyImport({ importToken: token, acceptDuplicate }),
      );
      notifyNodesChanged();
      setStatus({
        kind: 'done',
        text: `Imported ${plural(summary.nodes, 'node')}, ${plural(summary.maps, 'map')} and ${plural(summary.attachments, 'attachment')}.`,
        warnings: [],
      });
    } catch (caught) {
      setStatus({ kind: 'error', text: errorMessage(caught) });
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        The ZIP export is the complete copy of this workspace: notes, tags, relationships, maps,
        timeline and attachment files. Import it here or on another computer to restore everything.
        Importing always adds copies; it never changes what is already here.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void exportZip()}>
          Export workspace (ZIP)…
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void chooseArchive()}>
          Import from an export…
        </Button>
      </div>
      <div aria-live="polite">
        {status.kind === 'busy' && <p className="text-muted-foreground">{status.text}</p>}
        {status.kind === 'done' && (
          <div className="space-y-1">
            <p>{status.text}</p>
            {status.warnings.length > 0 && (
              <ul className="list-disc pl-5 text-amber-700 dark:text-amber-400">
                {status.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {status.kind === 'error' && (
        <p role="alert" className="text-destructive">
          {status.text}
        </p>
      )}
      {preview !== null && (
        <ImportPreviewDialog
          preview={preview}
          timeZone={timeZone}
          onCancel={closePreview}
          onImport={(acceptDuplicate) => void runImport(acceptDuplicate)}
        />
      )}
    </div>
  );
}

function ImportPreviewDialog({
  preview,
  timeZone,
  onCancel,
  onImport,
}: {
  preview: TransferPreview;
  timeZone: string;
  onCancel: () => void;
  onImport: (acceptDuplicate: boolean) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const checkboxId = useId();
  const duplicate = preview.previousImports.length > 0;
  const { summary } = preview;
  const rows: [string, number][] = [
    ['Nodes', summary.nodes],
    ['Relationships', summary.relationships],
    ['Mind maps', summary.maps],
    ['Map items', summary.placements],
    ['Timeline entries (marked as imported)', summary.timelineEvents],
    ['Attachments', summary.attachments],
    ['New tags', summary.newTags],
    ['Tags already here (reused)', summary.reusedTags],
    ['New relationship types', summary.newRelationshipTypes],
    ['Relationship types already here (reused)', summary.reusedRelationshipTypes],
  ];

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={`Import “${preview.source.workspaceName}”`}
      description={`${preview.fileName}, exported ${formatDateTime(preview.source.exportedAt, timeZone)}. Everything is added as new items; nothing here is changed.`}
      submitLabel="Import"
      submitDisabled={duplicate && !confirmed}
      onSubmit={() => onImport(duplicate)}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">What will be added</caption>
        <tbody>
          {rows.map(([label, count]) => (
            <tr key={label} className="border-b last:border-0">
              <th scope="row" className="py-1 pr-4 text-left font-normal text-muted-foreground">
                {label}
              </th>
              <td className="py-1 text-right tabular-nums">{count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-400">
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {duplicate && (
        <div role="alert" className="space-y-2 rounded-md border border-amber-500/50 p-3 text-sm">
          <p>
            This archive was already imported into this workspace on{' '}
            {preview.previousImports.map((time) => formatDateTime(time, timeZone)).join(', ')}.
            Importing it again adds a second copy of everything in it.
          </p>
          <label htmlFor={checkboxId} className="flex items-center gap-2">
            <input
              id={checkboxId}
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Import it again anyway
          </label>
        </div>
      )}
    </FormDialog>
  );
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
