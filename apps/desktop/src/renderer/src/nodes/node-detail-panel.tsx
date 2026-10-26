/**
 * The node detail editor (PRD §6: "Selecting a node opens the same detail editor from every
 * view"). Shows save status, recovery and conflict banners, and node actions.
 *
 * Render with `key={nodeId}` so switching nodes remounts the editor and flushes the previous one.
 */

import type { NodeDependentsView } from '@mmap/contracts';
import { Copy, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { formatDateTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import type { SaveStatus } from './node-draft-saver';
import { notifyNodesChanged } from './node-events';
import { useNodeEditor, type ConflictChoice } from './use-node-editor';

export interface NodeDetailPanelProps {
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly nodeId: string;
  readonly onClose: () => void;
  readonly onOpenNode: (nodeId: string) => void;
}

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  failed: 'Not saved',
  conflict: 'Conflict',
  invalid: 'Not saved',
};

export function NodeDetailPanel({
  workspaceId,
  timeZone,
  nodeId,
  onClose,
  onOpenNode,
}: NodeDetailPanelProps) {
  const editor = useNodeEditor(workspaceId, nodeId);
  const titleId = useId();
  const summaryId = useId();
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletePreview, setDeletePreview] = useState<NodeDependentsView | null>(null);

  if (editor.phase === 'loading') {
    return <PanelShell onClose={onClose}>{<p role="status">Loading…</p>}</PanelShell>;
  }
  if (editor.phase === 'error') {
    return (
      <PanelShell onClose={onClose}>
        <p role="alert" className="text-destructive">
          {editor.message}
        </p>
      </PanelShell>
    );
  }

  const { node, state } = editor;

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const duplicate = () =>
    runAction(async () => {
      await editor.flush();
      const copy = await unwrap(window.mmap.nodes.duplicate({ nodeId }));
      notifyNodesChanged();
      onOpenNode(copy.id);
    });

  const askDelete = () =>
    runAction(async () => {
      await editor.flush();
      setDeletePreview(await unwrap(window.mmap.nodes.previewDelete({ nodeId })));
    });

  const confirmDelete = () =>
    runAction(async () => {
      await unwrap(window.mmap.nodes.delete({ nodeId, expectedRevision: state.revision }));
      setDeletePreview(null);
      notifyNodesChanged();
      onClose();
    });

  const resolve = (choice: ConflictChoice) => runAction(() => editor.resolveConflict(choice));

  return (
    <PanelShell
      onClose={() => void editor.flush().finally(onClose)}
      status={
        <span
          role="status"
          className={
            state.status === 'failed' || state.status === 'invalid' || state.status === 'conflict'
              ? 'text-destructive'
              : 'text-muted-foreground'
          }
        >
          {STATUS_TEXT[state.status]}
        </span>
      }
    >
      {editor.recovered && (
        <Banner tone="warning">
          <p>
            Unsaved changes from {formatDateTime(editor.recovered.savedAt, timeZone)} were found on
            this computer.
            {editor.recovered.baseRevision !== node.revision &&
              ' The node has been saved since then; restoring will replace those newer changes.'}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={editor.restoreRecovered}>
              Restore my changes
            </Button>
            <Button size="sm" variant="outline" onClick={editor.discardRecovered}>
              Discard them
            </Button>
          </div>
        </Banner>
      )}

      {state.status === 'conflict' && (
        <Banner tone="error">
          <p>{state.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void resolve('keep-mine')}>
              Keep my version
            </Button>
            <Button size="sm" variant="outline" onClick={() => void resolve('use-theirs')}>
              Use the saved version
            </Button>
            <Button size="sm" variant="outline" onClick={() => void resolve('save-mine-as-copy')}>
              Save mine as a new node
            </Button>
          </div>
        </Banner>
      )}

      {(state.status === 'failed' || state.status === 'invalid') && (
        <Banner tone="error">
          <p>{state.message}</p>
          {state.status === 'failed' && (
            <Button size="sm" className="mt-2" onClick={editor.retry}>
              Retry saving
            </Button>
          )}
        </Banner>
      )}

      {actionError && <Banner tone="error">{actionError}</Banner>}

      <div className="space-y-1">
        <label htmlFor={titleId} className="sr-only">
          Title
        </label>
        <input
          id={titleId}
          dir="auto"
          value={state.draft.title}
          onChange={(event) => editor.edit({ title: event.target.value })}
          onBlur={() => void editor.flush()}
          placeholder="Title"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md px-1"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={summaryId} className="text-sm text-muted-foreground">
          Summary
        </label>
        <textarea
          id={summaryId}
          dir="auto"
          value={state.draft.summary ?? ''}
          onChange={(event) => editor.edit({ summary: event.target.value || null })}
          rows={3}
          placeholder="A one or two sentence summary (optional)"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <section
        aria-label="Note"
        className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
      >
        The rich note editor (formatting, tables, math, attachments) arrives in the next step.
      </section>

      <p className="text-xs text-muted-foreground">
        Created {formatDateTime(node.createdAt, timeZone)} · Revision {state.revision}
      </p>

      <div className="flex gap-2 border-t pt-4">
        <Button variant="outline" size="sm" onClick={() => void duplicate()}>
          <Copy aria-hidden="true" />
          Duplicate
        </Button>
        <Button variant="outline" size="sm" onClick={() => void askDelete()}>
          <Trash2 aria-hidden="true" />
          Delete…
        </Button>
      </div>

      <ConfirmDialog
        open={deletePreview !== null}
        onOpenChange={(open) => {
          if (!open) setDeletePreview(null);
        }}
        title={`Delete “${state.draft.title}”?`}
        confirmLabel="Delete node"
        onConfirm={() => void confirmDelete()}
      >
        {deletePreview && <DeletePreview dependents={deletePreview} />}
      </ConfirmDialog>
    </PanelShell>
  );
}

function DeletePreview({ dependents }: { dependents: NodeDependentsView }) {
  const lines = [
    [dependents.relationships, 'relationship', 'will be deleted'],
    [dependents.mapPlacements, 'map placement', 'will be removed (other map items stay)'],
    [dependents.attachments, 'attachment', 'will be deleted'],
    [
      dependents.referencingNotes,
      'note links here',
      '— those links stay readable and can be repaired',
    ],
  ] as const;
  const affected = lines.filter(([count]) => count > 0);
  return (
    <>
      <p>This cannot be undone. Backups and exports you made earlier are not affected.</p>
      {affected.length === 0 ? (
        <p>Nothing else refers to this node.</p>
      ) : (
        <ul className="list-disc pl-5">
          {affected.map(([count, noun, effect]) => (
            <li key={noun}>
              {count} {noun}
              {count === 1 || noun === 'note links here' ? '' : 's'} {effect}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PanelShell({
  children,
  onClose,
  status,
}: {
  children: ReactNode;
  onClose: () => void;
  status?: ReactNode;
}) {
  return (
    <aside
      aria-label="Node details"
      className="flex w-full max-w-2xl shrink-0 flex-col border-l bg-background"
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2 text-sm">
        <div aria-live="polite">{status}</div>
        <Button variant="ghost" size="icon" aria-label="Close node" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-6">{children}</div>
    </aside>
  );
}

function Banner({ tone, children }: { tone: 'warning' | 'error'; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'rounded-md border border-destructive px-3 py-2 text-sm'
          : 'rounded-md border border-ring px-3 py-2 text-sm'
      }
    >
      {children}
    </div>
  );
}
