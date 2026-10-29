/**
 * Applies a planned archive import (PRD §5.11: "apply database records transactionally").
 *
 * The desktop layer validates the archive, plans the import with `planImport`, copies the
 * attachment files into the workspace store, and then calls `apply` with the storage path of
 * every copied file. `apply` writes every record in one transaction: either the whole archive
 * becomes visible, or nothing does. If it fails, the caller removes the copied files again.
 *
 * Note references are rebuilt from the imported notes in the same transaction, exactly as a save
 * does, and the import is recorded so that importing the same archive again can be detected.
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { AttachmentId, IdGenerator, NodeId, WorkspaceId } from '../ids';
import { parseNoteDocument } from '../notes/note-document';
import { extractNoteReferences } from '../notes/note-references';
import type { ImportPlan } from '../portability/import-plan';
import type { GraphLayoutRepository } from '../ports/graph';
import type { MapRepository } from '../ports/map-repository';
import type { ImportHistoryRepository, ImportRecord } from '../ports/portability';
import type {
  AttachmentRepository,
  KnowledgeNodeRepository,
  NoteReferenceRepository,
  RelationshipRepository,
  RelationshipTypeRecord,
  RelationshipTypeRepository,
  TagRecord,
  TagRepository,
  TimelineEventRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';

export interface ImportServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly nodes: KnowledgeNodeRepository;
  readonly tags: TagRepository;
  readonly relationshipTypes: RelationshipTypeRepository;
  readonly relationships: RelationshipRepository;
  readonly references: NoteReferenceRepository;
  readonly maps: MapRepository;
  readonly timeline: TimelineEventRepository;
  readonly attachments: AttachmentRepository;
  readonly graphLayout: GraphLayoutRepository;
  readonly importHistory: ImportHistoryRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What the planner needs to know about the destination workspace. */
export interface ImportDestination {
  readonly existingTypes: readonly RelationshipTypeRecord[];
  readonly existingTags: readonly TagRecord[];
  /** Earlier imports of the same archive; non-empty means "already imported". */
  readonly earlierImports: readonly ImportRecord[];
}

export interface ImportService {
  describeDestination(exportId: string): Promise<ImportDestination>;
  /**
   * Writes the planned records. `storedFiles` maps each planned attachment to the storage path of
   * its copied file; every planned attachment must have one.
   */
  apply(
    plan: ImportPlan,
    exportId: string,
    storedFiles: ReadonlyMap<AttachmentId, string>,
  ): Promise<void>;
}

export function createImportService(dependencies: ImportServiceDependencies): ImportService {
  const { workspaceId, transactions } = dependencies;

  return {
    async describeDestination(exportId) {
      const [existingTypes, existingTags, earlierImports] = await Promise.all([
        dependencies.relationshipTypes.listByWorkspace(workspaceId),
        dependencies.tags.listAll(workspaceId),
        dependencies.importHistory.findImports(workspaceId, exportId),
      ]);
      return { existingTypes, existingTags, earlierImports };
    },

    async apply(plan, exportId, storedFiles) {
      for (const attachment of plan.attachments) {
        if (!storedFiles.has(attachment.id)) {
          throw new DomainError('INVARIANT_VIOLATION', 'An attachment file was not stored.');
        }
      }
      const now = dependencies.clock.now();
      await transactions.runInTransaction(async () => {
        for (const type of plan.relationshipTypes)
          await dependencies.relationshipTypes.insert(type);
        for (const tag of plan.tags) await dependencies.tags.insert(tag);
        for (const node of plan.nodes) await dependencies.nodes.insert(node);
        for (const assignment of plan.nodeTags) {
          await dependencies.tags.attach(
            workspaceId,
            assignment.nodeId,
            assignment.tagId,
            assignment.createdAt,
          );
        }
        for (const relationship of plan.relationships) {
          await dependencies.relationships.insert(relationship);
        }
        // Derived from the imported notes, after all nodes exist, so links between imported
        // nodes resolve; links to anything else stay unresolved.
        for (const node of plan.nodes) {
          const references = extractNoteReferences(parseNoteDocument(JSON.parse(node.noteJson)));
          await dependencies.references.replaceForSource(
            workspaceId,
            node.id,
            references.map((reference) => ({
              ...reference,
              targetNodeId: reference.targetNodeId as NodeId,
            })),
          );
        }
        for (const map of plan.maps) await dependencies.maps.insertMap(map);
        for (const placement of plan.placements) await dependencies.maps.insertPlacement(placement);
        for (const connection of plan.connections) {
          await dependencies.maps.insertConnection(connection);
        }
        for (const region of plan.regions) {
          await dependencies.maps.insertRegion(region);
        }
        for (const map of plan.maps) {
          if (map.arrangement !== undefined && map.arrangement !== null) {
            await dependencies.maps.setArrangement(workspaceId, map.id, map.arrangement);
          }
        }
        for (const attachment of plan.attachments) {
          await dependencies.attachments.insert({
            id: attachment.id,
            workspaceId,
            nodeId: attachment.nodeId,
            relativePath: storedFiles.get(attachment.id)!,
            originalName: attachment.originalName,
            mimeType: attachment.mimeType,
            byteSize: attachment.byteSize,
            sha256: attachment.sha256,
            state: 'committed',
            createdAt: attachment.createdAt,
            updatedAt: attachment.updatedAt,
          });
        }
        for (const event of plan.timelineEvents) await dependencies.timeline.insert(event);
        if (plan.graphPositions.length > 0) {
          await dependencies.graphLayout.savePositions(workspaceId, plan.graphPositions, now);
        }
        await dependencies.importHistory.recordImport(
          workspaceId,
          dependencies.ids.newId(),
          exportId,
          now,
        );
      });
    },
  };
}
