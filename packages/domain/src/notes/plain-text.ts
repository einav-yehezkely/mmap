/**
 * Plain-text projection of a note (PRD §5.3: "Maintain a derived plain-text representation for
 * search").
 *
 * The result feeds the full-text index and backlink excerpts, so it keeps every searchable word
 * and a readable line structure, but no formatting:
 *
 * - Block nodes (paragraphs, headings, list items, quotes, code blocks, math, attachments) each
 *   start on their own line; `hardBreak` is a line break too.
 * - Table cells are separated by tabs and rows by newlines. Line breaks inside a cell become
 *   spaces so each table row stays on one line.
 * - Math contributes its LaTeX source and attachments their display name, so both are findable.
 * - Runs of blank lines collapse to a single blank line and the result is trimmed.
 *
 * The input is a validated `NoteDocument`, whose depth is bounded by `NOTE_LIMITS.maxDepth`, so
 * the recursion here cannot overflow the stack.
 */

import type {
  NoteBlockNode,
  NoteDocument,
  NoteInlineNode,
  NoteTableCellNode,
  NoteTableRowNode,
} from './note-document';

/** Derives the searchable plain text of a validated note. */
export function extractPlainText(document: NoteDocument): string {
  return blocksText(document.content)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blocksText(nodes: readonly NoteBlockNode[] | undefined): string {
  return (nodes ?? []).map(blockText).join('\n');
}

function blockText(node: NoteBlockNode): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(node.content);
    case 'blockquote':
      return blocksText(node.content);
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      // List items (and task items) each contribute their own line(s); no bullet markers, so
      // the index only contains words the user wrote.
      return (node.content ?? []).map((item) => blocksText(item.content)).join('\n');
    case 'codeBlock':
      return (node.content ?? []).map((text) => text.text).join('');
    case 'horizontalRule':
      return '';
    case 'table':
      return (node.content ?? []).map(rowText).join('\n');
    case 'blockMath':
      return node.attrs.latex;
    case 'attachment':
      return node.attrs.displayName;
  }
}

function inlineText(nodes: readonly NoteInlineNode[] | undefined): string {
  return (nodes ?? []).map(inlineNodeText).join('');
}

function inlineNodeText(node: NoteInlineNode): string {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'hardBreak':
      return '\n';
    case 'inlineMath':
      return node.attrs.latex;
    case 'wikilink':
      // The label is what the reader sees, so it is what search should find.
      return node.attrs.label;
  }
}

function rowText(row: NoteTableRowNode): string {
  return (row.content ?? []).map(cellText).join('\t');
}

/** A cell's blocks on one line, so tabs and newlines keep their table meaning. */
function cellText(cell: NoteTableCellNode): string {
  return blocksText(cell.content)
    .replace(/[\t\n]+/g, ' ')
    .trim();
}
