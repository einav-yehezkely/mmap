/**
 * Learning timeline (PRD §5.9).
 *
 * The timeline shows recorded activity: node creation, editing sessions of notes (grouped by the
 * node service, 30 minutes of inactivity end a session), relationship creation, "reviewed" events
 * and learning milestones the user adds by hand. It is a record of what happened, not a measure of
 * understanding: nothing here infers or scores.
 *
 * Two times per event:
 * - \`occurredAt\` is when the action was recorded. It never changes.
 * - \`learnedAt\` is an optional moment when the learning actually happened, chosen by the user
 *   (for example, a review recorded today of something learned last week). It is an annotation,
 *   allowed on any event; the timeline places each event at its effective time,
 *   \`learnedAt ?? occurredAt\`.
 *
 * Dates: events are stored in UTC. Date-range filters are given as calendar dates in the
 * workspace's timezone and converted to UTC bounds here, so "27 March" means the user's 27 March
 * even on days with a daylight-saving change.
 *
 * Ownership: reviews and milestones belong to the user, so their title and reflection can be
 * edited and they can be deleted. Recorded activity cannot be changed or removed.
 */

import type { Clock, UtcTimestamp } from '../clock';
import { DomainError } from '../errors';
import type { IdGenerator, NodeId, TagId, TimelineEventId, WorkspaceId } from '../ids';
import type { Page, PageRequest } from '../ports/pagination';
import {
  USER_OWNED_EVENT_TYPES,
  type KnowledgeNodeRepository,
  type TimelineEntryRecord,
  type TimelineEventChanges,
  type TimelineEventRecord,
  type TimelineEventRepository,
  type TimelineEventType,
  type WorkspaceRepository,
} from '../ports/repositories';
import type { TransactionRunner } from '../ports/transaction';
import { localDateRangeToUtc } from '../timeline/time-zone';

export const MAX_REFLECTION_LENGTH = 2_000;
export const MAX_MILESTONE_TITLE_LENGTH = 200;
/** Most events returned for one window of the visual timeline. */
export const MAX_TIMELINE_WINDOW_EVENTS = 2_000;
/** Learning dates before this are almost certainly typing mistakes. */
const EARLIEST_LEARNED_AT = Date.parse('1900-01-01T00:00:00.000Z');
/** Tolerated clock difference when checking that a learning date is not in the future. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface TimelineServiceDependencies {
  readonly workspaceId: WorkspaceId;
  readonly transactions: TransactionRunner;
  readonly timeline: TimelineEventRepository;
  readonly nodes: KnowledgeNodeRepository;
  readonly workspaces: WorkspaceRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export interface TimelineFilterInput {
  readonly eventTypes: readonly TimelineEventType[];
  readonly tagIds: readonly TagId[];
  readonly nodeId: NodeId | null;
}

export interface TimelineQuery extends TimelineFilterInput {
  /** First local date to include ('YYYY-MM-DD' in the workspace timezone), or null. */
  readonly fromDate: string | null;
  /** Last local date to include, or null. */
  readonly toDate: string | null;
  readonly page: PageRequest;
}

export interface TimelineWindowInput extends TimelineFilterInput {
  /** Window of the visual timeline, as UTC instants (half-open). */
  readonly fromUtc: string;
  readonly toUtcExclusive: string;
}

export interface TimelineWindow {
  /** Oldest first, at most MAX_TIMELINE_WINDOW_EVENTS. */
  readonly items: readonly TimelineEntryRecord[];
  /** Events in the window; more than \`items.length\` means the window was truncated. */
  readonly total: number;
}

export interface NewMilestone {
  readonly title: string;
  readonly details: string | null;
  readonly nodeId: NodeId | null;
  /** When the learning happened; null means now. */
  readonly learnedAt: string | null;
}

export interface TimelineEntryChanges {
  readonly title?: string;
  readonly reflection?: string | null;
  /** Null clears it (the event is then placed at its recorded time again). */
  readonly learnedAt?: string | null;
}

