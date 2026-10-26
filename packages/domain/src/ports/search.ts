/**
 * Search port (PRD §5.8).
 *
 * Search is deterministic full-text matching; there is no semantic or AI ranking (PRD §1).
 * The local adapter uses SQLite FTS5; a future server adapter may use PostgreSQL full-text
 * search. Query syntax is the adapter's private concern: callers pass plain user text, and the
 * adapter is responsible for escaping it so that user input can never inject query operators.
 */

import type { NodeId, TagId, WorkspaceId } from '../ids';
import type { Page, PageRequest } from './pagination';

export interface SearchQuery {
  readonly workspaceId: WorkspaceId;
  /** Raw user text. Treated as literal terms, never as engine query syntax. */
  readonly text: string;
  /** When non-empty, only nodes carrying all of these tags are returned. */
  readonly tagIds: readonly TagId[];
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

export interface SearchIndex {
  search(query: SearchQuery): Promise<Page<SearchHit>>;
}
