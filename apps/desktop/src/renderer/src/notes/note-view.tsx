/**
 * A note shown read-only, exactly as the editor draws it (formatting, formulas, attachments,
 * links, right-to-left paragraphs), for previews. Nothing here can change the note.
 *
 * Reading has no cursor to place, so a plain click follows a link: a node link opens that node,
 * a web link opens in the browser (the main process re-checks it first). Double-clicking an
 * attached file opens it, as in the editor.
 */

import type { NoteDocument } from '@mmap/domain';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

import { errorMessage, unwrap } from '../lib/ipc';
import { createNoteExtensions } from './editor-extensions';

export interface NoteViewProps {
  readonly note: unknown;
  /** Opens another node (following a node link). */
  readonly onOpenNode: (nodeId: string) => void;
}

export function NoteView({ note, onOpenNode }: NoteViewProps) {
  // The editor is created once (render with a key to show another note); it reads the latest
  // callback via a ref.
  const openNode = useRef(onOpenNode);
  useEffect(() => {
    openNode.current = onOpenNode;
  });
  const [notice, setNotice] = useState<string | null>(null);

  const editor = useEditor({
    extensions: createNoteExtensions(),
    content: note as NoteDocument,
    editable: false,
    textDirection: 'auto',
    editorProps: {
      attributes: { class: 'note-content', 'aria-label': 'Note', 'aria-readonly': 'true' },
      handleClick: (_view, _position, event) => {
        const target = event.target as HTMLElement | null;
        const nodeId = target
          ?.closest('[data-wikilink-target]')
          ?.getAttribute('data-wikilink-target');
        if (nodeId) {
          openNode.current(nodeId);
          return true;
        }
        const href = target?.closest('a')?.getAttribute('href');
        if (href) {
          void window.mmap.app.openExternalLink({ href });
          return true;
        }
        return false;
      },
      handleDoubleClick: (_view, _position, event) => {
        const attachmentId = (event.target as HTMLElement | null)
          ?.closest('[data-attachment-kind="file"]')
          ?.getAttribute('data-attachment-id');
        if (!attachmentId) return false;
        void unwrap(window.mmap.attachments.open({ attachmentId })).then(
          ({ opened }) =>
            setNotice(
              opened ? null : 'This file could not be opened. It may be missing or was removed.',
            ),
          (error: unknown) => setNotice(errorMessage(error)),
        );
        return true;
      },
    },
  });

  return (
    <div>
      <EditorContent editor={editor} />
      {notice && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {notice}
        </p>
      )}
    </div>
  );
}
