import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';
import {
  emptyNoteDocument,
  NOTE_LIMITS,
  NOTE_SCHEMA_VERSION,
  parseNoteDocument,
  utf8ByteLength,
} from './note-document';

const ATTACHMENT_ID = '00000000-0000-4000-8000-0000000000aa';

/** Wraps blocks in a `doc` root. Inputs are deliberately untyped: they model untrusted JSON. */
function doc(...content: unknown[]): Record<string, unknown> {
  return { type: 'doc', content };
}

function paragraph(...content: unknown[]): Record<string, unknown> {
  return { type: 'paragraph', content };
}

function text(value: unknown, marks?: unknown[]): Record<string, unknown> {
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

function cell(attrs: Record<string, unknown>, ...content: unknown[]): Record<string, unknown> {
  return { type: 'tableCell', attrs, content };
}

function expectRejected(value: unknown, message?: RegExp): DomainError {
  let caught: unknown;
  try {
    parseNoteDocument(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  const domainError = caught as DomainError;
  expect(domainError.code).toBe('VALIDATION_FAILED');
  if (message !== undefined) {
    expect(domainError.message).toMatch(message);
  }
  return domainError;
}

/** A note using every node type and mark in schema v1, as Tiptap would emit it. */
function fullTiptapDocument(): Record<string, unknown> {
  return doc(
    { type: 'heading', attrs: { level: 2, textAlign: null, id: 'x' }, content: [text('Title')] },
    {
      type: 'paragraph',
      attrs: { textAlign: 'left' },
      content: [
        text('bold', [{ type: 'bold' }, { type: 'italic' }]),
        { type: 'hardBreak' },
        text('link', [
          {
            type: 'link',
            attrs: {
              href: 'https://example.com',
              target: '_blank',
              rel: 'noopener',
              class: null,
            },
          },
        ]),
        { type: 'inlineMath', attrs: { latex: 'x^2' } },
        text('rest', [{ type: 'strike' }, { type: 'underline' }, { type: 'code' }]),
      ],
    },
    { type: 'blockquote', content: [paragraph(text('quoted'))] },
    {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(text('one'))] }],
    },
    {
      type: 'orderedList',
      attrs: { start: 3, type: null },
      content: [{ type: 'listItem', content: [paragraph(text('three'))] }],
    },
    {
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('done'))] }],
    },
    { type: 'codeBlock', attrs: { language: 'c++' }, content: [text('int x;')] },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [120] } },
            cell({ colspan: 2, rowspan: 1, colwidth: [0, 80] }, paragraph(text('cell'))),
          ],
        },
      ],
    },
    { type: 'blockMath', attrs: { latex: '\\int_0^1 f' } },
    {
      type: 'attachment',
      attrs: { attachmentId: ATTACHMENT_ID, displayName: 'scan.pdf', kind: 'file' },
    },
  );
}

describe('note schema constants', () => {
  it('exposes the schema version and limits', () => {
    expect(NOTE_SCHEMA_VERSION).toBe(2);
    expect(NOTE_LIMITS.maxDepth).toBe(40);
  });
});

describe('emptyNoteDocument', () => {
  it('returns a single empty paragraph that passes validation', () => {
    const empty = emptyNoteDocument();

    expect(empty).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(parseNoteDocument(empty)).toEqual(empty);
  });

  it('returns a fresh object on every call', () => {
    expect(emptyNoteDocument()).not.toBe(emptyNoteDocument());
  });
});

