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
import type { NodeId, RelationshipTypeId, TimelineEventId, WorkspaceId } from '../ids';
import type { RelationshipDirectionality } from '../knowledge/relationship-rules';
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
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export const NODE_SORT_ORDERS = ['updated-desc', 'created-desc', 'title-asc'] as const;
export type NodeSortOrder = (typeof NODE_SORT_ORDERS)[number];

export interface NodeListQuery {
  readonly sort: NodeSortOrder;
  readonly page: PageRequest;
}

export interface NodeListPage extends Page<KnowledgeNodeSummary> {
  /** Number of nodes in the workspace, so the UI can say "showing 50 of 1,240". */
  readonly totalCount: number;
}

/** What deleting a node would remove or affect (PRD §5.2: preview before deleting). */
export interface NodeDependents {
  /** Semantic relationships that will be deleted with the node. */
  readonly relationships: number;
  /** Notes that link to this node; their link labels stay readable as unresolved links. */
  readonly referencingNotes: number;
  /** Map placements that will be removed (one per map the node appears on). */
  readonly mapPlacements: number;
  readonly attachments: number;
}

export interface KnowledgeNodeRepository {
  findById(workspaceId: WorkspaceId, nodeId: NodeId): Promise<KnowledgeNodeRecord | null>;
  list(workspaceId: WorkspaceId, query: NodeListQuery): Promise<NodeListPage>;
  insert(record: KnowledgeNodeRecord): Promise<void>;
  /**
   * Replaces the mutable fields and stores `record.revision`, but only when the stored revision
   * equals `expectedRevision`. Returns false (and changes nothing) on a revision mismatch.
   */
  update(record: KnowledgeNodeRecord, expectedRevision: Revision): Promise<boolean>;
  countDependents(workspaceId: WorkspaceId, nodeId: NodeId): Promise<NodeDependents>;
  /**
   * Deletes the node and everything that cannot exist without it (relationships, placements,
   * references from it, attachment rows). Child placements on maps are promoted to the deleted
   * placement's parent so no subtree disappears silently.
   */
  delete(workspaceId: WorkspaceId, nodeId: NodeId): Promise<void>;
}

export const TIMELINE_EVENT_TYPES = [
  'node_created',
  'note_updated',
  'relationship_created',
  'reviewed',
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export interface TimelineEventRecord {
  readonly id: TimelineEventId;
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId | null;
  /** Title at the time of the event, so history stays readable after deletion. */
  readonly nodeTitleSnapshot: string | null;
  readonly eventType: TimelineEventType;
  readonly occurredAt: UtcTimestamp;
  readonly lastActivityAt: UtcTimestamp;
  readonly reflection: string | null;
  readonly isImported: boolean;
  readonly importOrigin: string | null;
}

export interface TimelineEventRepository {
  insert(record: TimelineEventRecord): Promise<void>;
}

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly name: string;
  /** IANA timezone used only for display (PRD §5.9). Storage is always UTC. */
  readonly timezone: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface WorkspaceRepository {
  findById(workspaceId: WorkspaceId): Promise<WorkspaceRecord | null>;
  insert(record: WorkspaceRecord): Promise<void>;
  rename(workspaceId: WorkspaceId, name: string, updatedAt: UtcTimestamp): Promise<void>;
}

export interface RelationshipTypeRecord {
  readonly id: RelationshipTypeId;
  readonly workspaceId: WorkspaceId;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly directionality: RelationshipDirectionality;
  readonly isArchived: boolean;
  readonly isBuiltin: boolean;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface RelationshipTypeRepository {
  insert(record: RelationshipTypeRecord): Promise<void>;
  listByWorkspace(workspaceId: WorkspaceId): Promise<readonly RelationshipTypeRecord[]>;
}
