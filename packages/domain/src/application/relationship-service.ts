/**
 * Application service for typed semantic relationships and their types (PRD §4.2, §5.5).
 *
 * Rules applied here before anything is written (the schema repeats the structural ones):
 * - A relationship connects two distinct nodes of this workspace.
 * - Directed relationships keep the user's direction; the reverse direction is a different
 *   relationship. Undirected relationships are stored in canonical order, so A–B and B–A are the
 *   same relationship and a reversed duplicate is rejected.
 * - The same endpoints, type and direction may exist only once; different types are allowed.
 * - Archived types keep their existing relationships but cannot be chosen for new ones.
 * - A type's directionality can change only while no relationship uses it. Otherwise the user
 *   creates a new type: the PRD offers that or a migration flow, and a new type is simpler and
 *   never reinterprets existing data.
 * Nothing here creates relationships implicitly: wikilinks and map structure never do (PRD §4.3).
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type {
  IdGenerator,
  NodeId,
  RelationshipId,
  RelationshipTypeId,
  TimelineEventId,
  WorkspaceId,
} from '../ids';
import {
  toStoredEndpoints,
  type RelationshipDirectionality,
} from '../knowledge/relationship-rules';
import type {
  KnowledgeNodeRecord,
  KnowledgeNodeRepository,
  RelationshipDetails,
  RelationshipRecord,
  RelationshipRepository,
  RelationshipTypeRecord,
  RelationshipTypeRepository,
  TimelineEventRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';
import { toDisplayLabel, toNormalizedLabel } from '../text/labels';

export const MAX_RELATIONSHIP_DESCRIPTION_LENGTH = 1_000;

export interface RelationshipServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly relationships: RelationshipRepository;
  readonly types: RelationshipTypeRepository;
  readonly nodes: KnowledgeNodeRepository;
  readonly timeline: TimelineEventRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface RelationshipTypeView {
  readonly id: RelationshipTypeId;
  readonly label: string;
  readonly directionality: RelationshipDirectionality;
  readonly isArchived: boolean;
  readonly isBuiltin: boolean;
  /** Number of relationships using the type. */
  readonly usageCount: number;
}

export interface RelationshipView {
  readonly id: RelationshipId;
  readonly typeId: RelationshipTypeId;
  readonly typeLabel: string;
  readonly directionality: RelationshipDirectionality;
  readonly description: string | null;
  readonly source: { readonly id: NodeId; readonly title: string };
  readonly target: { readonly id: NodeId; readonly title: string };
  readonly createdAt: string;
}

export interface NewRelationship {
  readonly sourceNodeId: NodeId;
  readonly targetNodeId: NodeId;
  readonly typeId: RelationshipTypeId;
  readonly description?: string | null;
}

export interface RelationshipChanges {
  readonly typeId?: RelationshipTypeId;
  readonly description?: string | null;
  /** Reverses source and target of a directed relationship. Ignored for undirected ones. */
  readonly reverseDirection?: boolean;
}

export interface RelationshipService {
  listTypes(): Promise<readonly RelationshipTypeView[]>;
  createType(
    rawLabel: string,
    directionality: RelationshipDirectionality,
  ): Promise<RelationshipTypeView>;
  renameType(typeId: RelationshipTypeId, rawLabel: string): Promise<RelationshipTypeView>;
  setTypeArchived(typeId: RelationshipTypeId, archived: boolean): Promise<RelationshipTypeView>;
  changeTypeDirectionality(
    typeId: RelationshipTypeId,
    directionality: RelationshipDirectionality,
  ): Promise<RelationshipTypeView>;
  listForNode(nodeId: NodeId): Promise<readonly RelationshipView[]>;
  create(input: NewRelationship): Promise<RelationshipView>;
  update(relationshipId: RelationshipId, changes: RelationshipChanges): Promise<RelationshipView>;
  delete(relationshipId: RelationshipId): Promise<void>;
}

