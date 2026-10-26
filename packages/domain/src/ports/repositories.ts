/**
 * Repository ports.
 *
 * Phase 0 baseline: these interfaces fix the shape that every storage adapter must follow
 * (workspace scope, revisions, UTC timestamps). Methods are added in the phase that needs them;
 * each addition must come with adapter contract tests.
 *
 * Rules every implementation must follow:
 * - Every query is scoped to exactly one workspace. A record from another workspace behaves as
 *   if it does not exist (`null` / `NOT_FOUND`), so that IDs cannot be used to probe other data.
 * - Writes that replace user content take an `expectedRevision`. A mismatch throws
 *   `DomainError('REVISION_CONFLICT')` and leaves the stored record unchanged (PRD §5.2).
 */

import type { UtcTimestamp } from '../clock';
import type { NodeId, WorkspaceId } from '../ids';
import type { Page, PageRequest } from './pagination';

/** Monotonically increasing revision number, starting at 1 when a record is created. */
export type Revision = number;

export interface KnowledgeNodeRecord {
  readonly id: NodeId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly summary: string | null;
  /** Serialized, validated, versioned Tiptap document (source of truth, PRD §5.3). */
  readonly noteJson: string;
  readonly noteSchemaVersion: number;
  /** Derived plain text used only for search; regenerated from `noteJson` on every save. */
  readonly notePlainText: string;
  readonly revision: Revision;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface KnowledgeNodeSummary {
  readonly id: NodeId;
  readonly title: string;
  readonly updatedAt: UtcTimestamp;
}

export interface KnowledgeNodeRepository {
  findById(workspaceId: WorkspaceId, nodeId: NodeId): Promise<KnowledgeNodeRecord | null>;
  listByUpdatedAt(workspaceId: WorkspaceId, page: PageRequest): Promise<Page<KnowledgeNodeSummary>>;
  insert(record: KnowledgeNodeRecord): Promise<void>;
  /**
   * Replaces mutable fields when the stored revision equals `expectedRevision`, then stores
   * `expectedRevision + 1`.
   */
  update(record: KnowledgeNodeRecord, expectedRevision: Revision): Promise<void>;
}
