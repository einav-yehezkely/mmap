import { describe, expect, it } from 'vitest';

import type { NoteBlockNode, NoteDocument, NoteInlineNode, NoteTextNode } from './note-document';
import { emptyNoteDocument, parseNoteDocument } from './note-document';
import { extractPlainText } from './plain-text';

function doc(...content: NoteBlockNode[]): NoteDocument {
  // Round-trip through the validator so every fixture is a document the app could really store.
  return parseNoteDocument({ type: 'doc', content });
}

function p(...content: NoteInlineNode[]): NoteBlockNode {
  return { type: 'paragraph', content };
}

function t(text: string): NoteTextNode {
  return { type: 'text', text };
}

function bullets(...items: NoteBlockNode[][]): NoteBlockNode {
  return { type: 'bulletList', content: items.map((content) => ({ type: 'listItem', content })) };
}

function cell(text: string): {
  type: 'tableCell';
  attrs: { colspan: number; rowspan: number; colwidth: null };
  content: NoteBlockNode[];
} {
  return {
    type: 'tableCell',
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: text === '' ? [p()] : [p(t(text))],
  };
}

describe('extractPlainText', () => {
  it('returns an empty string for an empty note', () => {
    expect(extractPlainText(emptyNoteDocument())).toBe('');
    expect(extractPlainText(doc())).toBe('');
  });

  it('puts headings and paragraphs on separate lines and joins inline text', () => {
    const note = doc(
      { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
      p(t('Hello '), { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, t(' world')),
      p(t('Second')),
    );

    expect(extractPlainText(note)).toBe('Title\nHello bold world\nSecond');
  });

  it('puts every list item, including nested ones, on its own line', () => {
    const note = doc(
      bullets([p(t('one'))], [p(t('two')), bullets([p(t('two.a'))], [p(t('two.b'))])]),
      {
        type: 'orderedList',
        attrs: { start: 5 },
        content: [{ type: 'listItem', content: [p(t('five'))] }],
      },
    );

    expect(extractPlainText(note)).toBe('one\ntwo\ntwo.a\ntwo.b\nfive');
  });

  it('includes task items regardless of their checked state', () => {
    const note = doc({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] },
      ],
    });

    expect(extractPlainText(note)).toBe('done\ntodo');
  });

  it('separates table cells with tabs and rows with newlines', () => {
    const note = doc(
      p(t('Before')),
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('Name'), cell('Value')] },
          { type: 'tableRow', content: [cell('a'), cell('1')] },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableHeader',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                content: [p(t('multi')), p(t('line'))],
              },
              cell('x'),
            ],
          },
        ],
      },
      p(t('After')),
    );

    expect(extractPlainText(note)).toBe('Before\nName\tValue\na\t1\nmulti line\tx\nAfter');
  });

  it('includes LaTeX source for inline and block math', () => {
    const note = doc(
      p(t('Energy '), { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }, t(' holds')),
      { type: 'blockMath', attrs: { latex: '\\sum_{i=1}^n i' } },
    );

    expect(extractPlainText(note)).toBe('Energy E=mc^2 holds\n\\sum_{i=1}^n i');
  });

  it('turns hard breaks into newlines', () => {
    const note = doc(p(t('line one'), { type: 'hardBreak' }, t('line two')));

    expect(extractPlainText(note)).toBe('line one\nline two');
  });

  it('includes attachment display names, code and quotes', () => {
    const note = doc(
      {
        type: 'attachment',
        attrs: {
          attachmentId: '00000000-0000-4000-8000-0000000000aa',
          displayName: 'diagram.png',
          kind: 'image',
        },
      },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\nconst b = 2;')] },
      { type: 'blockquote', content: [p(t('quoted'))] },
    );

    expect(extractPlainText(note)).toBe('diagram.png\nconst a = 1;\nconst b = 2;\nquoted');
  });

  it('collapses runs of blank lines and trims the result', () => {
    const note = doc(
      p(),
      p(t('first')),
      p(),
      p(),
      p(),
      { type: 'horizontalRule' },
      p(t('second')),
      p(),
      p(),
    );

    expect(extractPlainText(note)).toBe('first\n\nsecond');
  });

  it('preserves Unicode text exactly', () => {
    const note = doc(p(t('שלום \u200fעולם')), p(t('emoji 👩\u200d💻 and e\u0301')));

    expect(extractPlainText(note)).toBe('שלום \u200fעולם\nemoji 👩\u200d💻 and e\u0301');
  });
});

describe('extractPlainText: wikilinks', () => {
  it('contributes the label, so search finds what the reader sees', () => {
    expect(
      extractPlainText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'See ' },
              {
                type: 'wikilink',
                attrs: { targetNodeId: '3f2c9a4e-1b7d-4c2e-9f00-0123456789ab', label: 'Entropy' },
              },
            ],
          },
        ],
      }),
    ).toBe('See Entropy');
  });
});