export interface TimelineService {
  list(query: TimelineQuery): Promise<Page<TimelineEntryRecord>>;
  /** Events in a time window, for the visual timeline. */
  window(input: TimelineWindowInput): Promise<TimelineWindow>;
  /** Records that the user reviewed a node, with an optional reflection and learning date. */
  markReviewed(
    nodeId: NodeId,
    reflection: string | null,
    learnedAt?: string | null,
  ): Promise<TimelineEntryRecord>;
  /** Adds a learning milestone, optionally about one node. */
  addMilestone(input: NewMilestone): Promise<TimelineEntryRecord>;
  /**
   * Edits an entry. Title and reflection only on the user's own entries (reviews, milestones);
   * the learning date on any entry, since it annotates rather than changes the record.
   */
  updateEntry(
    eventId: TimelineEventId,
    changes: TimelineEntryChanges,
  ): Promise<TimelineEntryRecord>;
  /** Deletes one of the user's own entries (a review or a milestone). */
  deleteEntry(eventId: TimelineEventId): Promise<void>;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the intent.
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- matching control characters is the intent.
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

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

/** Normalizes a milestone title: one line, required, at most 200 characters. */
export function normalizeMilestoneTitle(raw: string): string {
  const title = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (title.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'A milestone needs a title.');
  }
  if (title.length > MAX_MILESTONE_TITLE_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Milestone titles can be at most ${MAX_MILESTONE_TITLE_LENGTH} characters long.`,
    );
  }
  if (ANY_CONTROL.test(title)) {
    throw new DomainError('VALIDATION_FAILED', 'The title contains unsupported characters.');
  }
  return title;
}

/** Parses a UTC instant from the renderer into the storage format. */
function parseInstant(raw: string, what: string): UtcTimestamp {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new DomainError('VALIDATION_FAILED', `The ${what} is not a valid date and time.`);
  }
  const iso = new Date(ms).toISOString();
  if (!UTC_TIMESTAMP.test(iso)) {
    throw new DomainError('VALIDATION_FAILED', `The ${what} is outside the supported range.`);
  }
  return iso as UtcTimestamp;
}

export function createTimelineService(dependencies: TimelineServiceDependencies): TimelineService {
  const { workspaceId, transactions, timeline, nodes, workspaces, ids, clock } = dependencies;

  /** A learning date: a real instant, not in the future, not absurdly old. */
  function validLearnedAt(raw: string | null | undefined): UtcTimestamp | null {
    if (raw === null || raw === undefined) return null;
    const value = parseInstant(raw, 'learning date');
    const ms = Date.parse(value);
    if (ms > Date.parse(clock.now()) + FUTURE_TOLERANCE_MS) {
      throw new DomainError('VALIDATION_FAILED', 'The learning date cannot be in the future.');
    }
    if (ms < EARLIEST_LEARNED_AT) {
      throw new DomainError('VALIDATION_FAILED', 'The learning date is too far in the past.');
    }
    return value;
  }

  async function requireEvent(eventId: TimelineEventId): Promise<TimelineEventRecord> {
    const event = await timeline.findById(workspaceId, eventId);
    if (event === null) {
      throw new DomainError('NOT_FOUND', 'This timeline entry no longer exists.');
    }
    return event;
  }

  function requireUserOwned(event: TimelineEventRecord): void {
    if (!USER_OWNED_EVENT_TYPES.includes(event.eventType)) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'Only your own reviews and milestones can be changed; recorded activity stays as it happened.',
      );
    }
  }

  /** The stored event with the node's current title, as the list returns it. */
  async function entryOf(eventId: TimelineEventId): Promise<TimelineEntryRecord> {
    const event = await requireEvent(eventId);
    const node = event.nodeId === null ? null : await nodes.findById(workspaceId, event.nodeId);
    return { ...event, currentNodeTitle: node?.title ?? null };
  }

  async function nodeTitle(nodeId: NodeId): Promise<string> {
    const node = await nodes.findById(workspaceId, nodeId);
    if (node === null) {
      throw new DomainError('NOT_FOUND', 'This node no longer exists.');
    }
    return node.title;
  }

  function filtersOf(input: TimelineFilterInput) {
    return {
      eventTypes: [...new Set(input.eventTypes)],
      tagIds: [...new Set(input.tagIds)],
      nodeId: input.nodeId,
    };
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
        ...filtersOf(query),
        page: query.page,
      });
    },

    window: async (input) => {
      const fromUtc = parseInstant(input.fromUtc, 'start of the period');
      const toUtcExclusive = parseInstant(input.toUtcExclusive, 'end of the period');
      if (toUtcExclusive <= fromUtc) {
        throw new DomainError('VALIDATION_FAILED', 'The period ends before it starts.');
      }
      return timeline.window(workspaceId, {
        fromUtc,
        toUtcExclusive,
        ...filtersOf(input),
        limit: MAX_TIMELINE_WINDOW_EVENTS,
      });
    },

    markReviewed: (nodeId, rawReflection, rawLearnedAt) =>
      transactions.runInTransaction(async () => {
        const reflection = normalizeReflection(rawReflection);
        const learnedAt = validLearnedAt(rawLearnedAt);
        const title = await nodeTitle(nodeId);
        const now = clock.now();
        const id = ids.newId() as TimelineEventId;
        await timeline.insert({
          id,
          workspaceId,
          nodeId,
          nodeTitleSnapshot: title,
          eventType: 'reviewed',
          occurredAt: now,
          lastActivityAt: now,
          learnedAt,
          title: null,
          reflection,
          isImported: false,
          importOrigin: null,
        });
        return entryOf(id);
      }),

    addMilestone: (input) =>
      transactions.runInTransaction(async () => {
        const title = normalizeMilestoneTitle(input.title);
        const details = normalizeReflection(input.details);
        const learnedAt = validLearnedAt(input.learnedAt);
        const snapshot = input.nodeId === null ? null : await nodeTitle(input.nodeId);
        const now = clock.now();
        const id = ids.newId() as TimelineEventId;
        await timeline.insert({
          id,
          workspaceId,
          nodeId: input.nodeId,
          nodeTitleSnapshot: snapshot,
          eventType: 'milestone',
          occurredAt: now,
          lastActivityAt: now,
          learnedAt,
          title,
          reflection: details,
          isImported: false,
          importOrigin: null,
        });
        return entryOf(id);
      }),

    updateEntry: (eventId, changes) =>
      transactions.runInTransaction(async () => {
        const event = await requireEvent(eventId);
        const update: { -readonly [K in keyof TimelineEventChanges]: TimelineEventChanges[K] } = {};
        if (changes.title !== undefined || changes.reflection !== undefined) {
          requireUserOwned(event);
        }
        if (changes.title !== undefined) {
          if (event.eventType !== 'milestone') {
            throw new DomainError('VALIDATION_FAILED', 'Only milestones have a title.');
          }
          update.title = normalizeMilestoneTitle(changes.title);
        }
        if (changes.reflection !== undefined) {
          update.reflection = normalizeReflection(changes.reflection);
        }
        if (changes.learnedAt !== undefined) {
          update.learnedAt = validLearnedAt(changes.learnedAt);
        }
        await timeline.update(workspaceId, eventId, update);
        return entryOf(eventId);
      }),

    deleteEntry: (eventId) =>
      transactions.runInTransaction(async () => {
        requireUserOwned(await requireEvent(eventId));
        await timeline.delete(workspaceId, eventId);
      }),
  };
}
