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
import type {
  AttachmentId,
  NodeId,
  RelationshipId,
  RelationshipTypeId,
  TagId,
  TimelineEventId,
  WorkspaceId,
} from '../ids';
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

/** A tag as attached to a node. */
export interface TagSummary {
  readonly id: TagId;
  readonly label: string;
}

export const NODE_SORT_ORDERS = ['updated-desc', 'created-desc', 'title-asc'] as const;
export type NodeSortOrder = (typeof NODE_SORT_ORDERS)[number];

export interface NodeListQuery {
  readonly sort: NodeSortOrder;
  readonly page: PageRequest;
  /** When non-empty, only nodes carrying every one of these tags are listed. */
  readonly tagIds: readonly TagId[];
}

export interface NodeListPage extends Page<KnowledgeNodeSummary> {
  /** Number of nodes matching the query, so the UI can say "showing 50 of 1,240". */
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
  /** Titles of those nodes that exist in the workspace; missing IDs are simply absent. */
  findTitles(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
  ): Promise<ReadonlyMap<NodeId, string>>;
}

/** One wikilink occurrence to store for a source note (see `extractNoteReferences`). */
export interface NoteReferenceInput {
  readonly ordinal: number;
  readonly targetNodeId: NodeId;
  readonly label: string;
  readonly excerpt: string;
}

/** A note that links to a node, as shown in that node's backlinks (PRD §5.4). */
export interface BacklinkRecord {
  readonly sourceNodeId: NodeId;
  readonly sourceTitle: string;
  /** Label and excerpt of the first occurrence in the source note. */
  readonly label: string;
  readonly excerpt: string;
  /** How many times the source note links to the node. */
  readonly occurrences: number;
}

export interface NoteReferenceRepository {
  /**
   * Replaces all references of `sourceNodeId`. Only references whose target exists in the
   * workspace are stored; links to missing nodes stay readable in the note itself and are
   * shown as unresolved (PRD §5.4).
   */
  replaceForSource(
    workspaceId: WorkspaceId,
    sourceNodeId: NodeId,
    references: readonly NoteReferenceInput[],
  ): Promise<void>;
  /** Notes linking to `targetNodeId` (excluding the node itself), ordered by source title. */
  listBacklinks(workspaceId: WorkspaceId, targetNodeId: NodeId): Promise<readonly BacklinkRecord[]>;
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
  /** Most recent non-imported event of `eventType` for a node, or null. */
  findLatestForNode(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    eventType: TimelineEventType,
  ): Promise<TimelineEventRecord | null>;
  /** Extends an editing session: updates `lastActivityAt` and the title snapshot. */
  extendSession(
    workspaceId: WorkspaceId,
    eventId: TimelineEventId,
    lastActivityAt: UtcTimestamp,
    nodeTitleSnapshot: string,
  ): Promise<void>;
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
  findById(
    workspaceId: WorkspaceId,
    typeId: RelationshipTypeId,
  ): Promise<RelationshipTypeRecord | null>;
  findByNormalizedLabel(
    workspaceId: WorkspaceId,
    normalizedLabel: string,
  ): Promise<RelationshipTypeRecord | null>;
  /** Replaces label, normalized label, directionality, archived state and updated time. */
  update(record: RelationshipTypeRecord): Promise<void>;
  /** Number of relationships using each type, keyed by type ID (types without any are absent). */
  countUsage(workspaceId: WorkspaceId): Promise<ReadonlyMap<RelationshipTypeId, number>>;
}

