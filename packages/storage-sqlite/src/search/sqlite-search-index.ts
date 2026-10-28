/**
 * SQLite FTS5 implementation of the `SearchIndex` port (PRD §5.8).
 *
 * Full-text search runs against the external-content table `knowledge_nodes_fts`, which the
 * triggers of migration 1 keep in sync with `knowledge_nodes` (title, summary and derived note
 * plain text). Ranking is plain BM25 with per-column weights; there is no semantic or learned
 * ranking (PRD §1).
 *
 * Workspace isolation: the FTS table has no workspace column, so every query joins
 * `knowledge_nodes` on the FTS rowid and filters on `workspace_id`. A match in another workspace
 * is discarded by the join and never counted, ranked or returned.
 *
 * Pagination uses an offset cursor. Keyset paging (used for node lists) needs a stable sort key,
 * but a BM25 score is recomputed on every query and changes when any matching document changes,
 * so it cannot serve as one. Each page is therefore a position in a fresh ranking: if nodes are
 * edited between page requests an item may shift by a page, which is acceptable for ranked
 * results and documented for callers through the opaque cursor contract.
 */

import {
  clampPageSize,
  DomainError,
  type NodeId,
  type RelationshipTypeId,
  type SearchHit,
  type SearchIndex,
  type SearchQuery,
  type SearchResultPage,
  type TagId,
  type TitleMatch,
  type WorkspaceId,
} from '@mmap/domain';
import type { SQLOutputValue } from 'node:sqlite';

import { placeholders } from '../repositories/sqlite-tag-repository';
import type { SqliteConnections } from '../sqlite-connections';
import { buildFtsMatchExpression } from './fts-query';
import {
  parseSnippetSegments,
  SNIPPET_ELLIPSIS,
  SNIPPET_MATCH_END,
  SNIPPET_MATCH_START,
} from './snippet-segments';

/**
 * BM25 weights for (title, summary, note_plain_text), in FTS column order. A title hit counts
 * ten times a note hit and a summary hit four times, so "give title matches higher ranking"
 * (PRD §5.8) holds while body text still contributes.
 */
const BM25_RANK = 'bm25(knowledge_nodes_fts, 10.0, 4.0, 1.0)';

/** Approximate number of tokens FTS5 includes in a snippet. */
const SNIPPET_TOKENS = 12;

/** Upper bound for picker lookups; pickers show a short list. */
export const MAX_TITLE_LOOKUP_LIMIT = 50;

/**
 * Longest lookup text used, in code points. Titles longer than this are rare, and the bound keeps
 * the LIKE pattern small for pasted input.
 */
const MAX_LOOKUP_TEXT_LENGTH = 200;

/**
 * Largest accepted cursor offset. Far beyond any real result list; rejecting larger values keeps
 * a tampered cursor from asking SQLite to skip an absurd number of rows.
 */
const MAX_CURSOR_OFFSET = 1_000_000;

type Row = Record<string, SQLOutputValue>;

interface SqlFragment {
  readonly sql: string;
  readonly parameters: (string | number)[];
}

export class SqliteSearchIndex implements SearchIndex {
  public constructor(private readonly connections: SqliteConnections) {}

  public search(query: SearchQuery): Promise<SearchResultPage> {
    return runAsync(() => this.searchNow(query));
  }

  public lookupTitles(
    workspaceId: WorkspaceId,
    text: string,
    limit: number,
    excludeNodeIds: readonly NodeId[] = [],
  ): Promise<readonly TitleMatch[]> {
    return runAsync(() => this.lookupTitlesNow(workspaceId, text, limit, excludeNodeIds));
  }

  private searchNow(query: SearchQuery): SearchResultPage {
    // Validate the cursor before anything else so a tampered cursor fails even for empty text.
    const offset = query.page.cursor === undefined ? 0 : decodeCursor(query.page.cursor);
    const limit = clampPageSize(query.page.limit);
    const match = buildFtsMatchExpression(query.text);
    if (match === null) {
      return { items: [], nextCursor: null, totalCount: 0 };
    }

    const database = this.connections.forRead();
    const filter = combine(
      tagFilter(query.workspaceId, query.tagIds),
      relationshipTypeFilter(query.workspaceId, query.relationshipTypeIds ?? []),
    );
    // Shared FROM/WHERE so the count and the page always agree on what matches.
    const matchingNodes = `
      FROM knowledge_nodes_fts
      JOIN knowledge_nodes AS n ON n.row_key = knowledge_nodes_fts.rowid AND n.workspace_id = ?
      WHERE knowledge_nodes_fts MATCH ? ${filter.sql}`;
    const matchParameters = [query.workspaceId, match, ...filter.parameters];

    // Fetch one extra row to learn whether another page exists.
    const rows = database
      .prepare(
        `SELECT n.id, n.title, snippet(knowledge_nodes_fts, -1, ?, ?, ?, ?) AS snippet
         ${matchingNodes}
         ORDER BY ${BM25_RANK}, n.id
         LIMIT ? OFFSET ?`,
      )
      .all(
        SNIPPET_MATCH_START,
        SNIPPET_MATCH_END,
        SNIPPET_ELLIPSIS,
        SNIPPET_TOKENS,
        ...matchParameters,
        limit + 1,
        offset,
      );
    const total = database
      .prepare(`SELECT count(*) AS total ${matchingNodes}`)
      .get(...matchParameters);

    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(toSearchHit),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      totalCount: Number(total?.total ?? 0),
    };
  }

  /**
   * Picker lookup. Case-insensitivity comes from SQLite's LIKE, which folds ASCII letters only
   * (as does `COLLATE NOCASE`): "entropy" finds "Entropy", but "é" does not find "É". Full
   * Unicode case folding would need ICU, which node:sqlite does not ship.
   */
  private lookupTitlesNow(
    workspaceId: WorkspaceId,
    text: string,
    limit: number,
    excludeNodeIds: readonly NodeId[],
  ): readonly TitleMatch[] {
    const needle = Array.from(text.trim()).slice(0, MAX_LOOKUP_TEXT_LENGTH).join('');
    if (needle.length === 0) {
      return [];
    }
    const escaped = escapeLikePattern(needle);
    const excluded = excludeFilter(excludeNodeIds);

    // Group 0 = title starts with the text, group 1 = text occurs elsewhere in the title.
    return this.connections
      .forRead()
      .prepare(
        `SELECT id, title
         FROM knowledge_nodes
         WHERE workspace_id = ? AND title LIKE ? ESCAPE '\\' ${excluded.sql}
         ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                  length(title), title COLLATE NOCASE, id
         LIMIT ?`,
      )
      .all(
        workspaceId,
        `%${escaped}%`,
        ...excluded.parameters,
        `${escaped}%`,
        clampLookupLimit(limit),
      )
      .map((row) => ({ nodeId: String(row.id) as NodeId, title: String(row.title) }));
  }
}