describe('parseNoteDocument: accepted documents', () => {
  it('accepts every schema v1 node type and normalizes attributes', () => {
    const result = parseNoteDocument(fullTiptapDocument());

    expect(result).toEqual({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'hardBreak' },
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
            { type: 'inlineMath', attrs: { latex: 'x^2' } },
            {
              type: 'text',
              text: 'rest',
              marks: [{ type: 'strike' }, { type: 'underline' }, { type: 'code' }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'c++' },
          content: [{ type: 'text', text: 'int x;' }],
        },
        { type: 'horizontalRule' },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: [120] } },
                {
                  type: 'tableCell',
                  attrs: { colspan: 2, rowspan: 1, colwidth: [0, 80] },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell' }] }],
                },
              ],
            },
          ],
        },
        { type: 'blockMath', attrs: { latex: '\\int_0^1 f' } },
        {
          type: 'attachment',
          attrs: { attachmentId: ATTACHMENT_ID, displayName: 'scan.pdf', kind: 'file' },
        },
      ],
    });
  });

  it('fills defaults for optional attributes', () => {
    const result = parseNoteDocument(
      doc(
        { type: 'orderedList', content: [] },
        { type: 'taskList', content: [{ type: 'taskItem' }] },
        { type: 'codeBlock' },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell' }] }] },
      ),
    );

    expect(result.content).toEqual([
      { type: 'orderedList', attrs: { start: 1 }, content: [] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false } }] },
      { type: 'codeBlock', attrs: { language: null } },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null } }],
          },
        ],
      },
    ]);
  });

  it('drops unknown attributes and omits attrs when none remain', () => {
    const result = parseNoteDocument(
      doc(
        { type: 'paragraph', attrs: { textAlign: 'right', dir: 'rtl' }, content: [] },
        paragraph(
          text('x', [
            { type: 'bold', attrs: { foo: 1 } },
            { type: 'link', attrs: { href: 'mailto:a@b.c', target: '_blank', rel: 'opener' } },
          ]),
        ),
      ),
    );

    expect(result.content[0]).toEqual({ type: 'paragraph', content: [] });
    expect(result.content[1]).toEqual({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'x',
          marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'mailto:a@b.c' } }],
        },
      ],
    });
  });

  it('accepts an empty doc and null-prototype objects', () => {
    const root = Object.assign(Object.create(null) as object, { type: 'doc', content: [] });

    expect(parseNoteDocument(root)).toEqual({ type: 'doc', content: [] });
    expect(parseNoteDocument({ type: 'doc' })).toEqual({ type: 'doc', content: [] });
  });

  it('omits an empty marks array and stores trimmed link targets', () => {
    const result = parseNoteDocument(
      doc(
        paragraph(text('a', []), text('b', [{ type: 'link', attrs: { href: ' https://x.io ' } }])),
      ),
    );

    expect(result.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'https://x.io' } }] },
      ],
    });
  });

  it('returns a fresh object that later input mutations cannot change', () => {
    const input = fullTiptapDocument();
    const result = parseNoteDocument(input);
    const snapshot = structuredClone(result);

    expect(result).not.toBe(input);
    expect(result.content).not.toBe(input.content);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);

    const blocks = input.content as Record<string, unknown>[];
    blocks.push(paragraph(text('added later')));
    (blocks[0] as { attrs: { level: number } }).attrs.level = 7;
    const link = (blocks[1] as { content: { marks?: { attrs?: { href: string } }[] }[] })
      .content[2];
    link!.marks![0]!.attrs!.href = 'javascript:alert(1)';

    expect(result).toEqual(snapshot);
  });

  it('round-trips bidirectional and non-BMP Unicode text unchanged', () => {
    const samples = [
      'שלום עולם',
      '\u200fעברית\u200e with English \u202bembedded\u202c',
      '\u2067RTL isolate\u2069',
      'emoji 👩\u200d💻 🇮🇱 family 👨\u200d👩\u200d👧',
      'combining e\u0301 and Ａ full-width',
      'mixed: abc אבג 123 ٣٤٥',
    ];
    const result = parseNoteDocument(doc(...samples.map((sample) => paragraph(text(sample)))));

    expect(
      result.content.map((block) =>
        block.type === 'paragraph' && block.content?.[0]?.type === 'text'
          ? block.content[0].text
          : null,
      ),
    ).toEqual(samples);
  });

  it('accepts nesting exactly at the depth limit', () => {
    expect(() => parseNoteDocument(nestedBlockquotes(NOTE_LIMITS.maxDepth))).not.toThrow();
  });
});

