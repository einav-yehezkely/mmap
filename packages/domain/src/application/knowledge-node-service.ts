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
import type { IdGenerator, NodeId, TimelineEventId, WorkspaceId } from '../ids';
import { duplicateTitle, normalizeNodeSummary, normalizeNodeTitle } from '../knowledge/node-fields';
import {
  emptyNoteDocument,
  NOTE_SCHEMA_VERSION,
  parseNoteDocument,
  type NoteDocument,
} from '../notes/note-document';
import { extractPlainText } from '../notes/plain-text';
import { clampPageSize, type PageRequest } from '../ports/pagination';
import type {
  KnowledgeNodeRecord,
  KnowledgeNodeRepository,
  NodeDependents,
  NodeListPage,
  NodeSortOrder,
  Revision,
  TimelineEventRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';

export interface KnowledgeNodeServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly nodes: KnowledgeNodeRepository;
  readonly timeline: TimelineEventRepository;
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
  list(query: { sort: NodeSortOrder; page: PageRequest }): Promise<NodeListPage>;
  update(
    nodeId: NodeId,
    expectedRevision: Revision,
    changes: NodeChanges,
  ): Promise<KnowledgeNodeView>;
  duplicate(nodeId: NodeId): Promise<KnowledgeNodeView>;
  previewDelete(nodeId: NodeId): Promise<NodeDependents>;
  delete(nodeId: NodeId, expectedRevision: Revision): Promise<void>;
}

export function createKnowledgeNodeService(
  dependencies: KnowledgeNodeServiceDependencies,
): KnowledgeNodeService {
  const { workspaceId, transactions, nodes, timeline, ids, clock } = dependencies;

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
    });
    return record;
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

    list: ({ sort, page }) =>
      nodes.list(workspaceId, {
        sort,
        page: { limit: clampPageSize(page.limit), cursor: page.cursor },
      }),

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
        if (!(await nodes.update(next, expectedRevision))) {
          // Cannot happen while local writes are serialized; guards adapters that allow
          // concurrent writers (e.g. a future server).
          throw revisionConflict();
        }
        return toView(next);
      }),

    duplicate: (nodeId) =>
      transactions.runInTransaction(async () => {
        const source = toView(await requireNode(nodeId));
        // Copies content only. Relationships, map placements and references are not duplicated:
        // they describe the original node's identity and position (PRD §4).
        return toView(
          await insertNode({
            title: duplicateTitle(source.title),
            summary: source.summary,
            note: source.note,
          }),
        );
      }),

    previewDelete: async (nodeId) => {
      await requireNode(nodeId);
      return nodes.countDependents(workspaceId, nodeId);
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

function toView(record: KnowledgeNodeRecord): KnowledgeNodeView {
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
