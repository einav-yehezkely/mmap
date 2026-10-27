/**
 * Application service for knowledge nodes in one workspace (PRD §5.2).
 *
 * Responsibilities:
 * - Validate input (titles, summaries, note documents) before anything is written.
 * - Keep the note JSON and its derived plain text consistent: both are written in the same
 *   transaction from the same validated document (PRD §5.3, §14).
 * - Enforce optimistic revisions: an update or delete based on an outdated revision fails with
 *   `REVISION_CONFLICT` and changes nothing, so a stale window cannot silently overwrite newer
 *   content (PRD §5.2, §13 criterion 13).
 * - Record timeline events for explicit node creation (PRD §5.9).
 *
 * The service is bound to one workspace ID; every repository call is scoped to it.
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { IdGenerator, NodeId, TagId, TimelineEventId, WorkspaceId } from '../ids';
import { duplicateTitle, normalizeNodeSummary, normalizeNodeTitle } from '../knowledge/node-fields';
import {
  emptyNoteDocument,
  NOTE_SCHEMA_VERSION,
  parseNoteDocument,
  type NoteDocument,
} from '../notes/note-document';
import { extractNoteReferences } from '../notes/note-references';
import { extractPlainText } from '../notes/plain-text';
import { clampPageSize, type PageRequest } from '../ports/pagination';
import type {
  BacklinkRecord,
  KnowledgeNodeRecord,
  KnowledgeNodeRepository,
  KnowledgeNodeSummary,
  NodeDependents,
  NoteReferenceRepository,
  NodeSortOrder,
  Revision,
  TagRepository,
  TagSummary,
  TimelineEventRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';
import { continuesEditingSession } from '../timeline/editing-session';

export interface KnowledgeNodeServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly nodes: KnowledgeNodeRepository;
  readonly timeline: TimelineEventRepository;
  readonly tags: TagRepository;
  readonly references: NoteReferenceRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** A node as presented to callers: the note is a parsed document, not a JSON string. */
export interface KnowledgeNodeView {
  readonly id: NodeId;
  readonly title: string;
  readonly summary: string | null;
  readonly note: NoteDocument;
  readonly revision: Revision;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Tags sorted by label. Tag changes go through the tag service and do not bump the revision. */
  readonly tags: readonly TagSummary[];
}

export interface NodeListItem extends KnowledgeNodeSummary {
  readonly tags: readonly TagSummary[];
}

export interface NodeListResult {
  readonly items: readonly NodeListItem[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface NodeChanges {
  readonly title?: string;
  readonly summary?: string | null;
  /** Untrusted note JSON; validated with `parseNoteDocument`. */
  readonly note?: unknown;
}

export interface KnowledgeNodeService {
  create(input: { title: string; summary?: string | null }): Promise<KnowledgeNodeView>;
  get(nodeId: NodeId): Promise<KnowledgeNodeView>;
  list(query: {
    sort: NodeSortOrder;
    page: PageRequest;
    tagIds?: readonly TagId[];
  }): Promise<NodeListResult>;
  update(
    nodeId: NodeId,
    expectedRevision: Revision,
    changes: NodeChanges,
  ): Promise<KnowledgeNodeView>;
  duplicate(nodeId: NodeId): Promise<KnowledgeNodeView>;
  previewDelete(nodeId: NodeId): Promise<NodeDependents>;
  delete(nodeId: NodeId, expectedRevision: Revision): Promise<void>;
  /** Notes that link to this node, with an excerpt around the link (PRD §5.4). */
  backlinks(nodeId: NodeId): Promise<readonly BacklinkRecord[]>;
  /**
   * Current titles of the given link targets that still exist. Targets missing from the result
   * are shown as unresolved links with a repair action (PRD §5.4).
   */
  resolveLinkTargets(
    nodeIds: readonly NodeId[],
  ): Promise<readonly { readonly id: NodeId; readonly title: string }[]>;
}

export function createKnowledgeNodeService(
  dependencies: KnowledgeNodeServiceDependencies,
): KnowledgeNodeService {
  const { workspaceId, transactions, nodes, timeline, tags, references, ids, clock } = dependencies;

  /**
   * Rebuilds the derived note references of a node from its note, in the caller's transaction,
   * so references never diverge from the saved note (PRD §14).
   */
  async function reconcileReferences(nodeId: NodeId, note: NoteDocument): Promise<void> {
    await references.replaceForSource(
      workspaceId,
      nodeId,
      extractNoteReferences(note).map((reference) => ({
        ...reference,
        targetNodeId: reference.targetNodeId as NodeId,
      })),
    );
  }

  async function toView(record: KnowledgeNodeRecord): Promise<KnowledgeNodeView> {
    const nodeTags = (await tags.listForNodes(workspaceId, [record.id])).get(record.id) ?? [];
    return { ...toViewWithoutTags(record), tags: nodeTags };
  }

  async function requireNode(nodeId: NodeId): Promise<KnowledgeNodeRecord> {
    const record = await nodes.findById(workspaceId, nodeId);
    if (record === null) {
      throw new DomainError('NOT_FOUND', 'This node no longer exists.');
    }
    return record;
  }

  function assertRevision(record: KnowledgeNodeRecord, expectedRevision: Revision): void {
    if (record.revision !== expectedRevision) {
      throw revisionConflict();
    }
  }

  /** Inserts a new node and its `node_created` timeline event in the current transaction. */
  async function insertNode(fields: {
    title: string;
    summary: string | null;
    note: NoteDocument;
  }): Promise<KnowledgeNodeRecord> {
    const now = clock.now();
    const record: KnowledgeNodeRecord = {
      id: ids.newId() as NodeId,
      workspaceId,
      title: fields.title,
      summary: fields.summary,
      noteJson: JSON.stringify(fields.note),
      noteSchemaVersion: NOTE_SCHEMA_VERSION,
      notePlainText: extractPlainText(fields.note),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await nodes.insert(record);
    await reconcileReferences(record.id, fields.note);
    await timeline.insert({
      id: ids.newId() as TimelineEventId,
      workspaceId,
      nodeId: record.id,
      nodeTitleSnapshot: record.title,
      eventType: 'node_created',
      occurredAt: now,
      lastActivityAt: now,
      reflection: null,
      isImported: false,
      importOrigin: null,
      learnedAt: null,
      title: null,
    });
    return record;
  }

  /**
   * Records a substantive note update in the timeline, grouping saves of one editing session into
   * a single event (PRD §5.9). Title or summary changes alone are not recorded.
   */
  async function recordNoteActivity(node: KnowledgeNodeRecord): Promise<void> {
    const latest = await timeline.findLatestForNode(workspaceId, node.id, 'note_updated');
    if (latest !== null && continuesEditingSession(latest.lastActivityAt, node.updatedAt)) {
      await timeline.extendSession(workspaceId, latest.id, node.updatedAt, node.title);
      return;
    }
    await timeline.insert({
      id: ids.newId() as TimelineEventId,
      workspaceId,
      nodeId: node.id,
      nodeTitleSnapshot: node.title,
      eventType: 'note_updated',
      occurredAt: node.updatedAt,
      lastActivityAt: node.updatedAt,
      reflection: null,
      isImported: false,
      importOrigin: null,
      learnedAt: null,
      title: null,
    });
  }

  return {
    create: ({ title, summary = null }) =>
      transactions.runInTransaction(async () =>
        toView(
          await insertNode({
            title: normalizeNodeTitle(title),
            summary: normalizeNodeSummary(summary),
            note: emptyNoteDocument(),
          }),
        ),
      ),

    get: async (nodeId) => toView(await requireNode(nodeId)),

    list: async ({ sort, page, tagIds = [] }) => {
      const result = await nodes.list(workspaceId, {
        sort,
        page: { limit: clampPageSize(page.limit), cursor: page.cursor },
        tagIds,
      });
      const tagsByNode = await tags.listForNodes(
        workspaceId,
        result.items.map((item) => item.id),
      );
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, tags: tagsByNode.get(item.id) ?? [] })),
      };
    },

