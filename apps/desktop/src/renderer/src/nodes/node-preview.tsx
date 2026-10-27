/**
 * A read-only preview of a node's note, beside the current view (Mind Maps opens items this way
 * when they are double-clicked). The pencil button in the corner switches to the node editor.
 *
 * The preview re-reads the node when nodes change elsewhere, so it never shows stale text.
 */

import type { NodeView } from '@mmap/contracts';
import { Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { Button } from '../components/ui/button';
import { errorMessage, unwrap } from '../lib/ipc';
import { NoteView } from '../notes/note-view';
import { useNodesChanged } from './node-events';

export interface NodePreviewProps {
  readonly nodeId: string;
  readonly onClose: () => void;
  /** Switches to the node editor for this node. */
  readonly onEdit: (nodeId: string) => void;
  /** Opens another node (following a node link in the note). */
  readonly onOpenNode: (nodeId: string) => void;
}

type PreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly node: NodeView }
  | { readonly status: 'error'; readonly message: string };

export function NodePreview({ nodeId, onClose, onEdit, onOpenNode }: NodePreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const titleId = useId();

  const load = useCallback(() => {
    unwrap(window.mmap.nodes.get({ nodeId })).then(
      (node) => setState({ status: 'loaded', node }),
      (error: unknown) => setState({ status: 'error', message: errorMessage(error) }),
    );
  }, [nodeId]);
  useEffect(load, [load]);
  useNodesChanged(load);

  const node = state.status === 'loaded' ? state.node : null;
  const empty = node !== null && (node.note.content?.length ?? 0) === 0;

  return (
    <aside
      aria-labelledby={titleId}
      className="flex w-full max-w-md shrink-0 flex-col border-l bg-background"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Preview</p>
          <h2 id={titleId} className="text-lg font-semibold break-words">
            {node?.title ?? (state.status === 'error' ? 'Note unavailable' : 'Loading…')}
          </h2>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Edit note"
          title="Edit note"
          disabled={node === null}
          onClick={() => onEdit(nodeId)}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close preview" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 space-y-4 overflow-auto p-6">
        {state.status === 'error' && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        {node !== null && node.tags.length > 0 && (
          <ul aria-label="Tags" className="flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <li key={tag.id} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {tag.label}
              </li>
            ))}
          </ul>
        )}
        {node !== null &&
          (empty ? (
            <p className="text-sm text-muted-foreground">
              This note is empty. Select the pencil to write it.
            </p>
          ) : (
            <NoteView key={node.revision} note={node.note} onOpenNode={onOpenNode} />
          ))}
      </div>
    </aside>
  );
}
