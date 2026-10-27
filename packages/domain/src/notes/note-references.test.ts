import { describe, expect, it } from 'vitest';

import { parseNoteDocument } from './note-document';
import { EXCERPT_LENGTH, extractNoteReferences } from './note-references';

const A = '3f2c9a4e-1b7d-4c2e-9f00-00000000000a';
const B = '3f2c9a4e-1b7d-4c2e-9f00-00000000000b';
const link = (targetNodeId: string, label: string) => ({
  type: 'wikilink',
  attrs: { targetNodeId, label },
});
const text = (value: string) => ({ type: 'text', text: value });

describe('extractNoteReferences', () => {
  it('returns one reference per occurrence, in document order, with excerpts', () => {
    const document = parseNoteDocument({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [text('Heat flows, see '), link(A, 'Entropy'), text('.')] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [link(B, 'Order'), text(' versus '), link(A, 'disorder')],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(extractNoteReferences(document)).toEqual([
      { ordinal: 0, targetNodeId: A, label: 'Entropy', excerpt: 'Heat flows, see Entropy.' },
      { ordinal: 1, targetNodeId: B, label: 'Order', excerpt: 'Order versus disorder' },
      { ordinal: 2, targetNodeId: A, label: 'disorder', excerpt: 'Order versus disorder' },
    ]);
  });

  it('finds links inside tables', () => {
    const document = parseNoteDocument({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'paragraph', content: [link(A, 'Cell link')] }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(extractNoteReferences(document).map((reference) => reference.label)).toEqual([
      'Cell link',
    ]);
  });

  it('shortens long excerpts around the link with ellipses', () => {
    const long = 'word '.repeat(200);
    const document = parseNoteDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [text(long), link(A, 'Target'), text(` ${long}`)] }],
    });

    const [reference] = extractNoteReferences(document);

    expect(reference?.excerpt.length).toBeLessThanOrEqual(EXCERPT_LENGTH + 2);
    expect(reference?.excerpt).toContain('Target');
    expect(reference?.excerpt.startsWith('…')).toBe(true);
    expect(reference?.excerpt.endsWith('…')).toBe(true);
  });

  it('returns nothing for notes without links', () => {
    expect(
      extractNoteReferences(
        parseNoteDocument({
          type: 'doc',
          content: [{ type: 'paragraph', content: [text('plain')] }],
        }),
      ),
    ).toEqual([]);
  });
});
