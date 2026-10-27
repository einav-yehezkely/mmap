/**
 * Rich-note documents (PRD §5.3, §8).
 *
 * Notes are edited with Tiptap in the renderer and saved as Tiptap (ProseMirror) JSON. That JSON
 * is the source of truth, so it is validated against an explicit, versioned allow-list before it
 * is stored. The same validator runs on notes from imported archives, so it treats every input as
 * hostile:
 *
 * - Only the node types, marks and attributes listed below are accepted; anything else is
 *   rejected rather than silently dropped, so data is never lost without the user noticing.
 *   The one exception is unknown *attributes*: Tiptap emits defaults we do not use (for example
 *   `textAlign`, or `target`/`rel` on links), so unknown attribute keys are dropped.
 * - Only plain data objects are accepted, keys like `__proto__` are rejected anywhere they are
 *   inspected, and the result is built from fresh objects, so prototype tricks and shared
 *   references from the input cannot survive into the stored document.
 * - Depth, node count and size are bounded so a malicious document cannot exhaust the stack or
 *   memory of the main process.
 * - Error messages describe the problem in terms of the schema only; they never echo note text,
 *   unknown type names or URLs (PRD §8: keep content out of logs).
 */

import { DomainError } from '../errors';
import { isCanonicalUuid } from '../ids';
import { normalizeLinkHref } from './link-policy';

/**
 * Version of the note schema implemented by this module. Stored alongside each note so a future
 * schema change can migrate old documents explicitly instead of guessing their shape.
 *
 * - 1: initial schema (Phase 1).
 * - 2: adds the `wikilink` inline node (PRD §5.4). Every version-1 document is a valid
 *   version-2 document, so no conversion is needed when reading old notes.
 */
export const NOTE_SCHEMA_VERSION = 2;

/** Upper bound for a wikilink's visible label (what the user typed or picked). */
export const MAX_WIKILINK_LABEL_LENGTH = 300;

/**
 * Resource limits for a single note document.
 *
 * - `maxSerializedBytes`: UTF-8 size of the normalized JSON. 2 MB is far beyond any hand-written
 *   note (attachments are stored separately), yet small enough to keep saves, FTS indexing and
 *   IPC transfers fast.
 * - `maxDepth`: nesting depth, counting the `doc` root as 1. Real notes rarely exceed ~10 levels
 *   (lists in quotes in table cells); 40 leaves headroom while keeping recursive processing
 *   (here, in plain-text extraction and in the renderer) far away from stack limits.
 * - `maxNodes`: total node count. Bounds validation time independently of the byte limit.
 * - `maxTextLength`: UTF-16 length of a single text node. Rejects a giant string cheaply before
 *   its byte size is even computed.
 * - `maxLatexLength`: length of one math formula. KaTeX rendering cost grows with input size,
 *   and real formulas are short.
 */
export const NOTE_LIMITS = {
  maxSerializedBytes: 2_000_000,
  maxDepth: 40,
  maxNodes: 200_000,
  maxTextLength: 1_000_000,
  maxLatexLength: 10_000,
} as const;

/** Longest accepted attachment display name, in UTF-16 code units. */
const MAX_DISPLAY_NAME_LENGTH = 255;

