/**
 * The node detail editor (PRD §6: "Selecting a node opens the same detail editor from every
 * view"). Shows save status, recovery and conflict banners, and node actions.
 *
 * Two layouts:
 * - `panel` (default): a side panel next to the current view.
 * - `page`: a full-width editor that replaces the view (Home opens nodes this way). A top bar has
 *   the back action and the save status; the note gets the main column, and tags, relationships,
 *   maps, attachments and links sit in a narrow side column, or, when the editor area is narrow,
 *   in a collapsed "Details" section below the note, so nothing is clipped or scrolls sideways.
 *
 * Closing (or going back) saves pending edits first. In page mode, when the last save failed, the
 * user is asked before leaving; the edits stay recoverable on this computer either way.
 *
 * Render with `key={nodeId}` so switching nodes remounts the editor and flushes the previous one.
 */

import type { NodeDependentsView } from '@mmap/contracts';
import { AppWindow, ArrowLeft, BookCheck, Copy, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { formatDateTime } from '../lib/format-date';
import type { AttachmentNodeAttributes } from '../notes/attachment-node';
import { NoteEditor } from '../notes/note-editor';
import { NodeAttachments } from './node-attachments';
import { NodeBacklinks } from './node-backlinks';
import { NodeMaps } from './node-maps';
import { errorMessage, unwrap } from '../lib/ipc';
import type { SaveStatus } from './node-draft-saver';
import { notifyNodesChanged } from './node-events';
import { NodeRelationships } from '../relationships/node-relationships';
import { ReviewDialog } from '../timeline/review-dialog';
import { NodeTagsEditor } from './node-tags-editor';
import { useNodeEditor, type ConflictChoice } from './use-node-editor';

export interface NodeDetailPanelProps {
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly nodeId: string;
  readonly onClose: () => void;
  readonly onOpenNode: (nodeId: string) => void;
  /** Opens a mind map (from the panel's list of maps showing the node). */
  readonly onOpenMap?: (mapId: string) => void;
  /** `page`: full-width editor replacing the current view (see the file comment). */
  readonly layout?: 'panel' | 'page';
  /** Label of the back action in page layout, e.g. "Back to Home". */
  readonly backLabel?: string;
}

/** Editor area width from which the page layout shows details in a side column. */
const TWO_COLUMN_MIN_WIDTH = 900;

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
  onOpenMap,
  layout = 'panel',
  backLabel = 'Back',
}: NodeDetailPanelProps) {
  const editor = useNodeEditor(workspaceId, nodeId);
  const [bodyRef, bodyWidth] = useElementWidth<HTMLDivElement>();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const titleId = useId();
  const summaryId = useId();
  const [actionError, setActionError] = useState<string | null>(null);
  const [deletePreview, setDeletePreview] = useState<NodeDependentsView | null>(null);
  /** "Mark as reviewed" dialog (PRD §5.9) and the confirmation shown after recording a review. */
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewedNotice, setReviewedNotice] = useState(false);
  const [noteProblem, setNoteProblem] = useState<string | null>(null);
  const [attachmentsVersion, setAttachmentsVersion] = useState(0);
  const [attachNotices, setAttachNotices] = useState<readonly string[]>([]);

  /** Opens the native file picker in the main process and returns the stored attachments. */
  const attachFiles = async (): Promise<readonly AttachmentNodeAttributes[]> => {
    setAttachNotices([]);
    try {
      const result = await unwrap(window.mmap.attachments.add({ nodeId }));
      setAttachNotices(result.rejected.map((item) => `${item.fileName}: ${item.reason}`));
      if (result.added.length > 0) setAttachmentsVersion((version) => version + 1);
      return result.added.map((attachment) => ({
        attachmentId: attachment.id,
        displayName: attachment.displayName,
        kind: attachment.previewable ? 'image' : 'file',
      }));
    } catch (error) {
      setAttachNotices([errorMessage(error)]);
      return [];
    }
  };

  if (editor.phase === 'loading') {
    return (
      <PanelShell layout={layout} backLabel={backLabel} onClose={onClose}>
        {<p role="status">Loading…</p>}
      </PanelShell>
    );
  }
  if (editor.phase === 'error') {
    return (
      <PanelShell layout={layout} backLabel={backLabel} onClose={onClose}>
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

  const markReviewed = async (reflection: string | null, learnedAt: string | null) => {
    setReviewError(null);
    try {
      await unwrap(window.mmap.timeline.markReviewed({ nodeId, reflection, learnedAt }));
      setReviewing(false);
      setReviewedNotice(true);
      // Refreshes views that show activity, such as the timeline.
      notifyNodesChanged();
    } catch (caught) {
      setReviewError(errorMessage(caught));
    }
  };

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

  /** Leaves the editor after saving pending edits; asks first when the last save failed. */
  const leave = () => {
    if (
      layout === 'page' &&
      (state.status === 'failed' || state.status === 'invalid' || state.status === 'conflict')
    ) {
      setConfirmLeave(true);
      return;
    }
    void editor.flush().finally(onClose);
  };

  const parts = {
    banners: (
      <>
        {editor.recovered && (
          <Banner tone="warning">
            <p>
              Unsaved changes from {formatDateTime(editor.recovered.savedAt, timeZone)} were found
              on this computer.
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
      </>
    ),
    titleAndSummary: (
      <>
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
      </>
    ),
    note: (
      <>
        <section aria-label="Note">
          <NoteEditor
            key={editor.contentVersion}
            initialNote={state.draft.note}
            onChange={(note) => {
              setNoteProblem(null);
              editor.edit({ note });
            }}
            onInvalid={setNoteProblem}
            onAttachFiles={attachFiles}
            onOpenNode={onOpenNode}
          />
          {noteProblem && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {noteProblem} Your latest edits are not saved yet.
            </p>
          )}
        </section>
      </>
    ),
    tags: <NodeTagsEditor nodeId={node.id} initialTags={node.tags} />,
    relationships: <NodeRelationships nodeId={node.id} onOpenNode={onOpenNode} />,
    maps: <NodeMaps nodeId={node.id} nodeTitle={node.title} onOpenMap={onOpenMap} />,
    attachments: (
      <NodeAttachments nodeId={node.id} version={attachmentsVersion} notices={attachNotices} />
    ),
    backlinks: <NodeBacklinks nodeId={node.id} onOpenNode={onOpenNode} />,
    footer: (
      <>
        <p className="text-xs text-muted-foreground">
          Created {formatDateTime(node.createdAt, timeZone)} · Revision {state.revision}
        </p>
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setReviewError(null);
              setReviewedNotice(false);
              setReviewing(true);
            }}
          >
            <BookCheck aria-hidden="true" />
            Mark as reviewed…
          </Button>
          <Button variant="outline" size="sm" onClick={() => void duplicate()}>
            <Copy aria-hidden="true" />
            Duplicate
          </Button>
          <Button
            variant="outline"
            size="sm"
            title="Open this note in another window, for example to compare it with another one"
            onClick={() => void window.mmap.app.openWindow({ nodeId })}
          >
            <AppWindow aria-hidden="true" />
            New window
          </Button>
          <Button variant="outline" size="sm" onClick={() => void askDelete()}>
            <Trash2 aria-hidden="true" />
            Delete…
          </Button>
        </div>

        {reviewedNotice && (
          <p role="status" className="text-sm text-muted-foreground">
            Review recorded in the timeline.
          </p>
        )}
      </>
    ),
  };

  const secondary = (
    <>
      {parts.tags}
      {parts.relationships}
      {parts.maps}
      {parts.attachments}
      {parts.backlinks}
      {parts.footer}
    </>
  );

  return (
    <PanelShell
      layout={layout}
      backLabel={backLabel}
      onClose={leave}
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
      {layout === 'panel' ? (
        <>
          {parts.banners}
          {parts.titleAndSummary}
          {parts.tags}
          {parts.relationships}
          {parts.maps}
          {parts.note}
          {parts.attachments}
          {parts.backlinks}
          {parts.footer}
        </>
      ) : (
        <div
          ref={bodyRef}
          className={
            bodyWidth >= TWO_COLUMN_MIN_WIDTH
              ? 'grid grid-cols-[minmax(0,1fr)_20rem] items-start gap-8'
              : 'space-y-6'
          }
        >
          <div className="min-w-0 space-y-4">
            {parts.banners}
            {parts.titleAndSummary}
            {parts.note}
          </div>
          {bodyWidth >= TWO_COLUMN_MIN_WIDTH ? (
            <aside aria-label="Node details" className="min-w-0 space-y-6">
              {secondary}
            </aside>
          ) : (
            <details className="group rounded-md border">
              <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Details: tags, relationships, maps, attachments and links
              </summary>
              <div className="min-w-0 space-y-6 border-t p-4">{secondary}</div>
            </details>
          )}
        </div>
      )}

      {reviewing && (
        <ReviewDialog
          nodeTitle={node.title}
          timeZone={timeZone}
          error={reviewError}
          onSubmit={(reflection, learnedAt) => void markReviewed(reflection, learnedAt)}
          onClose={() => setReviewing(false)}
        />
      )}

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

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Leave without saving?"
        confirmLabel="Leave"
        onConfirm={() => {
          setConfirmLeave(false);
          onClose();
        }}
      >
        <p>
          Your latest changes could not be saved. They are kept on this computer, and mmap offers to
          restore them the next time you open this node.
        </p>
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
      <p>
        This cannot be undone. Copies of the workspace folder you made earlier are not affected.
      </p>
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
  layout,
  backLabel,
}: {
  children: ReactNode;
  onClose: () => void;
  status?: ReactNode;
  layout: 'panel' | 'page';
  backLabel: string;
}) {
  if (layout === 'page') {
    return (
      <article aria-label="Node editor" className="flex min-w-0 flex-col">
        {/* Stays visible while the note scrolls; spans the main area's padding. */}
        <div className="sticky -top-6 z-10 -mx-6 -mt-6 mb-6 flex items-center gap-3 border-b bg-background/95 px-6 py-2 backdrop-blur">
          <Button variant="ghost" size="sm" onClick={onClose}>
            <ArrowLeft aria-hidden="true" />
            {backLabel}
          </Button>
          <div aria-live="polite" className="ml-auto text-sm">
            {status}
          </div>
        </div>
        {children}
      </article>
    );
  }
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

/** Width of an element, updated as it resizes (0 until measured). */
function useElementWidth<Element extends HTMLElement>(): [
  (element: Element | null) => void,
  number,
] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  // Stable, so the element is observed once rather than on every render.
  const ref = useCallback((element: Element | null) => {
    observer.current?.disconnect();
    if (element === null) return;
    observer.current = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.current.observe(element);
  }, []);
  return [ref, width];
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
