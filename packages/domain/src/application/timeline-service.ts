/**
 * Learning timeline (PRD §5.9).
 *
 * The timeline shows recorded activity, newest first: node creation, editing sessions of notes
 * (grouped by the node service, 30 minutes of inactivity end a session), relationship creation,
 * and "reviewed" events the user adds explicitly, optionally with a short reflection. It is a
 * record of what happened, not a measure of understanding: nothing here infers or scores.
 *
 * Dates: events are stored in UTC. Date-range filters are given as calendar dates in the
 * workspace's timezone and converted to UTC bounds here, so "27 March" means the user's 27 March
 * even on days with a daylight-saving change.
 *
 * Only "reviewed" events belong to the user: their reflection can be edited and they can be
 * deleted. Recorded activity (creation, edits, relationships) cannot be changed or removed.
 */

import type { Clock } from '../clock';
import { DomainError } from '../errors';
import type { IdGenerator, NodeId, TagId, TimelineEventId, WorkspaceId } from '../ids';
import type { Page, PageRequest } from '../ports/pagination';
import type {
  KnowledgeNodeRepository,
  TimelineEntryRecord,
  TimelineEventRepository,
  TimelineEventType,
  WorkspaceRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';
import { localDateRangeToUtc } from '../timeline/time-zone';

export const MAX_REFLECTION_LENGTH = 2_000;

export interface TimelineServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly timeline: TimelineEventRepository;
  readonly nodes: KnowledgeNodeRepository;
  readonly workspaces: WorkspaceRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface TimelineQuery {
  /** First local date to include ('YYYY-MM-DD' in the workspace timezone), or null. */
  readonly fromDate: string | null;
  /** Last local date to include, or null. */
  readonly toDate: string | null;
  readonly eventTypes: readonly TimelineEventType[];
  readonly tagIds: readonly TagId[];
  readonly nodeId: NodeId | null;
  readonly page: PageRequest;
}

export interface TimelineService {
  list(query: TimelineQuery): Promise<Page<TimelineEntryRecord>>;
  /** Records that the user reviewed a node, with an optional reflection. */
  markReviewed(nodeId: NodeId, reflection: string | null): Promise<TimelineEntryRecord>;
  updateReflection(
    eventId: TimelineEventId,
    reflection: string | null,
  ): Promise<TimelineEntryRecord>;
  deleteReviewed(eventId: TimelineEventId): Promise<void>;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the intent.
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/**
 * Normalizes a reflection: trims, treats empty as "no reflection", keeps line breaks and tabs,
 * and rejects other control characters and text over 2,000 characters.
 */
export function normalizeReflection(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.normalize('NFC').replaceAll('\r\n', '\n').trim();
  if (text.length === 0) return null;
  if (text.length > MAX_REFLECTION_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Reflections can be at most ${MAX_REFLECTION_LENGTH} characters long.`,
    );
  }
  if (DISALLOWED_CONTROL.test(text)) {
    throw new DomainError('VALIDATION_FAILED', 'The reflection contains unsupported characters.');
  }
  return text;
}

export function createTimelineService(dependencies: TimelineServiceDependencies): TimelineService {
  const { workspaceId, transactions, timeline, nodes, workspaces, ids, clock } = dependencies;

  async function requireReviewed(eventId: TimelineEventId) {
    const event = await timeline.findById(workspaceId, eventId);
    if (event === null) {
      throw new DomainError('NOT_FOUND', 'This timeline entry no longer exists.');
    }
    if (event.eventType !== 'reviewed') {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'Only your own review entries can be changed; recorded activity stays as it happened.',
      );
    }
    return event;
  }

  /** The stored event with the node's current title, as the list returns it. */
  async function entryOf(eventId: TimelineEventId): Promise<TimelineEntryRecord> {
    const event = await timeline.findById(workspaceId, eventId);
    if (event === null) {
      throw new DomainError('NOT_FOUND', 'This timeline entry no longer exists.');
    }
    const node = event.nodeId === null ? null : await nodes.findById(workspaceId, event.nodeId);
    return { ...event, currentNodeTitle: node?.title ?? null };
  }

  return {
    list: async (query) => {
      const workspace = await workspaces.findById(workspaceId);
      if (workspace === null) {
        throw new DomainError('NOT_FOUND', 'This workspace could not be found.');
      }
      const range = localDateRangeToUtc(query.fromDate, query.toDate, workspace.timezone);
      return timeline.list(workspaceId, {
        fromUtc: range.fromUtc,
        toUtcExclusive: range.toUtcExclusive,
        eventTypes: [...new Set(query.eventTypes)],
        tagIds: [...new Set(query.tagIds)],
        nodeId: query.nodeId,
        page: query.page,
      });
    },

    markReviewed: (nodeId, rawReflection) =>
      transactions.runInTransaction(async () => {
        const reflection = normalizeReflection(rawReflection);
        const node = await nodes.findById(workspaceId, nodeId);
        if (node === null) {
          throw new DomainError('NOT_FOUND', 'This node no longer exists.');
        }
        const now = clock.now();
        const id = ids.newId() as TimelineEventId;
        await timeline.insert({
          id,
          workspaceId,
          nodeId,
          nodeTitleSnapshot: node.title,
          eventType: 'reviewed',
          occurredAt: now,
          lastActivityAt: now,
          reflection,
          isImported: false,
          importOrigin: null,
        });
        return entryOf(id);
      }),

    updateReflection: (eventId, rawReflection) =>
      transactions.runInTransaction(async () => {
        const reflection = normalizeReflection(rawReflection);
        await requireReviewed(eventId);
        await timeline.updateReflection(workspaceId, eventId, reflection);
        return entryOf(eventId);
      }),

    deleteReviewed: (eventId) =>
      transactions.runInTransaction(async () => {
        await requireReviewed(eventId);
        await timeline.delete(workspaceId, eventId);
      }),
  };
}