/** Code block language identifiers such as `ts`, `c++`, `c#`, `objective-c` or `vb.net`. */
const CODE_LANGUAGE_PATTERN = /^[a-z0-9+#.-]{1,40}$/i;

const MAX_TABLE_SPAN = 100;
const MAX_COLUMN_WIDTH = 5000;

// ---------------------------------------------------------------------------------------------
// Document types (schema v1)
// ---------------------------------------------------------------------------------------------

export type NoteFormattingMarkType = 'bold' | 'italic' | 'strike' | 'underline' | 'code';

export interface NoteFormattingMark {
  type: NoteFormattingMarkType;
}

/** Only `href` is kept; the renderer adds `rel`/`target` itself so stored notes cannot change them. */
export interface NoteLinkMark {
  type: 'link';
  attrs: { href: string };
}

export type NoteMark = NoteFormattingMark | NoteLinkMark;

export interface NoteTextNode {
  type: 'text';
  /** Never empty (ProseMirror forbids empty text nodes). */
  text: string;
  marks?: NoteMark[];
}

export interface NoteHardBreakNode {
  type: 'hardBreak';
}

export interface NoteInlineMathNode {
  type: 'inlineMath';
  attrs: { latex: string };
}

/**
 * A note reference (PRD §4.3, §5.4). Identity is `targetNodeId`, never the label: renaming the
 * target keeps the link working, and the label stays as the author wrote it. A reference is not a
 * semantic relationship and never creates one.
 */
export interface NoteWikilinkNode {
  type: 'wikilink';
  attrs: { targetNodeId: string; label: string };
}

export type NoteInlineNode =
  NoteTextNode | NoteHardBreakNode | NoteInlineMathNode | NoteWikilinkNode;

export interface NoteParagraphNode {
  type: 'paragraph';
  content?: NoteInlineNode[];
}

export type NoteHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface NoteHeadingNode {
  type: 'heading';
  attrs: { level: NoteHeadingLevel };
  content?: NoteInlineNode[];
}

export interface NoteBlockquoteNode {
  type: 'blockquote';
  content?: NoteBlockNode[];
}

export interface NoteListItemNode {
  type: 'listItem';
  content?: NoteBlockNode[];
}

export interface NoteBulletListNode {
  type: 'bulletList';
  content?: NoteListItemNode[];
}

export interface NoteOrderedListNode {
  type: 'orderedList';
  attrs: { start: number };
  content?: NoteListItemNode[];
}

export interface NoteTaskItemNode {
  type: 'taskItem';
  attrs: { checked: boolean };
  content?: NoteBlockNode[];
}

export interface NoteTaskListNode {
  type: 'taskList';
  content?: NoteTaskItemNode[];
}

export interface NoteCodeBlockNode {
  type: 'codeBlock';
  attrs: { language: string | null };
  /** Plain text only: marks inside code blocks are rejected. */
  content?: NoteTextNode[];
}

export interface NoteHorizontalRuleNode {
  type: 'horizontalRule';
}

export interface NoteTableCellAttrs {
  colspan: number;
  rowspan: number;
  /** Column widths in pixels as stored by prosemirror-tables; `0` means "not set". */
  colwidth: number[] | null;
}

export interface NoteTableCellNode {
  type: 'tableCell' | 'tableHeader';
  attrs: NoteTableCellAttrs;
  content?: NoteBlockNode[];
}

export interface NoteTableRowNode {
  type: 'tableRow';
  content?: NoteTableCellNode[];
}

export interface NoteTableNode {
  type: 'table';
  content?: NoteTableRowNode[];
}

export interface NoteBlockMathNode {
  type: 'blockMath';
  attrs: { latex: string };
}

export type NoteAttachmentKind = 'image' | 'file';

/** A reference to a stored attachment; the bytes live in the attachment store, never in the note. */
export interface NoteAttachmentNode {
  type: 'attachment';
  attrs: { attachmentId: string; displayName: string; kind: NoteAttachmentKind };
}

export type NoteBlockNode =
  | NoteParagraphNode
  | NoteHeadingNode
  | NoteBlockquoteNode
  | NoteBulletListNode
  | NoteOrderedListNode
  | NoteTaskListNode
  | NoteCodeBlockNode
  | NoteHorizontalRuleNode
  | NoteTableNode
  | NoteBlockMathNode
  | NoteAttachmentNode;

export type NoteNode =
  | NoteBlockNode
  | NoteInlineNode
  | NoteListItemNode
  | NoteTaskItemNode
  | NoteTableRowNode
  | NoteTableCellNode;

/** Root of a note. An empty `content` array is valid; editors show it as one empty paragraph. */
export interface NoteDocument {
  type: 'doc';
  content: NoteBlockNode[];
}

/** The document a newly created note starts with. Returns a fresh object on every call. */
export function emptyNoteDocument(): NoteDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/**
 * Validates untrusted note JSON and returns a normalized copy.
 *
 * The result never shares objects with `value`: mutating the input afterwards cannot affect it.
 * Known attributes with defaults (`orderedList.start`, `taskItem.checked`, `codeBlock.language`,
 * table cell spans/widths) are always present in the result; unknown attributes are dropped.
 *
 * @throws DomainError `VALIDATION_FAILED` when the document violates schema v1 or a limit.
 */
export function parseNoteDocument(value: unknown): NoteDocument {
  if (!isPlainObject(value)) {
    throw invalid('A note document must be a plain JSON object.');
  }
  const state: ParseState = { nodeCount: 0, stringBytes: 0 };
  const root = readNode(value, 1, state);
  if (root.type !== 'doc') {
    throw invalid('A note document must have a "doc" root node.');
  }
  const document: NoteDocument = {
    type: 'doc',
    content: parseChildren(root, 1, state, parseBlock) ?? [],
  };

  // The running string budget is a lower bound that stops huge inputs early; this is the exact
  // check on what will actually be stored. The document is depth-bounded, so stringify is safe.
  if (utf8ByteLength(JSON.stringify(document)) > NOTE_LIMITS.maxSerializedBytes) {
    throw invalid('The note exceeds the maximum size.');
  }
  return document;
}

/**
 * UTF-8 byte length of a JavaScript string, computed without `TextEncoder` or `Buffer` (neither
 * is available to runtime-agnostic domain code). A surrogate pair is one code point of 4 bytes;
 * a lone surrogate counts as 3 bytes, the size of the U+FFFD replacement an encoder would write.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(unit) && isLowSurrogate(value.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  // `charCodeAt` past the end returns NaN, which fails both comparisons.
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Mutable counters shared across one parse, enforcing the document-wide limits. */
interface ParseState {
  nodeCount: number;
  /** UTF-8 bytes of all strings copied so far; a lower bound of the serialized size. */
  stringBytes: number;
}

/** A node object whose top-level shape has been checked, with values read exactly once. */
interface RawNode {
  readonly type: string;
  /** Own attributes; empty when the node has none. Values are still unvalidated. */
  readonly attrs: ReadonlyMap<string, unknown>;
  readonly content: readonly unknown[] | undefined;
  readonly marks: readonly unknown[] | undefined;
  readonly hasText: boolean;
  readonly text: unknown;
}

type ChildParser<T> = (value: unknown, depth: number, state: ParseState) => T;

const NODE_KEYS: ReadonlySet<string> = new Set(['type', 'attrs', 'content', 'marks', 'text']);
const MARK_KEYS: ReadonlySet<string> = new Set(['type', 'attrs']);

/** Keys that could alter prototypes if a consumer ever merged note data into an object. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Every node type in schema v1. Only these names may appear in error messages. */
const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'doc',
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'horizontalRule',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'blockMath',
  'attachment',
  'text',
  'hardBreak',
  'inlineMath',
  'wikilink',
]);

