/**
 * Note references derived from wikilinks (PRD §4.3, §5.4).
 *
 * References are derived data: the note JSON is the source of truth, and the reference rows are
 * rebuilt from it on every successful save, in the same transaction (PRD §14 "Editor/reference
 * divergence"). Each occurrence becomes one reference with a short excerpt of the surrounding
 * text, which the target's backlinks list shows.
 */

import type { NoteDocument, NoteInlineNode, NoteNode } from './note-document';

export interface ExtractedReference {
  /** Position of the occurrence within the note, starting at 0. */
  readonly ordinal: number;
  readonly targetNodeId: string;
  readonly label: string;
  /** Plain text around the link, at most about `EXCERPT_LENGTH` characters, with ellipses. */
  readonly excerpt: string;
}

/** Approximate excerpt length shown under a backlink. */
export const EXCERPT_LENGTH = 160;

export function extractNoteReferences(document: NoteDocument): ExtractedReference[] {
  const references: ExtractedReference[] = [];
  for (const block of document.content) {
    collectFromBlock(block, references);
  }
  return references;
}

/** Walks blocks; every node with inline content is treated as one text unit for excerpts. */
function collectFromBlock(node: NoteNode, references: ExtractedReference[]): void {
  const children = 'content' in node ? (node.content ?? []) : [];
  if (children.length > 0 && children.every(isInline)) {
    collectFromTextBlock(children as readonly NoteInlineNode[], references);
    return;
  }
  for (const child of children) {
    collectFromBlock(child, references);
  }
}

function collectFromTextBlock(
  inlines: readonly NoteInlineNode[],
  references: ExtractedReference[],
): void {
  let text = '';
  const links: { start: number; end: number; targetNodeId: string; label: string }[] = [];
  for (const inline of inlines) {
    switch (inline.type) {
      case 'text':
        text += inline.text;
        break;
      case 'hardBreak':
        text += ' ';
        break;
      case 'inlineMath':
        text += inline.attrs.latex;
        break;
      case 'wikilink':
        links.push({
          start: text.length,
          end: text.length + inline.attrs.label.length,
          targetNodeId: inline.attrs.targetNodeId,
          label: inline.attrs.label,
        });
        text += inline.attrs.label;
        break;
    }
  }
  for (const link of links) {
    references.push({
      ordinal: references.length,
      targetNodeId: link.targetNodeId,
      label: link.label,
      excerpt: excerptAround(text, link.start, link.end),
    });
  }
}

/** A window of `text` centred on [start, end), trimmed to whole words where possible. */
export function excerptAround(text: string, start: number, end: number): string {
  const normalized = text.replace(/\s+/gu, ' ');
  if (normalized.length <= EXCERPT_LENGTH) {
    return normalized.trim();
  }
  const context = Math.max(0, Math.floor((EXCERPT_LENGTH - (end - start)) / 2));
  let from = Math.max(0, start - context);
  let to = Math.min(normalized.length, end + context);
  // Move to word boundaries so the excerpt does not start or end mid-word.
  if (from > 0) {
    const space = normalized.indexOf(' ', from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < normalized.length) {
    const space = normalized.lastIndexOf(' ', to);
    if (space > end) to = space;
  }
  return `${from > 0 ? '…' : ''}${normalized.slice(from, to).trim()}${to < normalized.length ? '…' : ''}`;
}

function isInline(node: NoteNode): boolean {
  return (
    node.type === 'text' ||
    node.type === 'hardBreak' ||
    node.type === 'inlineMath' ||
    node.type === 'wikilink'
  );
}