    update: (nodeId, expectedRevision, changes) =>
      transactions.runInTransaction(async () => {
        // Validate everything before reading or writing, so invalid input never touches storage.
        const title = changes.title === undefined ? undefined : normalizeNodeTitle(changes.title);
        const summary =
          changes.summary === undefined ? undefined : normalizeNodeSummary(changes.summary);
        const note = changes.note === undefined ? undefined : parseNoteDocument(changes.note);

        const current = await requireNode(nodeId);
        assertRevision(current, expectedRevision);

        const next: KnowledgeNodeRecord = {
          ...current,
          title: title ?? current.title,
          summary: summary === undefined ? current.summary : summary,
          ...(note === undefined
            ? {}
            : {
                noteJson: JSON.stringify(note),
                noteSchemaVersion: NOTE_SCHEMA_VERSION,
                notePlainText: extractPlainText(note),
              }),
          revision: current.revision + 1,
          updatedAt: clock.now(),
        };
        if (next.noteJson !== current.noteJson) {
          await recordNoteActivity(next);
        }
        if (!(await nodes.update(next, expectedRevision))) {
          // Cannot happen while local writes are serialized; guards adapters that allow
          // concurrent writers (e.g. a future server).
          throw revisionConflict();
        }
        if (note !== undefined) {
          // Removed links disappear from the targets' backlinks with this save (PRD §5.4).
          await reconcileReferences(nodeId, note);
        }
        return toView(next);
      }),

    duplicate: (nodeId) =>
      transactions.runInTransaction(async () => {
        const source = await toView(await requireNode(nodeId));
        // Copies content, tags and the note's outgoing links (the copy's references are derived
        // from its note like any other). Relationships and map placements are not duplicated:
        // they describe the original node's identity and position (PRD §4).
        const copy = await insertNode({
          title: duplicateTitle(source.title),
          summary: source.summary,
          note: source.note,
        });
        for (const tag of source.tags) {
          await tags.attach(workspaceId, copy.id, tag.id, copy.createdAt);
        }
        return toView(copy);
      }),

    previewDelete: async (nodeId) => {
      await requireNode(nodeId);
      return nodes.countDependents(workspaceId, nodeId);
    },

    backlinks: async (nodeId) => {
      await requireNode(nodeId);
      return references.listBacklinks(workspaceId, nodeId);
    },

    resolveLinkTargets: async (nodeIds) => {
      const titles = await nodes.findTitles(workspaceId, [...new Set(nodeIds)]);
      return [...titles].map(([id, title]) => ({ id, title }));
    },

    delete: (nodeId, expectedRevision) =>
      transactions.runInTransaction(async () => {
        assertRevision(await requireNode(nodeId), expectedRevision);
        await nodes.delete(workspaceId, nodeId);
      }),
  };
}

function revisionConflict(): DomainError {
  return new DomainError(
    'REVISION_CONFLICT',
    'This node was changed in another window. Review the latest version before saving.',
  );
}

function toViewWithoutTags(record: KnowledgeNodeRecord): Omit<KnowledgeNodeView, 'tags'> {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    // Stored notes were validated on write; parsing again guards against a tampered database
    // file and keeps the returned object a fresh, plain structure.
    note: parseNoteDocument(JSON.parse(record.noteJson)),
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