/** Builds a document whose total depth (doc = 1) is `depth`, iteratively. */
function nestedBlockquotes(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: 'horizontalRule' };
  for (let level = 2; level < depth; level += 1) {
    node = { type: 'blockquote', content: [node] };
  }
  return doc(node);
}

describe('parseNoteDocument: untrusted input shapes', () => {
  class FakeDoc {
    public readonly type = 'doc';
    public readonly content = [];
  }

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ type: 'doc', content: [] }]],
    ['a string', '{"type":"doc","content":[]}'],
    ['a number', 42],
    ['a boolean', true],
    ['a class instance', new FakeDoc()],
    ['a Date', new Date()],
    ['a Map', new Map([['type', 'doc']])],
    [
      'an object with a substituted prototype',
      Object.assign(Object.create({ polluted: true }) as object, { type: 'doc', content: [] }),
    ],
  ])('rejects %s as the document', (_label, value) => {
    expectRejected(value, /plain JSON object/);
  });

  it('rejects non-plain objects nested inside the document', () => {
    expectRejected(doc(new FakeDoc()), /plain JSON object/);
    expectRejected(doc({ type: 'paragraph', attrs: new Map() }), /plain JSON object/);
  });

  it.each([
    ['the root', '{"type":"doc","content":[],"__proto__":{"polluted":true}}'],
    ['a node', '{"type":"doc","content":[{"type":"paragraph","__proto__":{}}]}'],
    ['node attrs', '{"type":"doc","content":[{"type":"paragraph","attrs":{"__proto__":{}}}]}'],
    [
      'node attrs (constructor)',
      '{"type":"doc","content":[{"type":"codeBlock","attrs":{"constructor":{}}}]}',
    ],
    [
      'node attrs (prototype)',
      '{"type":"doc","content":[{"type":"heading","attrs":{"level":1,"prototype":1}}]}',
    ],
    [
      'a mark',
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold","__proto__":{}}]}]}]}',
    ],
    [
      'mark attrs',
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"https://a.b","constructor":1}}]}]}]}',
    ],
  ])('rejects forbidden keys in %s', (_label, json) => {
    expectRejected(JSON.parse(json), /forbidden key/);
  });

  it('rejects accessor properties', () => {
    const node = { type: 'paragraph' };
    Object.defineProperty(node, 'content', { enumerable: true, get: () => [] });

    expectRejected(doc(node), /data properties/);
  });

  it('rejects unknown node properties', () => {
    expectRejected(doc({ type: 'paragraph', id: 'abc' }), /unsupported property/);
    expectRejected(doc({ type: 'horizontalRule', foo: undefined }), /unsupported property/);
  });

  it('rejects a missing or non-string node type', () => {
    expectRejected(doc({ content: [] }), /string type/);
    expectRejected(doc({ type: 3 }), /string type/);
  });

  it('rejects documents nested deeper than maxDepth', () => {
    expectRejected(nestedBlockquotes(NOTE_LIMITS.maxDepth + 1), /nested more than 40/);
  });

  it('rejects extremely deep documents without overflowing the stack', () => {
    expectRejected(nestedBlockquotes(100_000), /nested more than 40/);
  });

  it('rejects cyclic structures', () => {
    const quote: Record<string, unknown> = { type: 'blockquote' };
    quote.content = [quote];

    expectRejected(doc(quote), /nested more than 40/);
  });

  it('rejects documents with more than maxNodes nodes', () => {
    const rules = Array.from({ length: NOTE_LIMITS.maxNodes }, () => ({ type: 'horizontalRule' }));

    expectRejected({ type: 'doc', content: rules }, /more than 200000 nodes/);
  });

  it('measures the serialized size in UTF-8 bytes, not UTF-16 units', () => {
    const count = 999_990;
    // ASCII: ~1 MB serialized, under the limit.
    expect(() => parseNoteDocument(doc(paragraph(text('a'.repeat(count)))))).not.toThrow();
    // Hebrew letters are 2 bytes each in UTF-8, so the same length is ~2 MB and too large.
    expectRejected(doc(paragraph(text('א'.repeat(count)))), /maximum size/);
  });

  it('rejects documents whose combined text exceeds the size limit', () => {
    const chunk = text('x'.repeat(700_000));

    expectRejected(doc(paragraph(chunk), paragraph(chunk), paragraph(chunk)), /maximum size/);
  });

  it('rejects documents whose structure alone exceeds the size limit', () => {
    const rules = Array.from({ length: 100_000 }, () => ({ type: 'horizontalRule' }));

    expectRejected({ type: 'doc', content: rules }, /maximum size/);
  });

  it('does not echo note content in error messages', () => {
    const secret = 'TOP-SECRET-diary-entry';
    const errors = [
      expectRejected(doc({ type: secret })),
      expectRejected(doc(paragraph(text('x', [{ type: secret }])))),
      expectRejected(
        doc(paragraph(text(secret, [{ type: 'link', attrs: { href: `javascript:${secret}` } }]))),
      ),
      expectRejected(doc({ type: 'heading', attrs: { level: secret }, content: [text(secret)] })),
    ];

    for (const error of errors) {
      expect(error.message).not.toContain(secret);
    }
  });
});