/** Trims a description; empty becomes null. @throws DomainError when too long. */
export function normalizeRelationshipDescription(raw: string | null | undefined): string | null {
  const description = (raw ?? '').normalize('NFC').trim();
  if (description.length === 0) return null;
  if (description.length > MAX_RELATIONSHIP_DESCRIPTION_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Descriptions can be at most ${MAX_RELATIONSHIP_DESCRIPTION_LENGTH} characters long.`,
    );
  }
  return description;
}

export function createRelationshipService(
  dependencies: RelationshipServiceDependencies,
): RelationshipService {
  const { workspaceId, transactions, relationships, types, nodes, timeline, ids, clock } =
    dependencies;

  async function requireType(typeId: RelationshipTypeId): Promise<RelationshipTypeRecord> {
    const type = await types.findById(workspaceId, typeId);
    if (type === null) {
      throw new DomainError('NOT_FOUND', 'This relationship type no longer exists.');
    }
    return type;
  }

  async function requireNode(nodeId: NodeId): Promise<KnowledgeNodeRecord> {
    const node = await nodes.findById(workspaceId, nodeId);
    if (node === null) {
      throw new DomainError('NOT_FOUND', 'One of the nodes no longer exists.');
    }
    return node;
  }

  async function requireRelationship(relationshipId: RelationshipId): Promise<RelationshipRecord> {
    const relationship = await relationships.findById(workspaceId, relationshipId);
    if (relationship === null) {
      throw new DomainError('NOT_FOUND', 'This relationship no longer exists.');
    }
    return relationship;
  }

  async function typeView(type: RelationshipTypeRecord): Promise<RelationshipTypeView> {
    const usage = await types.countUsage(workspaceId);
    return toTypeView(type, usage.get(type.id) ?? 0);
  }

  /** Rejects a duplicate of `candidate` (same stored endpoints and type), ignoring `ignoreId`. */
  async function assertNotDuplicate(
    candidate: RelationshipRecord,
    typeLabel: string,
    ignoreId?: RelationshipId,
  ): Promise<void> {
    const existing = await relationships.findByEndpoints(
      workspaceId,
      candidate.sourceNodeId,
      candidate.targetNodeId,
      candidate.typeId,
    );
    if (existing !== null && existing.id !== ignoreId) {
      throw new DomainError(
        'DUPLICATE',
        candidate.directionality === 'directed'
          ? `These nodes already have a “${typeLabel}” relationship in this direction.`
          : `These nodes are already connected by “${typeLabel}”.`,
      );
    }
  }

  async function viewOf(relationshipId: RelationshipId, nodeId: NodeId): Promise<RelationshipView> {
    const details = (await relationships.listForNode(workspaceId, nodeId)).find(
      (item) => item.id === relationshipId,
    );
    if (details === undefined) {
      throw new DomainError('NOT_FOUND', 'This relationship no longer exists.');
    }
    return toView(details);
  }

  return {
    listTypes: async () => {
      const [records, usage] = await Promise.all([
        types.listByWorkspace(workspaceId),
        types.countUsage(workspaceId),
      ]);
      return records.map((record) => toTypeView(record, usage.get(record.id) ?? 0));
    },

    createType: (rawLabel, directionality) =>
      transactions.runInTransaction(async () => {
        const label = toDisplayLabel(rawLabel, 'Relationship type');
        const normalizedLabel = toNormalizedLabel(label);
        const clash = await types.findByNormalizedLabel(workspaceId, normalizedLabel);
        if (clash !== null) {
          throw new DomainError(
            'DUPLICATE',
            `A relationship type named “${clash.label}” already exists.`,
          );
        }
        const now = clock.now();
        const record: RelationshipTypeRecord = {
          id: ids.newId() as RelationshipTypeId,
          workspaceId,
          label,
          normalizedLabel,
          directionality,
          isArchived: false,
          isBuiltin: false,
          createdAt: now,
          updatedAt: now,
        };
        await types.insert(record);
        return toTypeView(record, 0);
      }),

    renameType: (typeId, rawLabel) =>
      transactions.runInTransaction(async () => {
        const type = await requireType(typeId);
        const label = toDisplayLabel(rawLabel, 'Relationship type');
        const normalizedLabel = toNormalizedLabel(label);
        const clash = await types.findByNormalizedLabel(workspaceId, normalizedLabel);
        if (clash !== null && clash.id !== typeId) {
          throw new DomainError(
            'DUPLICATE',
            `A relationship type named “${clash.label}” already exists.`,
          );
        }
        const updated = { ...type, label, normalizedLabel, updatedAt: clock.now() };
        await types.update(updated);
        return typeView(updated);
      }),

    setTypeArchived: (typeId, archived) =>
      transactions.runInTransaction(async () => {
        const updated = {
          ...(await requireType(typeId)),
          isArchived: archived,
          updatedAt: clock.now(),
        };
        await types.update(updated);
        return typeView(updated);
      }),

    changeTypeDirectionality: (typeId, directionality) =>
      transactions.runInTransaction(async () => {
        const type = await requireType(typeId);
        const usageCount = (await types.countUsage(workspaceId)).get(typeId) ?? 0;
        if (type.directionality !== directionality && usageCount > 0) {
          throw new DomainError(
            'INVARIANT_VIOLATION',
            `“${type.label}” is used by ${usageCount} relationship${usageCount === 1 ? '' : 's'}, so ` +
              'its direction cannot change. Create a new relationship type instead.',
          );
        }
        const updated = { ...type, directionality, updatedAt: clock.now() };
        await types.update(updated);
        return toTypeView(updated, usageCount);
      }),

    listForNode: async (nodeId) => {
      await requireNode(nodeId);
      return (await relationships.listForNode(workspaceId, nodeId)).map(toView);
    },

    create: (input) =>
      transactions.runInTransaction(async () => {
        const description = normalizeRelationshipDescription(input.description);
        const type = await requireType(input.typeId);
        if (type.isArchived) {
          throw new DomainError(
            'VALIDATION_FAILED',
            `“${type.label}” is archived and cannot be used for new relationships.`,
          );
        }
        const endpoints = toStoredEndpoints(
          { sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId },
          type.directionality,
        );
        const source = await requireNode(input.sourceNodeId);
        await requireNode(input.targetNodeId);

        const now = clock.now();
        const record: RelationshipRecord = {
          id: ids.newId() as RelationshipId,
          workspaceId,
          ...endpoints,
          typeId: type.id,
          directionality: type.directionality,
          description,
          createdAt: now,
          updatedAt: now,
        };
        await assertNotDuplicate(record, type.label);
        await relationships.insert(record);
        // PRD §5.9: relationship creation is recorded learning activity, attributed to the
        // relationship's source node (for undirected types, the canonical first endpoint).
        await timeline.insert({
          id: ids.newId() as TimelineEventId,
          workspaceId,
          nodeId: source.id,
          nodeTitleSnapshot: source.title,
          eventType: 'relationship_created',
          occurredAt: now,
          lastActivityAt: now,
          reflection: null,
          isImported: false,
          importOrigin: null,
          learnedAt: null,
          title: null,
        });
        return viewOf(record.id, source.id);
      }),

    update: (relationshipId, changes) =>
      transactions.runInTransaction(async () => {
        const current = await requireRelationship(relationshipId);
        const description =
          changes.description === undefined
            ? current.description
            : normalizeRelationshipDescription(changes.description);
        const type = await requireType(changes.typeId ?? current.typeId);
        if (type.id !== current.typeId && type.isArchived) {
          throw new DomainError(
            'VALIDATION_FAILED',
            `“${type.label}” is archived and cannot be used for new relationships.`,
          );
        }
        const reverse = changes.reverseDirection === true && type.directionality === 'directed';
        const endpoints = toStoredEndpoints(
          reverse
            ? { sourceNodeId: current.targetNodeId, targetNodeId: current.sourceNodeId }
            : { sourceNodeId: current.sourceNodeId, targetNodeId: current.targetNodeId },
          type.directionality,
        );
        const updated: RelationshipRecord = {
          ...current,
          ...endpoints,
          typeId: type.id,
          directionality: type.directionality,
          description,
          updatedAt: clock.now(),
        };
        await assertNotDuplicate(updated, type.label, relationshipId);
        await relationships.update(updated);
        return viewOf(relationshipId, updated.sourceNodeId);
      }),

    delete: (relationshipId) =>
      transactions.runInTransaction(async () => {
        await requireRelationship(relationshipId);
        await relationships.delete(workspaceId, relationshipId);
      }),
  };
}

function toTypeView(record: RelationshipTypeRecord, usageCount: number): RelationshipTypeView {
  return {
    id: record.id,
    label: record.label,
    directionality: record.directionality,
    isArchived: record.isArchived,
    isBuiltin: record.isBuiltin,
    usageCount,
  };
}

function toView(details: RelationshipDetails): RelationshipView {
  return {
    id: details.id,
    typeId: details.typeId,
    typeLabel: details.typeLabel,
    directionality: details.directionality,
    description: details.description,
    source: { id: details.sourceNodeId, title: details.sourceTitle },
    target: { id: details.targetNodeId, title: details.targetTitle },
    createdAt: details.createdAt,
  };
}
