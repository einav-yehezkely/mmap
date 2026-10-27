/**
 * Markdown export (PRD §5.11): readable notes with stable IDs, wikilinks, math source and
 * attachment references.
 */

import { describe, expect, it } from 'vitest';

import { parseNoteDocument } from '../notes/note-document';
import {
  escapeText,
  markdownFileName,
  nodeToMarkdown,
  noteToMarkdown,
  type MarkdownLinks,
} from './markdown-export';

const HEAT = '3f2c1a9b-0000-4000-8000-000000000001';
const GONE = '99999999-0000-4000-8000-000000000009';
const IMAGE = 'aaaaaaaa-0000-4000-8000-00000000000a';

const links: MarkdownLinks = {
  nodeFile: (id) => (id === HEAT ? 'Heat (3f2c1a9b).md' : null),
  attachmentPath: (id) => (id === IMAGE ? '../attachments/aaaaaaaa engine.png' : null),
};

const doc = (content: unknown[]) => parseNoteDocument({ type: 'doc', content });
const text = (value: string, marks?: unknown[]) => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});

describe('noteToMarkdown', () => {
  it('writes formatting, links and math', () => {
    const markdown = noteToMarkdown(
      doc([
        { type: 'heading', attrs: { level: 2 }, content: [text('Laws')] },
        {
          type: 'paragraph',
          content: [
            text('Energy ', [{ type: 'bold' }]),
            text('flows', [{ type: 'italic' }]),
            text(' to '),
            { type: 'wikilink', attrs: { targetNodeId: HEAT, label: 'heat' } },
            text(' and '),
            { type: 'wikilink', attrs: { targetNodeId: GONE, label: 'a deleted note' } },
            text(': '),
            { type: 'inlineMath', attrs: { latex: 'dS = \\delta Q / T' } },
            text(' see '),
            text('docs', [{ type: 'link', attrs: { href: 'https://example.org/docs?a=1' } }]),
          ],
        },
        { type: 'blockMath', attrs: { latex: 'S = k_B \\ln W' } },
      ]),
      links,
    );
    expect(markdown).toBe(
      [
        '## Laws',
        '',
        '**Energy** *flows* to [[Heat (3f2c1a9b)|heat]] and a deleted note: ' +
          '$dS = \\delta Q / T$ see [docs](<https://example.org/docs?a=1>)',
        '',
        '$$\nS = k_B \\ln W\n$$',
      ].join('\n'),
    );
  });

  it('writes nested lists, tasks, quotes and code', () => {
    const markdown = noteToMarkdown(
      doc([
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [text('First')] },
                {
                  type: 'orderedList',
                  attrs: { start: 3 },
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [text('Nested')] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [text('Done')] }],
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text('Quoted')] }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = "```";')] },
      ]),
      links,
    );
    expect(markdown).toBe(
      [
        '- First',
        '',
        '  3. Nested',
        '',
        '- [x] Done',
        '',
        '> Quoted',
        '',
        '````ts\nconst a = "```";\n````',
      ].join('\n'),
    );
  });

  it('links attachments and marks missing ones', () => {
    const markdown = noteToMarkdown(
      doc([
        {
          type: 'attachment',
          attrs: { attachmentId: IMAGE, displayName: 'engine.png', kind: 'image' },
        },
        {
          type: 'attachment',
          attrs: { attachmentId: GONE, displayName: 'lost.pdf', kind: 'file' },
        },
      ]),
      links,
    );
    expect(markdown).toBe(
      '![engine.png](<../attachments/aaaaaaaa engine.png>)\n\n*Missing attachment: lost.pdf*',
    );
  });

  it('writes tables with a header row and escaped pipes', () => {
    const cell = (type: string, value: string) => ({
      type,
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [{ type: 'paragraph', content: [text(value)] }],
    });
    const markdown = noteToMarkdown(
      doc([
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('tableHeader', 'Law'), cell('tableHeader', 'Formula')],
            },
            { type: 'tableRow', content: [cell('tableCell', 'First'), cell('tableCell', 'a|b')] },
          ],
        },
      ]),
      links,
    );
    expect(markdown).toBe('| Law | Formula |\n| --- | --- |\n| First | a\\\\|b |');
  });

  it('escapes text that Markdown would interpret', () => {
    expect(escapeText('*not bold* [x] $5')).toBe('\\*not bold\\* \\[x\\] \\$5');
    const markdown = noteToMarkdown(
      doc([{ type: 'paragraph', content: [text('# not a heading')] }]),
      links,
    );
    expect(markdown).toBe('\\# not a heading');
  });
});

describe('nodeToMarkdown', () => {
  it('writes front matter with the stable ID, the title and relationships', () => {
    const markdown = nodeToMarkdown(
      {
        id: '11111111-0000-4000-8000-000000000001',
        title: 'Entropy: "disorder"',
        summary: null,
        tags: ['thermo'],
        createdAt: '2026-10-27T10:00:00.000Z',
        updatedAt: '2026-10-27T11:00:00.000Z',
        note: doc([]),
        relationships: [
          { typeLabel: 'explains', direction: 'outgoing', otherNodeId: HEAT, otherTitle: 'Heat' },
          {
            typeLabel: 'related to',
            direction: 'undirected',
            otherNodeId: GONE,
            otherTitle: 'Gone',
          },
        ],
      },
      links,
    );
    expect(markdown).toBe(
      [
        '---',
        'id: "11111111-0000-4000-8000-000000000001"',
        'title: "Entropy: \\"disorder\\""',
        'tags: ["thermo"]',
        'created: "2026-10-27T10:00:00.000Z"',
        'updated: "2026-10-27T11:00:00.000Z"',
        '---',
        '',
        '# Entropy: "disorder"',
        '',
        '## Relationships',
        '',
        '- explains → [[Heat (3f2c1a9b)|Heat]]',
        '- related to — Gone',
        '',
      ].join('\n'),
    );
  });
});

describe('markdownFileName', () => {
  it('makes safe, unique file names', () => {
    expect(markdownFileName('Entropy', '3f2c1a9b-0000')).toBe('Entropy (3f2c1a9b).md');
    expect(markdownFileName('a/b:c?*[d]|e#', '12345678-x')).toBe('a b c d e (12345678).md');
    expect(markdownFileName('CON', '12345678-x')).toBe('_CON (12345678).md');
    expect(markdownFileName('...', '12345678-x')).toBe('Untitled (12345678).md');
    expect(markdownFileName('x'.repeat(300), '12345678-x')).toHaveLength(
      80 + ' (12345678).md'.length,
    );
  });
});
