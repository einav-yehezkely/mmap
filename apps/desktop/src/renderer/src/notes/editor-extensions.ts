/**
 * Tiptap configuration for rich notes (PRD §5.3).
 *
 * The node and mark set here must match the note schema in `@mmap/domain`
 * (`notes/note-document.ts`); `editor-schema.test.ts` checks that editor output is accepted and
 * stable under normalization. Anything the editor cannot produce is rejected on save.
 *
 * Security decisions (PRD §8):
 * - Links accept only the domain's safe schemes (`http`, `https`, `mailto`) and never open on
 *   click inside the editor; opening links externally is a separate, explicit action.
 * - KaTeX runs with `trust: false` (no `\href`, `\url`, `\htmlClass` and similar commands that
 *   could produce links or raw HTML) and with expansion/size limits so a hostile formula cannot
 *   hang the renderer.
 * - Content is rendered from the ProseMirror schema, never from HTML strings, so unknown markup in
 *   stored or imported notes cannot reach the DOM.
 */

import { isSafeLinkHref } from '@mmap/domain';
import type { Extensions } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Mathematics } from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import type { KatexOptions } from 'katex';

import { AttachmentNode } from './attachment-node';

export const KATEX_OPTIONS: KatexOptions = {
  throwOnError: false,
  trust: false,
  strict: 'ignore',
  maxSize: 50,
  maxExpand: 500,
  output: 'htmlAndMathml',
};

export interface EditorExtensionCallbacks {
  /** Called when the user activates a math node, to edit its LaTeX source. */
  readonly onEditMath?: (kind: 'inline' | 'block', latex: string, position: number) => void;
}

export function createNoteExtensions(callbacks: EditorExtensionCallbacks = {}): Extensions {
  return [
    StarterKit.configure({
      // Undo history, headings 1–6, lists, code blocks, quotes, rules, hard breaks, marks.
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ['http', 'https', 'mailto'],
        defaultProtocol: 'https',
        isAllowedUri: (url) => isSafeLinkHref(url),
        shouldAutoLink: (url) => isSafeLinkHref(url),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    AttachmentNode,
    Mathematics.configure({
      katexOptions: KATEX_OPTIONS,
      inlineOptions: {
        onClick: (node, position) =>
          callbacks.onEditMath?.('inline', String(node.attrs.latex ?? ''), position),
      },
      blockOptions: {
        onClick: (node, position) =>
          callbacks.onEditMath?.('block', String(node.attrs.latex ?? ''), position),
      },
    }),
  ];
}
