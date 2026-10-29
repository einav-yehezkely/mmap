/**
 * Ports for export and import (PRD §5.11).
 *
 * Export reads the whole workspace at once through `WorkspaceSnapshotReader`, inside one read
 * transaction, so the archive is a consistent picture even while other saves are queued. Import
 * writes through the ordinary repositories (see `import-service.ts`) and records each import in
 * `ImportHistoryRepository`, which is how re-importing the same archive is detected.
 */

import type { UtcTimestamp } from '../clock';
import type { NodeId, TagId, WorkspaceId } from '../ids';
import type { GraphNodePosition } from './graph';
import type {
  MapConnectionRecord,
  MapRegionRecord,
  MindMapRecord,
  PlacementRecord,
} from './map-repository';
import type {
  AttachmentRecord,
  KnowledgeNodeRecord,
  RelationshipRecord,
  RelationshipTypeRecord,
  TagRecord,
  TimelineEventRecord,
  WorkspaceRecord,
} from './repositories';

export interface NodeTagRecord {
  readonly nodeId: NodeId;
  readonly tagId: TagId;
  readonly createdAt: UtcTimestamp;
}

/** Every exportable record of one workspace. Attachments are committed ones only. */
export interface WorkspaceSnapshot {
  readonly workspace: WorkspaceRecord;
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly tags: readonly TagRecord[];
  readonly nodeTags: readonly NodeTagRecord[];
  readonly relationshipTypes: readonly RelationshipTypeRecord[];
  readonly relationships: readonly RelationshipRecord[];
  readonly maps: readonly MindMapRecord[];
  readonly placements: readonly PlacementRecord[];
  readonly connections: readonly MapConnectionRecord[];
  readonly regions: readonly MapRegionRecord[];
  readonly timelineEvents: readonly TimelineEventRecord[];
  readonly attachments: readonly AttachmentRecord[];
  readonly graphPositions: readonly GraphNodePosition[];
}

export interface WorkspaceSnapshotReader {
  /** Reads all records of the workspace in one consistent read. */
  read(workspaceId: WorkspaceId): Promise<WorkspaceSnapshot>;
}

export interface ImportRecord {
  /** The archive's export ID. */
  readonly exportId: string;
  readonly importedAt: UtcTimestamp;
}

export interface ImportHistoryRepository {
  /** Earlier completed imports of the archive with this export ID, oldest first. */
  findImports(workspaceId: WorkspaceId, exportId: string): Promise<readonly ImportRecord[]>;
  /** Records a completed import (in the import's transaction). */
  recordImport(
    workspaceId: WorkspaceId,
    jobId: string,
    exportId: string,
    importedAt: UtcTimestamp,
  ): Promise<void>;
}