describe('parseNoteDocument: text and marks', () => {
  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', { value: 'x' }],
    ['missing', undefined],
  ])('rejects text that is %s', (_label, value) => {
    const node = value === undefined ? { type: 'text' } : { type: 'text', text: value };

    expectRejected(doc(paragraph(node)), /string "text"/);
  });

  it('rejects empty text nodes', () => {
    expectRejected(doc(paragraph(text(''))), /cannot be empty/);
  });

  it('rejects text longer than maxTextLength', () => {
    expectRejected(doc(paragraph(text('a'.repeat(NOTE_LIMITS.maxTextLength + 1)))), /exceeds/);
  });

  it('rejects text with lone surrogates', () => {
    expectRejected(doc(paragraph(text('broken \ud83d pair'))), /malformed Unicode/);
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:x',
    'file:///C:/Windows',
    '/relative',
    '//evil.example',
  ])('rejects the unsafe link %j', (href) => {
    expectRejected(doc(paragraph(text('x', [{ type: 'link', attrs: { href } }]))), /link/i);
  });

  it('rejects links without a string href', () => {
    expectRejected(doc(paragraph(text('x', [{ type: 'link' }]))), /link/i);
    expectRejected(doc(paragraph(text('x', [{ type: 'link', attrs: { href: 5 } }]))), /link/i);
  });

  it('rejects marks on non-text nodes', () => {
    expectRejected(doc({ type: 'paragraph', marks: [{ type: 'bold' }] }), /Only text nodes/);
    expectRejected(doc({ type: 'paragraph', marks: [] }), /Only text nodes/);
    expectRejected(doc(paragraph({ type: 'hardBreak', marks: [] })), /Only text nodes/);
    expectRejected(doc({ type: 'paragraph', text: 'x' }), /Only text nodes/);
  });

  it('rejects unknown, malformed and duplicate marks', () => {
    expectRejected(doc(paragraph(text('x', [{ type: 'highlight' }]))), /unsupported type/);
    expectRejected(doc(paragraph(text('x', [{ type: 'bold', extra: 1 }]))), /unsupported property/);
    expectRejected(doc(paragraph(text('x', ['bold']))), /plain JSON object/);
    expectRejected(doc(paragraph({ type: 'text', text: 'x', marks: { type: 'bold' } })), /array/);
    expectRejected(
      doc(paragraph(text('x', [{ type: 'bold' }, { type: 'bold' }]))),
      /"bold" mark twice/,
    );
  });
});