/**
 * Runs synchronous driver work behind the async port contract. A throw inside `work` becomes a
 * rejected promise (the Promise constructor catches it), so callers never see a synchronous
 * exception from an async-looking method.
 */
function runAsync<Result>(work: () => Result): Promise<Result> {
  return new Promise((resolve) => resolve(work()));
}

/**
 * SQL condition restricting matches to nodes carrying every tag in `tagIds` ("match all", the
 * same rule as node list filtering). Tag IDs are bound parameters; only the placeholder count is
 * generated. Kept local because the node repository's helper is private to that module.
 */
function tagFilter(workspaceId: WorkspaceId, tagIds: readonly TagId[]): SqlFragment {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) {
    return { sql: '', parameters: [] };
  }
  return {
    sql: `AND n.id IN (
      SELECT node_id FROM node_tags
      WHERE workspace_id = ? AND tag_id IN (${placeholders(unique.length)})
      GROUP BY node_id HAVING count(DISTINCT tag_id) = ?
    )`,
    parameters: [workspaceId, ...unique, unique.length],
  };
}

/**
 * SQL condition restricting matches to nodes with at least one relationship of any type in
 * `typeIds`, as source or target. Both halves use the `(workspace_id, type_id, directionality)`
 * index; a type from another workspace matches nothing.
 */
function relationshipTypeFilter(
  workspaceId: WorkspaceId,
  typeIds: readonly RelationshipTypeId[],
): SqlFragment {
  const unique = [...new Set(typeIds)];
  if (unique.length === 0) {
    return { sql: '', parameters: [] };
  }
  const types = placeholders(unique.length);
  return {
    sql: `AND n.id IN (
      SELECT source_node_id FROM relationships WHERE workspace_id = ? AND type_id IN (${types})
      UNION
      SELECT target_node_id FROM relationships WHERE workspace_id = ? AND type_id IN (${types})
    )`,
    parameters: [workspaceId, ...unique, workspaceId, ...unique],
  };
}

function combine(...fragments: readonly SqlFragment[]): SqlFragment {
  return {
    sql: fragments.map((fragment) => fragment.sql).join(' '),
    parameters: fragments.flatMap((fragment) => fragment.parameters),
  };
}

/**
 * Excludes already-chosen nodes from picker results. The IDs travel as one JSON array parameter
 * expanded by `json_each`, so any number of exclusions stays within SQLite's parameter limit.
 */
function excludeFilter(nodeIds: readonly NodeId[]): SqlFragment {
  if (nodeIds.length === 0) {
    return { sql: '', parameters: [] };
  }
  return {
    sql: 'AND id NOT IN (SELECT value FROM json_each(?))',
    parameters: [JSON.stringify([...new Set(nodeIds)])],
  };
}

/**
 * Escapes LIKE wildcards so user text matches literally: `%` and `_` would otherwise match any
 * run or any single character, and `\` is our ESCAPE character. The backslash must be escaped
 * first so the escapes added for `%` and `_` are not doubled.
 */
export function escapeLikePattern(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Clamps a picker limit into `[1, MAX_TITLE_LOOKUP_LIMIT]`. Non-finite input becomes 1. */
function clampLookupLimit(requested: number): number {
  if (!Number.isFinite(requested)) {
    return 1;
  }
  return Math.min(MAX_TITLE_LOOKUP_LIMIT, Math.max(1, Math.trunc(requested)));
}

function toSearchHit(row: Row): SearchHit {
  return {
    nodeId: String(row.id) as NodeId,
    title: String(row.title),
    snippet: parseSnippetSegments(row.snippet === null ? '' : String(row.snippet)),
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

/**
 * Decodes an offset cursor. Only the exact encoding this module produces for an integer offset in
 * range is accepted: the decoded offset is re-encoded and must reproduce the input byte for byte.
 * That rejects extra fields, other JSON shapes, negative or fractional offsets and the lenient
 * base64 variants Node's decoder would otherwise tolerate.
 */
function decodeCursor(encoded: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const offset: unknown =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { offset?: unknown }).offset
        : null;
    if (
      typeof offset === 'number' &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= MAX_CURSOR_OFFSET &&
      encodeCursor(offset) === encoded
    ) {
      return offset;
    }
  } catch {
    // Falls through to the validation error below.
  }
  throw new DomainError('VALIDATION_FAILED', 'The search position is invalid. Search again.');
}
