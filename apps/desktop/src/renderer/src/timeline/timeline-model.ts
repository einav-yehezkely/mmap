/**
 * Pure helpers for the timeline view (PRD §5.9): grouping entries by calendar day in the
 * workspace timezone and describing each entry in words. Kept free of React for unit tests.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { localDateOf } from '@mmap/domain';

export interface TimelineDay {
  /** Calendar date in the workspace timezone ('YYYY-MM-DD'). */
  readonly date: string;
  readonly entries: readonly TimelineEntryDto[];
}

/**
 * Groups entries (already newest first) by their local date. An editing session belongs to the
 * day it started, matching its position in the list.
 */
export function groupByLocalDay(
  entries: readonly TimelineEntryDto[],
  timeZone: string,
): TimelineDay[] {
  const days: { date: string; entries: TimelineEntryDto[] }[] = [];
  for (const entry of entries) {
    const date = localDateOf(entry.occurredAt, timeZone);
    const last = days.at(-1);
    if (last !== undefined && last.date === date) last.entries.push(entry);
    else days.push({ date, entries: [entry] });
  }
  return days;
}

/** What happened, in words; the node title is shown separately. */
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
  }
}

/** True when the entry spans time (an editing session longer than a moment). */
export function isSession(entry: TimelineEntryDto): boolean {
  return entry.eventType === 'note_updated' && entry.lastActivityAt !== entry.occurredAt;
}

export const EVENT_TYPE_LABELS: Record<TimelineEntryDto['eventType'], string> = {
  node_created: 'Created',
  note_updated: 'Note edits',
  relationship_created: 'Relationships',
  reviewed: 'Reviews',
};
