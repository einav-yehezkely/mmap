// @vitest-environment jsdom
/**
 * Contract between the Tiptap editor and the domain note schema.
 *
 * If these drift apart, either saves are rejected (editor produces something the domain does not
 * allow) or autosave never settles (normalized output differs from what the editor shows). Both
 * would be user-visible data problems, so the editor's real output is tested here.
 */

import { parseNoteDocument } from '@mmap/domain';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createNoteExtensions } from './editor-extensions';

const editors: Editor[] = [];

function createEditor(content: unknown): Editor {
  const editor = new Editor({
    extensions: createNoteExtensions(),
    content: content as Record<string, unknown>,
    textDirection: 'auto',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });

/** A document exercising every node and mark the note schema allows. */
const EVERYTHING = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('Heading')] },
    paragraph(
      text('bold', [{ type: 'bold' }]),
      text(' italic', [{ type: 'italic' }]),
      text(' strike', [{ type: 'strike' }]),
      text(' underline', [{ type: 'underline' }]),
      text(' code', [{ type: 'code' }]),
      text(' link', [{ type: 'link', attrs: { href: 'https://example.org' } }]),
      { type: 'hardBreak' },
      { type: 'inlineMath', attrs: { latex: 'E = mc^2' } },
      text(' שלום עולם'),
    ),
    { type: 'blockquote', content: [paragraph(text('Quote'))] },
    {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(text('Bullet'))] }],
    },
    {
      type: 'orderedList',
      attrs: { start: 3 },
      content: [{ type: 'listItem', content: [paragraph(text('Third'))] }],
    },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('Done'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text('Todo'))] },
      ],
    },
    { type: 'codeBlock', attrs: { language: 'python' }, content: [text('print("hi")')] },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [paragraph(text('Header'))] },
            { type: 'tableHeader', content: [paragraph(text('Second'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [paragraph(text('Cell'))] },
            { type: 'tableCell', content: [paragraph(text('Other'))] },
          ],
        },
      ],
    },
    { type: 'blockMath', attrs: { latex: '\\int_0^1 x\\,dx' } },
    {
      type: 'attachment',
      attrs: {
        attachmentId: '3f2c9a4e-1b7d-4c2e-9f00-0123456789ab',
        displayName: 'diagram.png',
        kind: 'image',
      },
    },
    {
      type: 'attachment',
      attrs: {
        attachmentId: '3f2c9a4e-1b7d-4c2e-9f00-0123456789ac',
        displayName: 'paper.pdf',
        kind: 'file',
      },
    },
  ],
};

describe('editor ↔ note schema contract', () => {
  it('produces output the domain accepts for every supported node and mark', () => {
    const editor = createEditor(EVERYTHING);

    expect(() => parseNoteDocument(editor.getJSON())).not.toThrow();
  });

  it('round-trips without loss: normalize → load → normalize is stable', () => {
    const first = parseNoteDocument(createEditor(EVERYTHING).getJSON());
    const second = parseNoteDocument(createEditor(first).getJSON());

    // Stability is what lets autosave settle on "Saved" instead of saving forever.
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).toContain('E = mc^2');
    expect(JSON.stringify(first)).toContain('שלום עולם');
  });

  it('defends against javascript: links in two layers', () => {
    // Stored notes cannot contain such a link (the domain rejects it on every save and import).
    // If one were injected into the editor anyway, it must still never reach the DOM, and the
    // editor output must still be refused by the domain so it cannot be saved.
    const editor = createEditor({
      type: 'doc',
      content: [
        paragraph(text('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }])),
      ],
    });

    expect(editor.view.dom.innerHTML).not.toContain('javascript:');
    expect(() => parseNoteDocument(editor.getJSON())).toThrow();
  });

  it('keeps an empty document valid', () => {
    expect(() =>
      parseNoteDocument(createEditor({ type: 'doc', content: [] }).getJSON()),
    ).not.toThrow();
  });
});
