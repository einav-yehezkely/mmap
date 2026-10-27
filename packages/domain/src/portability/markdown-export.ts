/**
 * Readable Markdown export (PRD §5.11: "one file per node, stable-ID metadata, wikilinks, math
 * source, and attachment references").
 *
 * Each node becomes `nodes/<Title> (<first 8 ID characters>).md`:
 *
 *   ---
 *   id: "<stable node ID>"
 *   title: "…"
 *   tags: ["…"]
 *   created: "…" / updated: "…"
 *   ---
 *   # Title
 *   <note as Markdown>
 *   ## Relationships
 *   - explains → [[Heat (3f2c1a9b)|Heat]]
 *
 * Wikilinks use the `[[file name|label]]` form understood by common Markdown tools; math keeps its
 * LaTeX source between `$…$` and `$$…$$`; attachments link to `attachments/`. Front matter values
 * are JSON strings, which are valid YAML, so titles can never break the header.
 *
 * Markdown is a reading format: it does not keep maps, timeline history or formatting details
 * such as table cell spans. The ZIP export is the lossless restore format, and importing
 * arbitrary Markdown is outside version 1 (PRD §5.11). The README in the export says so.
 */

import type {
  NoteBlockNode,
  NoteDocument,
  NoteInlineNode,
  NoteMark,
  NoteTableNode,
  NoteTextNode,
} from '../notes/note-document';

export interface MarkdownLinks {
  /** File name (with `.md`) of an exported node, or null when the node is not in the export. */
  nodeFile(nodeId: string): string | null;
  /** Path of an exported attachment relative to a note file, or null when it is missing. */
  attachmentPath(attachmentId: string): string | null;
}

export interface MarkdownNode {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly note: NoteDocument;
  readonly relationships: readonly MarkdownRelationship[];
}

export interface MarkdownRelationship {
  readonly typeLabel: string;
  /** `outgoing`: this node → other; `incoming`: other → this node; `undirected`: no direction. */
  readonly direction: 'outgoing' | 'incoming' | 'undirected';
  readonly otherNodeId: string;
  readonly otherTitle: string;
}

export const MARKDOWN_README = `# mmap Markdown export

This folder is a readable copy of an mmap workspace: one Markdown file per node in \`nodes/\`,
and attached files in \`attachments/\`.

- Each note starts with front matter holding the node's stable ID, title, tags and dates.
- Links between notes are written as \`[[file name|label]]\`.
- Math is kept as LaTeX source: \`$…$\` inline and \`$$…$$\` for display math.
- Semantic relationships are listed at the end of each note.

Mind maps, timeline history and some formatting are not part of this export. To move or
restore a workspace completely, use the ZIP export ("Export workspace (ZIP)") and import it in
mmap. mmap does not import Markdown files.
`;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

/**
 * A file name for a title: characters that are invalid in file names or break wikilinks
 * (`[ ] # ^ |`) are replaced, the length is bounded, and reserved Windows names are avoided.
 * The ID suffix keeps names unique even when titles repeat.
 */
export function markdownFileName(title: string, id: string, extension = '.md'): string {
  return `${safeFileStem(title, 80)} (${id.slice(0, 8)})${extension}`;
}

/** A safe file name stem (no extension) for user text. */
export function safeFileStem(text: string, maxLength: number): string {
  let stem = text
    // eslint-disable-next-line no-control-regex -- removing control characters is the purpose.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*#[\]^]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  stem = [...stem]
    .slice(0, maxLength)
    .join('')
    .replace(/[. ]+$/u, '');
  if (stem === '') return 'Untitled';
  return WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem;
}

