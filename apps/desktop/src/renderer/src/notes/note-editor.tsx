/**
 * Rich note editor (PRD §5.3): Tiptap with headings, marks, lists, checklists, links, quotes, code
 * blocks, tables and KaTeX math. Attachments join in slice 1.5.
 *
 * Every change is normalized with the domain's `parseNoteDocument` before it is handed to the
 * autosave logic. That keeps the draft identical to what the main process will store (no endless
 * "unsaved" loop) and surfaces invalid content, such as an oversized note, immediately instead of
 * on save.
 *
 * Render with a `key` that changes when the content is replaced from outside (conflict
 * resolution, draft recovery); the editor reads `initialNote` only when it is created.
 */

import { DomainError, isSafeLinkHref, parseNoteDocument, type NoteDocument } from '@mmap/domain';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Paperclip,
  Pi,
  Quote,
  Redo2,
  Sigma,
  SquareCode,
  Strikethrough,
  Table,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { FormDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import type { AttachmentNodeAttributes } from './attachment-node';
import { createNoteExtensions, KATEX_OPTIONS } from './editor-extensions';

export interface NoteEditorProps {
  readonly initialNote: unknown;
  readonly onChange: (note: NoteDocument) => void;
  /** Called with a user-facing message when the current content cannot be saved. */
  readonly onInvalid: (message: string) => void;
  /**
   * Lets the user pick files to attach (native dialog in the main process). Resolves with the
   * attachments that were stored, which are then inserted at the cursor.
   */
  readonly onAttachFiles: () => Promise<readonly AttachmentNodeAttributes[]>;
}

interface MathEditState {
  readonly kind: 'inline' | 'block';
  readonly latex: string;
  /** Document position of an existing formula, or null to insert a new one. */
  readonly position: number | null;
}

export function NoteEditor({ initialNote, onChange, onInvalid, onAttachFiles }: NoteEditorProps) {
  // Callbacks change on every render; the editor is created once, so it reads them via a ref.
  const callbacks = useRef({ onChange, onInvalid });
  useEffect(() => {
    callbacks.current = { onChange, onInvalid };
  });

  const [mathEdit, setMathEdit] = useState<MathEditState | null>(null);
  const [linkEdit, setLinkEdit] = useState<{ href: string } | null>(null);

  const editor = useEditor({
    extensions: createNoteExtensions({
      onEditMath: (kind, latex, position) => setMathEdit({ kind, latex, position }),
    }),
    content: initialNote as NoteDocument,
    // Each paragraph gets dir="auto", so Hebrew/Arabic and English paragraphs each align
    // correctly in the same note (PRD §6: bidirectional text).
    textDirection: 'auto',
    editorProps: {
      attributes: {
        class:
          'note-content min-h-64 rounded-b-md border border-t-0 px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-label': 'Note',
        'aria-multiline': 'true',
        role: 'textbox',
      },
      // Ctrl+click (Cmd+click on macOS) opens a link outside the app. Plain clicks only place the
      // cursor, so editing a link's text never navigates anywhere by accident.
      // Double-clicking a file attachment opens it with its default application. The main
      // process re-checks the attachment before asking the OS to open it.
      handleDoubleClick: (_view, _position, event) => {
        const element = (event.target as HTMLElement | null)?.closest(
          '[data-attachment-kind="file"]',
        );
        const attachmentId = element?.getAttribute('data-attachment-id');
        if (attachmentId) {
          void window.mmap.attachments.open({ attachmentId });
          return true;
        }
        return false;
      },
      handleClick: (_view, _position, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const href = (event.target as HTMLElement | null)?.closest('a')?.getAttribute('href');
        if (href) {
          void window.mmap.app.openExternalLink({ href });
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: updated }) => {
      try {
        callbacks.current.onChange(parseNoteDocument(updated.getJSON()));
      } catch (error) {
        callbacks.current.onInvalid(
          error instanceof DomainError ? error.message : 'This note cannot be saved.',
        );
      }
    },
  });

  return (
    <div>
      <Toolbar
        editor={editor}
        onEditLink={() => setLinkEdit({ href: String(editor.getAttributes('link').href ?? '') })}
        onInsertMath={(kind) => setMathEdit({ kind, latex: '', position: null })}
        onAttachFiles={() =>
          void onAttachFiles().then((attachments) => {
            if (attachments.length > 0) {
              editor.chain().focus().insertAttachments(attachments).run();
            }
          })
        }
      />
      <EditorContent editor={editor} />
      <p className="mt-1 text-xs text-muted-foreground">
        Tip: Ctrl+click a link to open it in your browser. Click a formula to edit it. Double-click
        an attached file to open it.
      </p>
      {mathEdit && (
        <MathDialog
          state={mathEdit}
          onClose={() => setMathEdit(null)}
          onSave={(latex) => {
            applyMath(editor, mathEdit, latex);
            setMathEdit(null);
          }}
        />
      )}
      {linkEdit && (
        <LinkDialog
          initialHref={linkEdit.href}
          onClose={() => setLinkEdit(null)}
          onSave={(href) => {
            applyLink(editor, href);
            setLinkEdit(null);
          }}
        />
      )}
    </div>
  );
}

function applyMath(editor: Editor, state: MathEditState, latex: string): void {
  const chain = editor.chain().focus();
  const trimmed = latex.trim();
  if (state.position === null) {
    if (trimmed === '') return;
    (state.kind === 'inline'
      ? chain.insertInlineMath({ latex: trimmed })
      : chain.insertBlockMath({ latex: trimmed })
    ).run();
    return;
  }
  const position = state.position;
  if (trimmed === '') {
    (state.kind === 'inline'
      ? chain.deleteInlineMath({ pos: position })
      : chain.deleteBlockMath({ pos: position })
    ).run();
    return;
  }
  (state.kind === 'inline'
    ? chain.updateInlineMath({ latex: trimmed, pos: position })
    : chain.updateBlockMath({ latex: trimmed, pos: position })
  ).run();
}

function applyLink(editor: Editor, href: string): void {
  const chain = editor.chain().focus().extendMarkRange('link');
  if (href === '') {
    chain.unsetLink().run();
    return;
  }
  if (editor.state.selection.empty && !editor.isActive('link')) {
    // No text selected: insert the address itself as linked text.
    chain
      .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
      .run();
    return;
  }
  chain.setLink({ href }).run();
}

interface ToolbarProps {
  readonly editor: Editor;
  readonly onEditLink: () => void;
  readonly onInsertMath: (kind: 'inline' | 'block') => void;
  readonly onAttachFiles: () => void;
}

function Toolbar({ editor, onEditLink, onInsertMath, onAttachFiles }: ToolbarProps) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      underline: current.isActive('underline'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
      h1: current.isActive('heading', { level: 1 }),
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'),
      inTable: current.isActive('table'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });

  const run = (command: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) =>
    command(editor.chain().focus()).run();

  return (
    <div className="rounded-t-md border bg-muted/50">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap items-center gap-0.5 p-1"
      >
        <ToolbarButton
          icon={Bold}
          label="Bold (Ctrl+B)"
          pressed={active.bold}
          onClick={() => run((c) => c.toggleBold())}
        />
        <ToolbarButton
          icon={Italic}
          label="Italic (Ctrl+I)"
          pressed={active.italic}
          onClick={() => run((c) => c.toggleItalic())}
        />
        <ToolbarButton
          icon={Underline}
          label="Underline (Ctrl+U)"
          pressed={active.underline}
          onClick={() => run((c) => c.toggleUnderline())}
        />
        <ToolbarButton
          icon={Strikethrough}
          label="Strikethrough"
          pressed={active.strike}
          onClick={() => run((c) => c.toggleStrike())}
        />
        <ToolbarButton
          icon={Code}
          label="Inline code"
          pressed={active.code}
          onClick={() => run((c) => c.toggleCode())}
        />
        <ToolbarButton icon={Link} label="Link" pressed={active.link} onClick={onEditLink} />
        <Separator />
        <ToolbarButton
          icon={Heading1}
          label="Heading 1"
          pressed={active.h1}
          onClick={() => run((c) => c.toggleHeading({ level: 1 }))}
        />
        <ToolbarButton
          icon={Heading2}
          label="Heading 2"
          pressed={active.h2}
          onClick={() => run((c) => c.toggleHeading({ level: 2 }))}
        />
        <ToolbarButton
          icon={Heading3}
          label="Heading 3"
          pressed={active.h3}
          onClick={() => run((c) => c.toggleHeading({ level: 3 }))}
        />
        <Separator />
        <ToolbarButton
          icon={List}
          label="Bulleted list"
          pressed={active.bulletList}
          onClick={() => run((c) => c.toggleBulletList())}
        />
        <ToolbarButton
          icon={ListOrdered}
          label="Numbered list"
          pressed={active.orderedList}
          onClick={() => run((c) => c.toggleOrderedList())}
        />
        <ToolbarButton
          icon={ListTodo}
          label="Checklist"
          pressed={active.taskList}
          onClick={() => run((c) => c.toggleTaskList())}
        />
        <ToolbarButton
          icon={Quote}
          label="Quote"
          pressed={active.blockquote}
          onClick={() => run((c) => c.toggleBlockquote())}
        />
        <ToolbarButton
          icon={SquareCode}
          label="Code block"
          pressed={active.codeBlock}
          onClick={() => run((c) => c.toggleCodeBlock())}
        />
        <ToolbarButton
          icon={Table}
          label="Insert table"
          onClick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
        />
        <Separator />
        <ToolbarButton icon={Pi} label="Inline formula" onClick={() => onInsertMath('inline')} />
        <ToolbarButton icon={Sigma} label="Display formula" onClick={() => onInsertMath('block')} />
        <ToolbarButton icon={Paperclip} label="Attach files" onClick={onAttachFiles} />
        <Separator />
        <ToolbarButton
          icon={Undo2}
          label="Undo (Ctrl+Z)"
          disabled={!active.canUndo}
          onClick={() => run((c) => c.undo())}
        />
        <ToolbarButton
          icon={Redo2}
          label="Redo (Ctrl+Y)"
          disabled={!active.canRedo}
          onClick={() => run((c) => c.redo())}
        />
      </div>
      {active.inTable && (
        <div
          role="toolbar"
          aria-label="Table"
          className="flex flex-wrap gap-1 border-t px-2 py-1 text-xs"
        >
          <TextButton onClick={() => run((c) => c.addRowAfter())}>+ Row</TextButton>
          <TextButton onClick={() => run((c) => c.addColumnAfter())}>+ Column</TextButton>
          <TextButton onClick={() => run((c) => c.deleteRow())}>− Row</TextButton>
          <TextButton onClick={() => run((c) => c.deleteColumn())}>− Column</TextButton>
          <TextButton onClick={() => run((c) => c.deleteTable())}>Delete table</TextButton>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  pressed,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
        pressed && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function Separator() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />;
}

function MathDialog({
  state,
  onClose,
  onSave,
}: {
  state: MathEditState;
  onClose: () => void;
  onSave: (latex: string) => void;
}) {
  const [latex, setLatex] = useState(state.latex);
  const preview = useRef<HTMLDivElement>(null);
  const fieldId = useId();

  // KaTeX renders into the element directly (no HTML strings in React); `trust: false` prevents
  // links and raw HTML in formulas.
  useEffect(() => {
    if (preview.current) {
      katex.render(latex || '\\square', preview.current, {
        ...KATEX_OPTIONS,
        displayMode: state.kind === 'block',
      });
    }
  }, [latex, state.kind]);

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={state.kind === 'inline' ? 'Inline formula' : 'Display formula'}
      description="Write LaTeX. Leave empty to remove the formula."
      submitLabel={state.position === null ? 'Insert' : 'Save'}
      onSubmit={() => onSave(latex)}
    >
      <label htmlFor={fieldId} className="sr-only">
        LaTeX source
      </label>
      <textarea
        id={fieldId}
        dir="ltr"
        value={latex}
        onChange={(event) => setLatex(event.target.value)}
        rows={3}
        spellCheck={false}
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        placeholder="e.g. \frac{a}{b}"
      />
      <div
        aria-label="Preview"
        className="min-h-12 overflow-x-auto rounded-md border px-3 py-2"
        ref={preview}
      />
    </FormDialog>
  );
}

function LinkDialog({
  initialHref,
  onClose,
  onSave,
}: {
  initialHref: string;
  onClose: () => void;
  onSave: (href: string) => void;
}) {
  const [href, setHref] = useState(initialHref);
  const fieldId = useId();
  const trimmed = href.trim();
  const invalid = trimmed !== '' && !isSafeLinkHref(trimmed);

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Link"
      description="Web (https://…) and email (mailto:…) addresses are supported."
      submitLabel="Save link"
      submitDisabled={invalid || trimmed === ''}
      onSubmit={() => onSave(trimmed)}
      {...(initialHref !== ''
        ? { secondaryAction: { label: 'Remove link', onClick: () => onSave('') } }
        : {})}
    >
      <label htmlFor={fieldId} className="text-sm">
        Address
      </label>
      <Input
        id={fieldId}
        dir="ltr"
        value={href}
        onChange={(event) => setHref(event.target.value)}
        placeholder="https://example.org"
        aria-invalid={invalid}
        aria-describedby={invalid ? `${fieldId}-error` : undefined}
      />
      {invalid && (
        <p id={`${fieldId}-error`} className="text-sm text-destructive">
          Only http, https and mailto addresses can be linked.
        </p>
      )}
    </FormDialog>
  );
}
