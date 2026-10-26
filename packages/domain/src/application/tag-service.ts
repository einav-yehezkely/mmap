/**
 * Application service for workspace tags (PRD §5.8: "Tags are workspace-scoped and reusable.
 * Support creation, assignment, removal, rename, and deletion without deleting nodes. Normalize
 * tag uniqueness within a workspace while preserving a display label.").
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { IdGenerator, NodeId, TagId, WorkspaceId } from '../ids';
import type {
  KnowledgeNodeRepository,
  TagRecord,
  TagRepository,
  TagSummary,
  TagWithUsage,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';
import { toDisplayLabel, toNormalizedLabel } from '../text/labels';

export interface TagServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly tags: TagRepository;
  readonly nodes: KnowledgeNodeRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface TagService {
  list(): Promise<readonly TagWithUsage[]>;
  create(rawLabel: string): Promise<TagSummary>;
  rename(tagId: TagId, rawLabel: string): Promise<TagSummary>;
  delete(tagId: TagId): Promise<void>;
  /**
   * Adds a tag to a node by label, creating the tag if no tag with the same normalized label
   * exists. Idempotent. Returns the node's tags afterwards.
   */
  assignToNode(nodeId: NodeId, rawLabel: string): Promise<readonly TagSummary[]>;
  /** Removes a tag from a node. Idempotent. Returns the node's tags afterwards. */
  removeFromNode(nodeId: NodeId, tagId: TagId): Promise<readonly TagSummary[]>;
}

export function createTagService(dependencies: TagServiceDependencies): TagService {
  const { workspaceId, transactions, tags, nodes, ids, clock } = dependencies;

  async function requireTag(tagId: TagId): Promise<TagRecord> {
    const tag = await tags.findById(workspaceId, tagId);
    if (tag === null) {
      throw new DomainError('NOT_FOUND', 'This tag no longer exists.');
    }
    return tag;
  }

  async function requireNode(nodeId: NodeId): Promise<void> {
    if ((await nodes.findById(workspaceId, nodeId)) === null) {
      throw new DomainError('NOT_FOUND', 'This node no longer exists.');
    }
  }

  async function tagsOfNode(nodeId: NodeId): Promise<readonly TagSummary[]> {
    return (await tags.listForNodes(workspaceId, [nodeId])).get(nodeId) ?? [];
  }

  async function insertTag(displayLabel: string): Promise<TagRecord> {
    const now = clock.now();
    const record: TagRecord = {
      id: ids.newId() as TagId,
      workspaceId,
      displayLabel,
      normalizedLabel: toNormalizedLabel(displayLabel),
      createdAt: now,
      updatedAt: now,
    };
    await tags.insert(record);
    return record;
  }

  return {
    list: () => tags.listWithUsage(workspaceId),

    create: (rawLabel) =>
      transactions.runInTransaction(async () => {
        const displayLabel = toDisplayLabel(rawLabel, 'Tag');
        const existing = await tags.findByNormalizedLabel(
          workspaceId,
          toNormalizedLabel(displayLabel),
        );
        if (existing !== null) {
          throw new DomainError(
            'DUPLICATE',
            `A tag named “${existing.displayLabel}” already exists.`,
          );
        }
        const created = await insertTag(displayLabel);
        return { id: created.id, label: created.displayLabel };
      }),

    rename: (tagId, rawLabel) =>
      transactions.runInTransaction(async () => {
        const displayLabel = toDisplayLabel(rawLabel, 'Tag');
        const normalizedLabel = toNormalizedLabel(displayLabel);
        await requireTag(tagId);
        const clash = await tags.findByNormalizedLabel(workspaceId, normalizedLabel);
        if (clash !== null && clash.id !== tagId) {
          throw new DomainError('DUPLICATE', `A tag named “${clash.displayLabel}” already exists.`);
        }
        // Renaming only changes the label: every node keeps its assignment.
        await tags.rename(workspaceId, tagId, displayLabel, normalizedLabel, clock.now());
        return { id: tagId, label: displayLabel };
      }),

    delete: (tagId) =>
      transactions.runInTransaction(async () => {
        await requireTag(tagId);
        await tags.delete(workspaceId, tagId);
      }),

    assignToNode: (nodeId, rawLabel) =>
      transactions.runInTransaction(async () => {
        const displayLabel = toDisplayLabel(rawLabel, 'Tag');
        await requireNode(nodeId);
        const tag =
          (await tags.findByNormalizedLabel(workspaceId, toNormalizedLabel(displayLabel))) ??
          (await insertTag(displayLabel));
        await tags.attach(workspaceId, nodeId, tag.id, clock.now());
        return tagsOfNode(nodeId);
      }),

    removeFromNode: (nodeId, tagId) =>
      transactions.runInTransaction(async () => {
        await requireNode(nodeId);
        await tags.detach(workspaceId, nodeId, tagId);
        return tagsOfNode(nodeId);
      }),
  };
}