export function nodeToMarkdown(node: MarkdownNode, links: MarkdownLinks): string {
  const frontMatter = [
    '---',
    `id: ${JSON.stringify(node.id)}`,
    `title: ${JSON.stringify(node.title)}`,
    ...(node.summary === null ? [] : [`summary: ${JSON.stringify(node.summary)}`]),
    `tags: ${JSON.stringify(node.tags)}`,
    `created: ${JSON.stringify(node.createdAt)}`,
    `updated: ${JSON.stringify(node.updatedAt)}`,
    '---',
  ];
  const parts = [frontMatter.join('\n'), `# ${escapeText(node.title)}`];
  if (node.summary !== null) parts.push(`*${escapeText(node.summary)}*`);
  const body = noteToMarkdown(node.note, links);
  if (body !== '') parts.push(body);
  if (node.relationships.length > 0) {
    const lines = node.relationships.map((relationship) => {
      const other = wikilink(relationship.otherNodeId, relationship.otherTitle, links);
      const label = escapeText(relationship.typeLabel);
      switch (relationship.direction) {
        case 'outgoing':
          return `- ${label} → ${other}`;
        case 'incoming':
          return `- ${other} ${label} → this note`;
        case 'undirected':
          return `- ${label} — ${other}`;
      }
    });
    parts.push(['## Relationships', '', ...lines].join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/** Converts a validated note document to Markdown (blocks separated by blank lines). */
export function noteToMarkdown(document: NoteDocument, links: MarkdownLinks): string {
  return blocksToMarkdown(document.content, links);
}

function blocksToMarkdown(blocks: readonly NoteBlockNode[], links: MarkdownLinks): string {
  return blocks
    .map((block) => blockToMarkdown(block, links))
    .filter((text) => text !== '')
    .join('\n\n');
}

function blockToMarkdown(block: NoteBlockNode, links: MarkdownLinks): string {
  switch (block.type) {
    case 'paragraph':
      return escapeLineStart(inlinesToMarkdown(block.content ?? [], links));
    case 'heading':
      return `${'#'.repeat(block.attrs.level)} ${inlinesToMarkdown(block.content ?? [], links)}`;
    case 'blockquote':
      return prefixLines(blocksToMarkdown(block.content ?? [], links), '> ', '>');
    case 'bulletList':
      return (block.content ?? [])
        .map((item) => listItem('- ', blocksToMarkdown(item.content ?? [], links)))
        .join('\n');
    case 'orderedList':
      return (block.content ?? [])
        .map((item, index) =>
          listItem(`${block.attrs.start + index}. `, blocksToMarkdown(item.content ?? [], links)),
        )
        .join('\n');
    case 'taskList':
      return (block.content ?? [])
        .map((item) =>
          listItem(
            item.attrs.checked ? '- [x] ' : '- [ ] ',
            blocksToMarkdown(item.content ?? [], links),
          ),
        )
        .join('\n');
    case 'codeBlock': {
      const code = (block.content ?? []).map((text) => text.text).join('');
      const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
      return `${fence}${block.attrs.language ?? ''}\n${code}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'table':
      return tableToMarkdown(block, links);
    case 'blockMath':
      return `$$\n${block.attrs.latex}\n$$`;
    case 'attachment': {
      const path = links.attachmentPath(block.attrs.attachmentId);
      const name = escapeText(block.attrs.displayName);
      if (path === null) return `*Missing attachment: ${name}*`;
      return `${block.attrs.kind === 'image' ? '!' : ''}[${name}](<${path}>)`;
    }
  }
}

/** A list item: the marker on the first line, continuation lines indented under the text. */
function listItem(marker: string, content: string): string {
  const indent = ' '.repeat(marker.length);
  const lines = (content === '' ? '' : content).split('\n');
  return lines
    .map((line, index) =>
      index === 0 ? `${marker}${line}` : line === '' ? '' : `${indent}${line}`,
    )
    .join('\n');
}

function prefixLines(text: string, prefix: string, emptyPrefix: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? emptyPrefix : `${prefix}${line}`))
    .join('\n');
}

/**
 * GitHub-style table. The first row is the header. Markdown tables cannot span cells, so a
 * spanning cell is followed by empty cells; block content inside a cell is joined with `<br>`.
 */
function tableToMarkdown(table: NoteTableNode, links: MarkdownLinks): string {
  const rows = (table.content ?? []).map((row) =>
    (row.content ?? []).flatMap((cell) => {
      const text = (cell.content ?? [])
        .map((block) => blockToMarkdown(block, links).replace(/\n+/gu, ' '))
        .filter((part) => part !== '')
        .join('<br>')
        .replace(/\|/gu, '\\|');
      return [text, ...Array.from({ length: Math.max(0, cell.attrs.colspan - 1) }, () => '')];
    }),
  );
  if (rows.length === 0) return '';
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  return [
    line(rows[0]!),
    line(Array.from({ length: width }, () => '---')),
    ...rows.slice(1).map(line),
  ].join('\n');
}

function inlinesToMarkdown(inlines: readonly NoteInlineNode[], links: MarkdownLinks): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case 'text':
          return textToMarkdown(inline);
        case 'hardBreak':
          return '\\\n';
        case 'inlineMath':
          return `$${inline.attrs.latex}$`;
        case 'wikilink':
          return wikilink(inline.attrs.targetNodeId, inline.attrs.label, links);
      }
    })
    .join('');
}

/** `[[file|label]]` for exported targets; a link to a node that is gone keeps only its label. */
function wikilink(targetNodeId: string, label: string, links: MarkdownLinks): string {
  const file = links.nodeFile(targetNodeId);
  const safeLabel = label.replace(/[[\]|\n]/gu, ' ');
  if (file === null) return escapeText(label);
  return `[[${file.replace(/\.md$/u, '')}|${safeLabel}]]`;
}

function textToMarkdown(node: NoteTextNode): string {
  const marks = node.marks ?? [];
  const has = (type: NoteMark['type']) => marks.some((mark) => mark.type === type);
  let text = has('code') ? codeSpan(node.text) : escapeText(node.text);
  if (has('bold')) text = wrap(text, '**');
  if (has('italic')) text = wrap(text, '*');
  if (has('strike')) text = wrap(text, '~~');
  if (has('underline')) text = wrap(text, '<u>', '</u>');
  const link = marks.find((mark) => mark.type === 'link');
  if (link !== undefined && link.type === 'link')
    text = `[${text}](<${link.attrs.href.replace(/[<>]/gu, encodeURIComponent)}>)`;
  return text;
}

/** Wraps text in markers, keeping surrounding spaces outside (CommonMark needs that). */
function wrap(text: string, open: string, close = open): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text)!;
  if (match[2] === '') return text;
  return `${match[1]}${open}${match[2]}${close}${match[3]}`;
}

function codeSpan(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/** Escapes characters that Markdown or the math syntax would interpret. */
export function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>|~$]/gu, '\\$&');
}

/** Escapes a paragraph start that Markdown would read as a heading, list or quote. */
function escapeLineStart(text: string): string {
  return text.replace(
    /^(\s*)(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/u,
    (_match, space: string, start: string) => `${space}\\${start}`,
  );
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    current = char === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