export interface RelationshipRecord {
  readonly id: RelationshipId;
  readonly workspaceId: WorkspaceId;
  /** For undirected types, the endpoint with the lower ID (canonical order, PRD §4.2). */
  readonly sourceNodeId: NodeId;
  readonly targetNodeId: NodeId;
  readonly typeId: RelationshipTypeId;
  /** Copy of the type's directionality, enforced by the schema to match the type. */
  readonly directionality: RelationshipDirectionality;
  readonly description: string | null;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

/** A relationship with the labels needed to show it, loaded in one query. */
export interface RelationshipDetails extends RelationshipRecord {
  readonly typeLabel: string;
  readonly sourceTitle: string;
  readonly targetTitle: string;
}

export interface RelationshipRepository {
  insert(record: RelationshipRecord): Promise<void>;
  findById(
    workspaceId: WorkspaceId,
    relationshipId: RelationshipId,
  ): Promise<RelationshipRecord | null>;
  /** The relationship with exactly these stored endpoints and type, if any. */
  findByEndpoints(
    workspaceId: WorkspaceId,
    sourceNodeId: NodeId,
    targetNodeId: NodeId,
    typeId: RelationshipTypeId,
  ): Promise<RelationshipRecord | null>;
  update(record: RelationshipRecord): Promise<void>;
  delete(workspaceId: WorkspaceId, relationshipId: RelationshipId): Promise<void>;
  /** Every relationship in which the node is source or target, ordered by type label and title. */
  listForNode(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly RelationshipDetails[]>;
}

export interface TagRecord {
  readonly id: TagId;
  readonly workspaceId: WorkspaceId;
  /** What the user typed (trimmed, whitespace collapsed). */
  readonly displayLabel: string;
  /** Uniqueness key within the workspace (see `toNormalizedLabel`). */
  readonly normalizedLabel: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface TagWithUsage {
  readonly id: TagId;
  readonly label: string;
  /** Number of nodes carrying the tag. */
  readonly nodeCount: number;
}

export interface TagRepository {
  listWithUsage(workspaceId: WorkspaceId): Promise<readonly TagWithUsage[]>;
  findById(workspaceId: WorkspaceId, tagId: TagId): Promise<TagRecord | null>;
  findByNormalizedLabel(
    workspaceId: WorkspaceId,
    normalizedLabel: string,
  ): Promise<TagRecord | null>;
  insert(record: TagRecord): Promise<void>;
  rename(
    workspaceId: WorkspaceId,
    tagId: TagId,
    displayLabel: string,
    normalizedLabel: string,
    updatedAt: UtcTimestamp,
  ): Promise<void>;
  /** Deletes the tag and its assignments. Nodes are never deleted. */
  delete(workspaceId: WorkspaceId, tagId: TagId): Promise<void>;
  /** Tags of each requested node, sorted by label. Nodes without tags map to an empty list. */
  listForNodes(
    workspaceId: WorkspaceId,
    nodeIds: readonly NodeId[],
  ): Promise<ReadonlyMap<NodeId, readonly TagSummary[]>>;
  /** Attaches a tag to a node; attaching an already attached tag changes nothing. */
  attach(
    workspaceId: WorkspaceId,
    nodeId: NodeId,
    tagId: TagId,
    createdAt: UtcTimestamp,
  ): Promise<void>;
  detach(workspaceId: WorkspaceId, nodeId: NodeId, tagId: TagId): Promise<void>;
}

export interface AttachmentRecord {
  readonly id: AttachmentId;
  readonly workspaceId: WorkspaceId;
  readonly nodeId: NodeId;
  /** Generated storage path relative to the workspace attachments folder (never user-chosen). */
  readonly relativePath: string;
  /** Sanitized original file name, used only for display and export. */
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly state: 'staged' | 'committed';
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface AttachmentRepository {
  insert(record: AttachmentRecord): Promise<void>;
  findById(workspaceId: WorkspaceId, attachmentId: AttachmentId): Promise<AttachmentRecord | null>;
  listForNode(workspaceId: WorkspaceId, nodeId: NodeId): Promise<readonly AttachmentRecord[]>;
  delete(workspaceId: WorkspaceId, attachmentId: AttachmentId): Promise<void>;
  /** Every stored relative path in the workspace; used to reconcile files on startup. */
  listAllRelativePaths(workspaceId: WorkspaceId): Promise<readonly string[]>;
}
