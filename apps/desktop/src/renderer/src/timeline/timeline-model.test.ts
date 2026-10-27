/**
 * Timeline view model (PRD §5.9): grouping by calendar day in the workspace timezone.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { describe, expect, it } from 'vitest';

import { describeEntry, groupByLocalDay, isSession } from './timeline-model';

function entry(id: string, occurredAt: string, extra: Partial<TimelineEntryDto> = {}) {
  return {
    id,
    eventType: 'node_created',
    occurredAt,
    lastActivityAt: occurredAt,
    nodeId: null,
    nodeTitle: 'Node',
    reflection: null,
    isImported: false,
    ...extra,
  } satisfies TimelineEntryDto;
}

describe('groupByLocalDay', () => {
  it('groups by the calendar day in the workspace timezone, not in UTC', () => {
    const entries = [
      entry('3', '2026-10-27T22:30:00.000Z'), // 28 Oct 00:30 in Jerusalem (UTC+2)
      entry('2', '2026-10-27T21:30:00.000Z'), // 27 Oct 23:30 in Jerusalem
      entry('1', '2026-10-27T08:00:00.000Z'),
    ];

    expect(
      groupByLocalDay(entries, 'Asia/Jerusalem').map((day) => [
        day.date,
        day.entries.map((item) => item.id),
      ]),
    ).toEqual([
      ['2026-10-28', ['3']],
      ['2026-10-27', ['2', '1']],
    ]);
    expect(groupByLocalDay(entries, 'UTC').map((day) => day.date)).toEqual(['2026-10-27']);
  });
});

describe('entries', () => {
  it('describes events and recognizes editing sessions', () => {
    const session = entry('1', '2026-10-27T09:00:00.000Z', {
      eventType: 'note_updated',
      lastActivityAt: '2026-10-27T09:40:00.000Z',
    });
    expect(describeEntry(session)).toBe('Edited the note of');
    expect(isSession(session)).toBe(true);
    expect(isSession(entry('2', '2026-10-27T09:00:00.000Z'))).toBe(false);
    expect(describeEntry(entry('3', '2026-10-27T09:00:00.000Z', { eventType: 'reviewed' }))).toBe(
      'Reviewed',
    );
  });
});
