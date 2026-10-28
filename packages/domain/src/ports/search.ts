/**
 * Search port (PRD §5.8).
 *
 * Search is deterministic full-text matching; there is no semantic or AI ranking (PRD §1).
 * The local adapter uses SQLite FTS5; a future server adapter may use PostgreSQL full-text
 * search. Query syntax is the adapter's private concern: callers pass plain user text, and the
 * adapter is responsible for escaping it so that user input can never inject query operators.
 *
 * Every operation is scoped to one workspace. Results from another workspace must never be
 * returned, even when the same words appear there (PRD §5.8).
 */

import type { NodeId, RelationshipTypeId, TagId, WorkspaceId } from '../ids';
import type { Page, PageRequest } from './pagination';

export interface SearchQuery {
  readonly workspaceId: WorkspaceId;
  /** Raw user text. Treated as literal terms, never as engine query syntax. */
  readonly text: string;
  /** When non-empty, only nodes carrying all of these tags are returned. */
  readonly tagIds: readonly TagId[];
  /**
   * When non-empty, only nodes with at least one relationship of any of these types, at either
   * end, are returned (PRD §5.8: "relationship-type filters where applicable"). "Any", unlike
   * tags: a node rarely has relationships of several chosen types at once.
   */
  readonly relationshipTypeIds?: readonly RelationshipTypeId[];
  readonly page: PageRequest;
}

export interface SearchHit {
  readonly nodeId: NodeId;
  readonly title: string;
  /**
   * Plain-text excerpt split into segments so the UI can highlight matches without rendering
   * HTML. This avoids injecting stored text into the DOM as markup (PRD §8).
   */
  readonly snippet: readonly SnippetSegment[];
}

export interface SnippetSegment {
  readonly text: string;
  readonly isMatch: boolean;
}

export interface SearchResultPage extends Page<SearchHit> {
  /** Total number of matching nodes (for "showing 20 of 134"). */
  readonly totalCount: number;
}

/** One candidate for a node picker (wikilinks, relationship targets, map placement). */
export interface TitleMatch {
  readonly nodeId: NodeId;
  readonly title: string;
}

export interface SearchIndex {
  /**
   * Ranked full-text search over titles, summaries and derived note text. Title matches rank
   * highest (PRD §5.8). Text without any searchable word returns an empty page, not an error.
   */
  search(query: SearchQuery): Promise<SearchResultPage>;
  /**
   * Deterministic title lookup for pickers (PRD §5.8): case-insensitive prefix matches first,
   * then other substring matches; ties ordered by title length, title, ID. Empty text → [].
   */
  lookupTitles(
    workspaceId: WorkspaceId,
    text: string,
    limit: number,
    excludeNodeIds?: readonly NodeId[],
  ): Promise<readonly TitleMatch[]>;
}