const EMPTY_ATTRS: ReadonlyMap<string, unknown> = new Map();

function invalid(message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', message);
}

/**
 * Accepts only objects whose prototype is `Object.prototype` or `null`. Class instances, arrays,
 * Maps, Dates and objects with a substituted prototype are rejected.
 */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies the own enumerable data properties of a plain object into a Map.
 *
 * Reading each property exactly once (and refusing accessors) means a getter cannot return one
 * value to the validator and another to whoever reads the object later.
 *
 * @param allowedKeys Keys permitted on this object, or `null` to accept any non-forbidden key.
 */
function readRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string> | null,
  what: string,
): Map<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalid(`${what} must be a plain JSON object.`);
  }
  const record = new Map<string, unknown>();
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw invalid(`${what} contains a forbidden key.`);
    }
    if (allowedKeys !== null && !allowedKeys.has(key)) {
      throw invalid(`${what} contains an unsupported property.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalid(`${what} must contain only data properties.`);
    }
    record.set(key, descriptor.value);
  }
  return record;
}

function readOptionalArray(value: unknown, what: string): readonly unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalid(`${what} must be an array.`);
  }
  return value as readonly unknown[];
}

/**
 * Checks the shape shared by all nodes and enforces the depth and node-count limits.
 *
 * Depth is checked before anything else is read, so cyclic or absurdly deep input fails at
 * `maxDepth + 1` long before the call stack is at risk.
 */
function readNode(value: unknown, depth: number, state: ParseState): RawNode {
  if (depth > NOTE_LIMITS.maxDepth) {
    throw invalid(`The note is nested more than ${NOTE_LIMITS.maxDepth} levels deep.`);
  }
  state.nodeCount += 1;
  if (state.nodeCount > NOTE_LIMITS.maxNodes) {
    throw invalid(`The note contains more than ${NOTE_LIMITS.maxNodes} nodes.`);
  }

  const record = readRecord(value, NODE_KEYS, 'A note node');
  const type = record.get('type');
  if (typeof type !== 'string') {
    throw invalid('A note node must have a string type.');
  }
  const hasText = record.has('text');
  if (type !== 'text' && (hasText || record.has('marks'))) {
    throw invalid('Only text nodes may carry text or marks.');
  }
  const rawAttrs = record.get('attrs');
  return {
    type,
    attrs: rawAttrs === undefined ? EMPTY_ATTRS : readRecord(rawAttrs, null, 'Node attributes'),
    content: readOptionalArray(record.get('content'), 'Node content'),
    marks: readOptionalArray(record.get('marks'), 'Node marks'),
    hasText,
    text: record.get('text'),
  };
}

/** Parses `raw.content` with `parseChild`; returns `undefined` when the node had no content. */
function parseChildren<T>(
  raw: RawNode,
  depth: number,
  state: ParseState,
  parseChild: ChildParser<T>,
): T[] | undefined {
  if (raw.content === undefined) {
    return undefined;
  }
  const children: T[] = [];
  // Index loop rather than `for...of`: holes in sparse arrays surface as `undefined` and fail.
  for (let index = 0; index < raw.content.length; index += 1) {
    children.push(parseChild(raw.content[index], depth + 1, state));
  }
  return children;
}

/** Sets `content` only when the input had it, so `{ type: 'paragraph' }` stays content-free. */
function withContent<N extends { content?: unknown }>(node: N, content: N['content']): N {
  if (content !== undefined) {
    node.content = content;
  }
  return node;
}

/** Leaf nodes (text, hard breaks, rules, math, attachments) cannot have a `content` array. */
function expectLeaf(raw: RawNode): void {
  if (raw.content !== undefined) {
    throw invalid(`A "${raw.type}" node cannot have content.`);
  }
}

/** Names a node type in a message only if it is a known schema type, never arbitrary input. */
function misplaced(type: string, expected: string): DomainError {
  const found = KNOWN_NODE_TYPES.has(type) ? `a "${type}" node` : 'an unsupported node type';
  return invalid(`Expected ${expected} but found ${found}.`);
}

/**
 * Validates and accounts for a string copied into the output: it must be well-formed Unicode
 * (no lone surrogates, which cannot be stored as UTF-8) and fit the running size budget.
 */
function chargeString(value: string, state: ParseState, what: string): string {
  if (!value.isWellFormed()) {
    throw invalid(`${what} contains malformed Unicode.`);
  }
  state.stringBytes += utf8ByteLength(value);
  if (state.stringBytes > NOTE_LIMITS.maxSerializedBytes) {
    throw invalid('The note exceeds the maximum size.');
  }
  return value;
}

// --- Block nodes -----------------------------------------------------------------------------

function parseBlock(value: unknown, depth: number, state: ParseState): NoteBlockNode {
  const raw = readNode(value, depth, state);
  switch (raw.type) {
    case 'paragraph':
      return withContent<NoteParagraphNode>(
        { type: 'paragraph' },
        parseChildren(raw, depth, state, parseInline),
      );
    case 'heading':
      return withContent<NoteHeadingNode>(
        { type: 'heading', attrs: { level: readHeadingLevel(raw.attrs) } },
        parseChildren(raw, depth, state, parseInline),
      );
    case 'blockquote':
      return withContent<NoteBlockquoteNode>(
        { type: 'blockquote' },
        parseChildren(raw, depth, state, parseBlock),
      );
    case 'bulletList':
      return withContent<NoteBulletListNode>(
        { type: 'bulletList' },
        parseChildren(raw, depth, state, parseListItem),
      );
    case 'orderedList':
      return withContent<NoteOrderedListNode>(
        { type: 'orderedList', attrs: { start: readOrderedListStart(raw.attrs) } },
        parseChildren(raw, depth, state, parseListItem),
      );
    case 'taskList':
      return withContent<NoteTaskListNode>(
        { type: 'taskList' },
        parseChildren(raw, depth, state, parseTaskItem),
      );
    case 'codeBlock':
      return withContent<NoteCodeBlockNode>(
        { type: 'codeBlock', attrs: { language: readCodeLanguage(raw.attrs, state) } },
        parseChildren(raw, depth, state, parseCodeText),
      );
    case 'horizontalRule':
      expectLeaf(raw);
      return { type: 'horizontalRule' };
    case 'table':
      return withContent<NoteTableNode>(
        { type: 'table' },
        parseChildren(raw, depth, state, parseTableRow),
      );
    case 'blockMath':
      expectLeaf(raw);
      return { type: 'blockMath', attrs: { latex: readLatex(raw, state) } };
    case 'attachment':
      expectLeaf(raw);
      return { type: 'attachment', attrs: readAttachmentAttrs(raw.attrs, state) };
    default:
      throw misplaced(raw.type, 'a block node');
  }
}

function parseListItem(value: unknown, depth: number, state: ParseState): NoteListItemNode {
  const raw = readNode(value, depth, state);
  if (raw.type !== 'listItem') {
    throw misplaced(raw.type, 'a "listItem" node');
  }
  return withContent<NoteListItemNode>(
    { type: 'listItem' },
    parseChildren(raw, depth, state, parseBlock),
  );
}

function parseTaskItem(value: unknown, depth: number, state: ParseState): NoteTaskItemNode {
  const raw = readNode(value, depth, state);
  if (raw.type !== 'taskItem') {
    throw misplaced(raw.type, 'a "taskItem" node');
  }
  return withContent<NoteTaskItemNode>(
    { type: 'taskItem', attrs: { checked: readTaskChecked(raw.attrs) } },
    parseChildren(raw, depth, state, parseBlock),
  );
}

function parseTableRow(value: unknown, depth: number, state: ParseState): NoteTableRowNode {
  const raw = readNode(value, depth, state);
  if (raw.type !== 'tableRow') {
    throw misplaced(raw.type, 'a "tableRow" node');
  }
  return withContent<NoteTableRowNode>(
    { type: 'tableRow' },
    parseChildren(raw, depth, state, parseTableCell),
  );
}

function parseTableCell(value: unknown, depth: number, state: ParseState): NoteTableCellNode {
  const raw = readNode(value, depth, state);
  if (raw.type !== 'tableCell' && raw.type !== 'tableHeader') {
    throw misplaced(raw.type, 'a "tableCell" or "tableHeader" node');
  }
  return withContent<NoteTableCellNode>(
    { type: raw.type, attrs: readTableCellAttrs(raw.attrs) },
    parseChildren(raw, depth, state, parseBlock),
  );
}

/** Code blocks hold raw text only: no hard breaks, math or formatting marks. */
function parseCodeText(value: unknown, depth: number, state: ParseState): NoteTextNode {
  const raw = readNode(value, depth, state);
  if (raw.type !== 'text') {
    throw misplaced(raw.type, 'a "text" node inside a code block');
  }
  const node = parseTextNode(raw, state);
  if (node.marks !== undefined) {
    throw invalid('Text inside a code block cannot carry marks.');
  }
  return node;
}

// --- Inline nodes and marks ------------------------------------------------------------------

function parseInline(value: unknown, depth: number, state: ParseState): NoteInlineNode {
  const raw = readNode(value, depth, state);
  switch (raw.type) {
    case 'text':
      return parseTextNode(raw, state);
    case 'hardBreak':
      expectLeaf(raw);
      return { type: 'hardBreak' };
    case 'inlineMath':
      expectLeaf(raw);
      return { type: 'inlineMath', attrs: { latex: readLatex(raw, state) } };
    case 'wikilink':
      expectLeaf(raw);
      return { type: 'wikilink', attrs: readWikilinkAttrs(raw.attrs, state) };
    default:
      throw misplaced(raw.type, 'an inline node');
  }
}

function parseTextNode(raw: RawNode, state: ParseState): NoteTextNode {
  expectLeaf(raw);
  const text = raw.text;
  if (typeof text !== 'string') {
    throw invalid('A text node must have a string "text" value.');
  }
  if (text.length === 0) {
    throw invalid('A text node cannot be empty.');
  }
  if (text.length > NOTE_LIMITS.maxTextLength) {
    throw invalid(`A text node exceeds ${NOTE_LIMITS.maxTextLength} characters.`);
  }
  const node: NoteTextNode = { type: 'text', text: chargeString(text, state, 'Text') };
  const marks = raw.marks === undefined ? [] : parseMarks(raw.marks, state);
  // An empty marks array means "no marks"; omit it like ProseMirror's own serializer does.
  if (marks.length > 0) {
    node.marks = marks;
  }
  return node;
}

function parseMarks(values: readonly unknown[], state: ParseState): NoteMark[] {
  const marks: NoteMark[] = [];
  const seen = new Set<string>();
  // The duplicate check also bounds this loop: at most one mark per type can be accepted.
  for (let index = 0; index < values.length; index += 1) {
    const mark = parseMark(values[index], state);
    if (seen.has(mark.type)) {
      throw invalid(`A text node cannot carry the "${mark.type}" mark twice.`);
    }
    seen.add(mark.type);
    marks.push(mark);
  }
  return marks;
}

function parseMark(value: unknown, state: ParseState): NoteMark {
  const record = readRecord(value, MARK_KEYS, 'A text mark');
  const type = record.get('type');
  const rawAttrs = record.get('attrs');
  const attrs =
    rawAttrs === undefined ? EMPTY_ATTRS : readRecord(rawAttrs, null, 'Mark attributes');
  switch (type) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'underline':
    case 'code':
      return { type };
    case 'link':
      return { type: 'link', attrs: { href: readLinkHref(attrs, state) } };
    default:
      throw invalid('A text mark has an unsupported type.');
  }
}

// --- Attribute readers -----------------------------------------------------------------------

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function readHeadingLevel(attrs: ReadonlyMap<string, unknown>): NoteHeadingLevel {
  const level = attrs.get('level');
  if (!isIntegerInRange(level, 1, 6)) {
    throw invalid('A "heading" node requires an integer level from 1 to 6.');
  }
  return level as NoteHeadingLevel;
}

function readOrderedListStart(attrs: ReadonlyMap<string, unknown>): number {
  const start = attrs.get('start');
  if (start === undefined) {
    return 1;
  }
  if (!isIntegerInRange(start, 1, Number.MAX_SAFE_INTEGER)) {
    throw invalid('An "orderedList" start must be a positive integer.');
  }
  return start;
}

function readTaskChecked(attrs: ReadonlyMap<string, unknown>): boolean {
  const checked = attrs.get('checked');
  if (checked === undefined) {
    return false;
  }
  if (typeof checked !== 'boolean') {
    throw invalid('A "taskItem" checked attribute must be a boolean.');
  }
  return checked;
}

function readCodeLanguage(attrs: ReadonlyMap<string, unknown>, state: ParseState): string | null {
  const language = attrs.get('language');
  if (language === undefined || language === null) {
    return null;
  }
  if (typeof language !== 'string' || !CODE_LANGUAGE_PATTERN.test(language)) {
    throw invalid('A "codeBlock" language must be a short identifier or null.');
  }
  return chargeString(language, state, 'Code block language');
}

function readTableCellAttrs(attrs: ReadonlyMap<string, unknown>): NoteTableCellAttrs {
  return {
    colspan: readSpan(attrs, 'colspan'),
    rowspan: readSpan(attrs, 'rowspan'),
    colwidth: readColumnWidths(attrs.get('colwidth')),
  };
}

function readSpan(attrs: ReadonlyMap<string, unknown>, key: 'colspan' | 'rowspan'): number {
  const span = attrs.get(key);
  if (span === undefined) {
    return 1;
  }
  if (!isIntegerInRange(span, 1, MAX_TABLE_SPAN)) {
    throw invalid(`A table cell ${key} must be an integer from 1 to ${MAX_TABLE_SPAN}.`);
  }
  return span;
}

/**
 * prosemirror-tables stores one width per spanned column and uses `0` for columns the user has
 * not resized, so `0` is accepted alongside real pixel widths.
 */
function readColumnWidths(value: unknown): number[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TABLE_SPAN) {
    throw invalid('A table cell colwidth must be null or a short array of widths.');
  }
  const widths: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const width: unknown = value[index];
    if (!isIntegerInRange(width, 0, MAX_COLUMN_WIDTH)) {
      throw invalid(`A table column width must be an integer from 0 to ${MAX_COLUMN_WIDTH}.`);
    }
    widths.push(width);
  }
  return widths;
}

function readLatex(raw: RawNode, state: ParseState): string {
  const latex = raw.attrs.get('latex');
  if (typeof latex !== 'string') {
    throw invalid(`A "${raw.type}" node requires a string latex attribute.`);
  }
  if (latex.length > NOTE_LIMITS.maxLatexLength) {
    throw invalid(`A math formula exceeds ${NOTE_LIMITS.maxLatexLength} characters.`);
  }
  return chargeString(latex, state, 'Math formula');
}

function readLinkHref(attrs: ReadonlyMap<string, unknown>, state: ParseState): string {
  const href = attrs.get('href');
  const normalized = typeof href === 'string' ? normalizeLinkHref(href) : null;
  if (normalized === null) {
    throw invalid('A link must point to an absolute http, https or mailto URL.');
  }
  return chargeString(normalized, state, 'Link');
}

function readWikilinkAttrs(
  attrs: ReadonlyMap<string, unknown>,
  state: ParseState,
): NoteWikilinkNode['attrs'] {
  const targetNodeId = attrs.get('targetNodeId');
  if (typeof targetNodeId !== 'string' || !isCanonicalUuid(targetNodeId)) {
    throw invalid('A "wikilink" node requires a canonical lowercase UUID targetNodeId.');
  }
  const label = attrs.get('label');
  if (
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    label.length > MAX_WIKILINK_LABEL_LENGTH ||
    hasControlCharacter(label)
  ) {
    throw invalid(
      `A "wikilink" label must be 1 to ${MAX_WIKILINK_LABEL_LENGTH} characters without control characters.`,
    );
  }
  return { targetNodeId, label: chargeString(label, state, 'Link label') };
}

function readAttachmentAttrs(
  attrs: ReadonlyMap<string, unknown>,
  state: ParseState,
): NoteAttachmentNode['attrs'] {
  const attachmentId = attrs.get('attachmentId');
  if (typeof attachmentId !== 'string' || !isCanonicalUuid(attachmentId)) {
    throw invalid('An "attachment" node requires a canonical lowercase UUID attachmentId.');
  }
  const kind = attrs.get('kind');
  if (kind !== 'image' && kind !== 'file') {
    throw invalid('An "attachment" kind must be "image" or "file".');
  }
  return {
    attachmentId,
    displayName: readDisplayName(attrs.get('displayName'), state),
    kind,
  };
}

/**
 * Display names are shown in the UI and in plain-text excerpts, one per line, so control
 * characters (including line breaks) are rejected along with empty or overly long names.
 */
function readDisplayName(value: unknown, state: ParseState): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw invalid(
      `An "attachment" displayName must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters without control characters.`,
    );
  }
  return chargeString(value, state, 'Attachment name');
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}