describe('parseNoteDocument: structure', () => {
  it('requires a doc root and rejects nested docs', () => {
    expectRejected({ type: 'paragraph' }, /"doc" root/);
    expectRejected(doc(doc()), /found a "doc" node/);
  });

  it.each([
    ['listItem directly in doc', doc({ type: 'listItem', content: [] }), /"listItem" node/],
    ['text directly in doc', doc(text('x')), /"text" node/],
    ['an unknown node type', doc({ type: 'iframe' }), /unsupported node type/],
    ['a paragraph inside a paragraph', doc(paragraph(paragraph())), /inline node/],
    [
      'a paragraph directly in a bulletList',
      doc({ type: 'bulletList', content: [paragraph()] }),
      /"listItem" node/,
    ],
    [
      'a listItem in a taskList',
      doc({ type: 'taskList', content: [{ type: 'listItem' }] }),
      /"taskItem" node/,
    ],
    [
      'a tableCell directly in a table',
      doc({ type: 'table', content: [{ type: 'tableCell' }] }),
      /"tableRow" node/,
    ],
    [
      'text directly in a tableRow',
      doc({ type: 'table', content: [{ type: 'tableRow', content: [text('x')] }] }),
      /"tableCell" or "tableHeader"/,
    ],
    [
      'a hardBreak in a codeBlock',
      doc({ type: 'codeBlock', content: [{ type: 'hardBreak' }] }),
      /code block/,
    ],
    [
      'marked text in a codeBlock',
      doc({ type: 'codeBlock', content: [text('x', [{ type: 'bold' }])] }),
      /cannot carry marks/,
    ],
    ['content on a horizontalRule', doc({ type: 'horizontalRule', content: [] }), /content/],
    ['content on a text node', doc(paragraph({ type: 'text', text: 'x', content: [] })), /content/],
    [
      'content on blockMath',
      doc({ type: 'blockMath', attrs: { latex: 'x' }, content: [] }),
      /content/,
    ],
    ['non-array content', doc({ type: 'paragraph', content: 'x' }), /array/],
    ['a sparse content array', { type: 'doc', content: new Array(3) }, /plain JSON object/],
  ])('rejects %s', (_label, value, message) => {
    expectRejected(value, message);
  });
});

