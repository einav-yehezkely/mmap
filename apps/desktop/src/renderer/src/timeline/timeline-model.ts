/**
 * Pure helpers for the timeline (PRD §5.9): effective times, grouping by calendar day in the
 * workspace timezone, describing entries in words, the look of each event type on the axis, and
 * conversions between UTC instants and the local date-time inputs the user edits. Kept free of
 * React for unit tests.
 *
 * Every event has a recorded time (`occurredAt`, when the action happened in mmap) and may have a
 * learning date (`learnedAt`, when the learning actually happened, set by the user). The timeline
 * places an event at its effective time: the learning date when given, otherwise the recorded
 * time.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { localDateOf } from '@mmap/domain';

import type { MarkerInput } from './timeline-axis';

export type EventType = TimelineEntryDto['eventType'];

export interface TimelineDay {
  /** Calendar date in the workspace timezone ('YYYY-MM-DD'). */
  readonly date: string;
  readonly entries: readonly TimelineEntryDto[];
}

/** Where the entry belongs on the timeline. */
export function effectiveTime(entry: TimelineEntryDto): string {
  return entry.learnedAt ?? entry.occurredAt;
}

/** Groups entries (already newest first) by the local date of their effective time. */
export function groupByLocalDay(
  entries: readonly TimelineEntryDto[],
  timeZone: string,
): TimelineDay[] {
  const days: { date: string; entries: TimelineEntryDto[] }[] = [];
  for (const entry of entries) {
    const date = localDateOf(effectiveTime(entry), timeZone);
    const last = days.at(-1);
    if (last !== undefined && last.date === date) last.entries.push(entry);
    else days.push({ date, entries: [entry] });
  }
  return days;
}

/** What happened, in words; the node title (or milestone title) is shown separately. */
export function describeEntry(entry: TimelineEntryDto): string {
  switch (entry.eventType) {
    case 'node_created':
      return 'Created';
    case 'note_updated':
      return 'Edited the note of';
    case 'relationship_created':
      return 'Added a relationship from';
    case 'reviewed':
      return 'Reviewed';
    case 'milestone':
      return 'Milestone:';
  }
}

/** The main text of an entry: the milestone title, otherwise the node title. */
export function entrySubject(entry: TimelineEntryDto): string {
  if (entry.eventType === 'milestone') return entry.title ?? 'Milestone';
  return entry.nodeTitle ?? 'a node';
}

/** True when the entry spans time (an editing session longer than a moment). */
export function isSession(entry: TimelineEntryDto): boolean {
  return entry.eventType === 'note_updated' && entry.lastActivityAt !== entry.occurredAt;
}

/** Reviews and milestones belong to the user: they can be edited and deleted. */
export function isUserOwned(entry: TimelineEntryDto): boolean {
  return entry.eventType === 'reviewed' || entry.eventType === 'milestone';
}

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  node_created: 'Created',
  note_updated: 'Note edits',
  relationship_created: 'Relationships',
  reviewed: 'Reviews',
  milestone: 'Milestones',
};

export type MarkerShape = 'circle' | 'bar' | 'diamond' | 'square' | 'flag';

/**
 * The look of each event type on the axis. Shapes differ as well as colors, so the type never
 * depends on color alone (PRD §6); every marker also has a text label for screen readers.
 */
export const EVENT_STYLES: Record<
  EventType,
  { readonly shape: MarkerShape; readonly color: string }
> = {
  node_created: { shape: 'circle', color: '#60a5fa' },
  note_updated: { shape: 'bar', color: '#94a3b8' },
  relationship_created: { shape: 'diamond', color: '#a78bfa' },
  reviewed: { shape: 'square', color: '#34d399' },
  milestone: { shape: 'flag', color: '#fbbf24' },
};

/**
 * Inputs for the axis layout. Editing sessions span from start to last activity; events with a
 * learning date are a point at that date (the session span belongs to the recorded time).
 */
export function markerInputs(entries: readonly TimelineEntryDto[]): MarkerInput[] {
  return entries.map((entry) => {
    const startMs = Date.parse(effectiveTime(entry));
    const endMs =
      entry.learnedAt === null && isSession(entry) ? Date.parse(entry.lastActivityAt) : startMs;
    return { id: entry.id, startMs, endMs: Math.max(startMs, endMs) };
  });
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    PART_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of an instant in a timezone. */
function wallClock(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** A UTC instant as the value of a `datetime-local` input in the workspace timezone. */
export function toLocalInputValue(utc: string, timeZone: string): string {
  const { year, month, day, hour, minute } = wallClock(Date.parse(utc), timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/**
 * The UTC instant of a `datetime-local` value ('YYYY-MM-DDTHH:mm') read in the workspace
 * timezone, or null when the value is not a valid date and time. On a daylight-saving change, a
 * time that does not exist moves forward, and a time that exists twice takes the earlier instant.
 */
export function fromLocalInputValue(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(wanted)) return null;
  const check = new Date(wanted);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  // Start from "the wall time read as UTC" and correct by the zone offset; two rounds settle it.
  let guess = wanted;
  for (let round = 0; round < 3; round += 1) {
    const local = wallClock(guess, timeZone);
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const difference = wanted - asUtc;
    if (difference === 0) break;
    guess += difference;
  }
  // Prefer the earlier instant when the wall time occurs twice (end of daylight saving).
  const earlier = guess - 60 * 60 * 1_000;
  const earlierLocal = wallClock(earlier, timeZone);
  if (
    Date.UTC(
      earlierLocal.year,
      earlierLocal.month - 1,
      earlierLocal.day,
      earlierLocal.hour,
      earlierLocal.minute,
    ) === wanted
  ) {
    guess = earlier;
  }
  return new Date(guess).toISOString();
}
