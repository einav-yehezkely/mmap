/**
 * Application service for attachment metadata (PRD §5.10).
 *
 * File bytes are handled by the desktop attachment store; this service owns the database side:
 * it registers a verified, already stored file against a node, lists attachments, and removes
 * metadata. The caller deletes the file only after the metadata removal committed, so a crash in
 * between leaves an orphan file (cleaned on startup), never a row pointing at a deleted file.
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { AttachmentId, IdGenerator, NodeId, WorkspaceId } from '../ids';
import type {
  AttachmentRecord,
  AttachmentRepository,
  KnowledgeNodeRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';

/** Raster image types that may be previewed inside the app. SVG is excluded (it can carry scripts). */
export const PREVIEWABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface AttachmentView {
  readonly id: AttachmentId;
  readonly nodeId: NodeId;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  /** True for raster images whose type was confirmed from their bytes. */
  readonly previewable: boolean;
  readonly createdAt: string;
}

export interface StoredFileDescription {
  readonly relativePath: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface AttachmentServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly attachments: AttachmentRepository;
  readonly nodes: KnowledgeNodeRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface AttachmentService {
  /** Records a stored file as an attachment of `nodeId`. Fails with NOT_FOUND if the node is gone. */
  register(nodeId: NodeId, file: StoredFileDescription): Promise<AttachmentView>;
  listForNode(nodeId: NodeId): Promise<readonly AttachmentView[]>;
  /** Metadata needed to open or preview a file; NOT_FOUND for unknown or other-workspace IDs. */
  getStoredFile(attachmentId: AttachmentId): Promise<AttachmentRecord>;
  /** Removes the metadata and returns the relative path so the caller can delete the file. */
  remove(attachmentId: AttachmentId): Promise<{ relativePath: string }>;
  listAllRelativePaths(): Promise<readonly string[]>;
}

export function createAttachmentService(
  dependencies: AttachmentServiceDependencies,
): AttachmentService {
  const { workspaceId, transactions, attachments, nodes, ids, clock } = dependencies;

  async function requireAttachment(attachmentId: AttachmentId): Promise<AttachmentRecord> {
    const record = await attachments.findById(workspaceId, attachmentId);
    if (record === null) {
      throw new DomainError('NOT_FOUND', 'This attachment no longer exists.');
    }
    return record;
  }

  return {
    register: (nodeId, file) =>
      transactions.runInTransaction(async () => {
        if ((await nodes.findById(workspaceId, nodeId)) === null) {
          throw new DomainError('NOT_FOUND', 'This node no longer exists.');
        }
        const now = clock.now();
        const record: AttachmentRecord = {
          id: ids.newId() as AttachmentId,
          workspaceId,
          nodeId,
          relativePath: file.relativePath,
          originalName: file.displayName,
          mimeType: file.mimeType,
          byteSize: file.byteSize,
          sha256: file.sha256,
          state: 'committed',
          createdAt: now,
          updatedAt: now,
        };
        await attachments.insert(record);
        return toView(record);
      }),

    listForNode: async (nodeId) => (await attachments.listForNode(workspaceId, nodeId)).map(toView),

    getStoredFile: requireAttachment,

    remove: (attachmentId) =>
      transactions.runInTransaction(async () => {
        const record = await requireAttachment(attachmentId);
        await attachments.delete(workspaceId, attachmentId);
        return { relativePath: record.relativePath };
      }),

    listAllRelativePaths: () => attachments.listAllRelativePaths(workspaceId),
  };
}

export function toAttachmentView(record: AttachmentRecord): AttachmentView {
  return toView(record);
}

function toView(record: AttachmentRecord): AttachmentView {
  return {
    id: record.id,
    nodeId: record.nodeId,
    displayName: record.originalName,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    previewable: PREVIEWABLE_IMAGE_TYPES.has(record.mimeType),
    createdAt: record.createdAt,
  };
}