describe('parseNoteDocument: attributes', () => {
  const attachment = (attrs: Record<string, unknown>): Record<string, unknown> =>
    doc({
      type: 'attachment',
      attrs: { attachmentId: ATTACHMENT_ID, displayName: 'a.png', kind: 'image', ...attrs },
    });
  const tableWithCell = (attrs: Record<string, unknown>): Record<string, unknown> =>
    doc({ type: 'table', content: [{ type: 'tableRow', content: [cell(attrs)] }] });

  it.each([
    ['heading level 7', doc({ type: 'heading', attrs: { level: 7 } })],
    ['heading level 0', doc({ type: 'heading', attrs: { level: 0 } })],
    ['heading level 2.5', doc({ type: 'heading', attrs: { level: 2.5 } })],
    ['heading level "2"', doc({ type: 'heading', attrs: { level: '2' } })],
    ['heading without level', doc({ type: 'heading' })],
    ['orderedList start 0', doc({ type: 'orderedList', attrs: { start: 0 } })],
    ['orderedList start "1"', doc({ type: 'orderedList', attrs: { start: '1' } })],
    [
      'taskItem checked "yes"',
      doc({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: 'yes' } }] }),
    ],
    ['colspan 0', tableWithCell({ colspan: 0 })],
    ['colspan 101', tableWithCell({ colspan: 101 })],
    ['rowspan -1', tableWithCell({ rowspan: -1 })],
    ['colwidth 6000', tableWithCell({ colwidth: [6000] })],
    ['colwidth not an array', tableWithCell({ colwidth: 100 })],
    ['colwidth empty', tableWithCell({ colwidth: [] })],
    ['codeBlock language with spaces', doc({ type: 'codeBlock', attrs: { language: 'c ++' } })],
    ['codeBlock language markup', doc({ type: 'codeBlock', attrs: { language: '<script>' } })],
    ['codeBlock language number', doc({ type: 'codeBlock', attrs: { language: 1 } })],
    ['blockMath without latex', doc({ type: 'blockMath' })],
    [
      'inlineMath latex too long',
      doc(
        paragraph({
          type: 'inlineMath',
          attrs: { latex: 'x'.repeat(NOTE_LIMITS.maxLatexLength + 1) },
        }),
      ),
    ],
    ['attachment uppercase UUID', attachment({ attachmentId: ATTACHMENT_ID.toUpperCase() })],
    ['attachment non-UUID id', attachment({ attachmentId: '../../etc/passwd' })],
    ['attachment empty displayName', attachment({ displayName: '' })],
    ['attachment long displayName', attachment({ displayName: 'a'.repeat(256) })],
    ['attachment displayName with newline', attachment({ displayName: 'a\nb' })],
    ['attachment kind video', attachment({ kind: 'video' })],
    ['attachment without kind', attachment({ kind: undefined })],
  ])('rejects %s', (_label, value) => {
    expectRejected(value);
  });

  it.each([
    ['heading level 6', doc({ type: 'heading', attrs: { level: 6 } })],
    ['null codeBlock language', doc({ type: 'codeBlock', attrs: { language: null } })],
    [
      'latex at the length limit',
      doc({ type: 'blockMath', attrs: { latex: 'x'.repeat(NOTE_LIMITS.maxLatexLength) } }),
    ],
    ['maximum spans and width', tableWithCell({ colspan: 100, rowspan: 100, colwidth: [5000] })],
    ['a 255-character display name', attachment({ displayName: 'א'.repeat(255) })],
  ])('accepts %s', (_label, value) => {
    expect(() => parseNoteDocument(value)).not.toThrow();
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['א', 2],
    ['€', 3],
    ['😀', 4],
    ['a😀b', 6],
    ['👩\u200d💻', 11],
    ['\ud83d', 3],
    ['\ude00\ud83d', 6],
  ])('counts %j as %i bytes', (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
  });
});

describe('parseNoteDocument: wikilinks (schema version 2)', () => {
  const TARGET = '3f2c9a4e-1b7d-4c2e-9f00-0123456789ab';
  const withInline = (inline: unknown) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See ' }, inline] }],
  });

  it('accepts a wikilink with a canonical target ID and a label', () => {
    const link = { type: 'wikilink', attrs: { targetNodeId: TARGET, label: 'Entropy' } };

    expect(parseNoteDocument(withInline(link))).toEqual(withInline(link));
  });

  it('drops unknown attributes such as a cached title', () => {
    const parsed = parseNoteDocument(
      withInline({
        type: 'wikilink',
        attrs: { targetNodeId: TARGET, label: 'Entropy', cachedTitle: 'Old' },
      }),
    );

    expect(JSON.stringify(parsed)).not.toContain('cachedTitle');
  });

  it.each([
    ['missing target', { label: 'x' }],
    ['non-UUID target', { targetNodeId: 'Entropy', label: 'x' }],
    ['uppercase target', { targetNodeId: TARGET.toUpperCase(), label: 'x' }],
    ['empty label', { targetNodeId: TARGET, label: '  ' }],
    ['label with a line break', { targetNodeId: TARGET, label: 'a\nb' }],
    ['overlong label', { targetNodeId: TARGET, label: 'x'.repeat(301) }],
  ])('rejects %s', (_label, attrs) => {
    expect(() => parseNoteDocument(withInline({ type: 'wikilink', attrs }))).toThrow(DomainError);
  });

  it('rejects a wikilink used as a block', () => {
    expect(() =>
      parseNoteDocument({
        type: 'doc',
        content: [{ type: 'wikilink', attrs: { targetNodeId: TARGET, label: 'x' } }],
      }),
    ).toThrow(DomainError);
  });
});
