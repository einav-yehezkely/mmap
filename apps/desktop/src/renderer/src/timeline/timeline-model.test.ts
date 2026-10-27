/**
 * Timeline model (PRD §5.9): effective times, grouping by calendar day in the workspace timezone,
 * descriptions, axis inputs and local date-time conversion.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { describe, expect, it } from 'vitest';

import {
  describeEntry,
  effectiveTime,
  entrySubject,
  EVENT_STYLES,
  fromLocalInputValue,
  groupByLocalDay,
  isSession,
  isUserOwned,
  markerInputs,
  toLocalInputValue,
} from './timeline-model';

function entry(id: string, occurredAt: string, extra: Partial<TimelineEntryDto> = {}) {
  return {
    id,
    eventType: 'node_created',
    occurredAt,
    lastActivityAt: occurredAt,
    learnedAt: null,
    title: null,
    nodeId: null,
    nodeTitle: 'Node',
    reflection: null,
    isImported: false,
    ...extra,
  } satisfies TimelineEntryDto;
}

describe('effective time and grouping', () => {
  it('places an entry at its learning date when it has one', () => {
    const learned = entry('1', '2026-10-27T10:00:00.000Z', {
      learnedAt: '2026-10-01T08:00:00.000Z',
    });
    expect(effectiveTime(learned)).toBe('2026-10-01T08:00:00.000Z');
    expect(effectiveTime(entry('2', '2026-10-27T10:00:00.000Z'))).toBe('2026-10-27T10:00:00.000Z');
  });

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
  it('describes events, milestones and sessions', () => {
    const session = entry('1', '2026-10-27T09:00:00.000Z', {
      eventType: 'note_updated',
      lastActivityAt: '2026-10-27T09:40:00.000Z',
    });
    expect(describeEntry(session)).toBe('Edited the note of');
    expect(isSession(session)).toBe(true);
    expect(isSession(entry('2', '2026-10-27T09:00:00.000Z'))).toBe(false);
    const milestone = entry('3', '2026-10-27T09:00:00.000Z', {
      eventType: 'milestone',
      title: 'Finished the course',
      nodeTitle: null,
    });
    expect(entrySubject(milestone)).toBe('Finished the course');
    expect(isUserOwned(milestone)).toBe(true);
    expect(isUserOwned(session)).toBe(false);
  });

  it('gives every event type its own shape', () => {
    const shapes = Object.values(EVENT_STYLES).map((style) => style.shape);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it('turns sessions into spans, and learning dates into points', () => {
    const session = entry('1', '2026-10-27T09:00:00.000Z', {
      eventType: 'note_updated',
      lastActivityAt: '2026-10-27T09:40:00.000Z',
    });
    const learned = { ...session, id: '2', learnedAt: '2026-10-01T08:00:00.000Z' };
    expect(markerInputs([session, learned])).toEqual([
      {
        id: '1',
        startMs: Date.parse('2026-10-27T09:00:00.000Z'),
        endMs: Date.parse('2026-10-27T09:40:00.000Z'),
      },
      {
        id: '2',
        startMs: Date.parse('2026-10-01T08:00:00.000Z'),
        endMs: Date.parse('2026-10-01T08:00:00.000Z'),
      },
    ]);
  });
});

describe('local date-time inputs', () => {
  it('round-trips a time in the workspace timezone', () => {
    expect(toLocalInputValue('2026-10-27T22:30:00.000Z', 'Asia/Jerusalem')).toBe(
      '2026-10-28T00:30',
    );
    expect(fromLocalInputValue('2026-10-28T00:30', 'Asia/Jerusalem')).toBe(
      '2026-10-27T22:30:00.000Z',
    );
    expect(fromLocalInputValue('2026-07-01T12:00', 'UTC')).toBe('2026-07-01T12:00:00.000Z');
  });

  it('handles daylight-saving changes', () => {
    // New York, 8 March 2026: 02:30 does not exist; it moves forward to 03:30 EDT (07:30 UTC).
    expect(fromLocalInputValue('2026-03-08T02:30', 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    // New York, 1 November 2026: 01:30 happens twice; the earlier (EDT, 05:30 UTC) is used.
    expect(fromLocalInputValue('2026-11-01T01:30', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('rejects malformed and impossible dates', () => {
    expect(fromLocalInputValue('2026-02-30T10:00', 'UTC')).toBeNull();
    expect(fromLocalInputValue('yesterday', 'UTC')).toBeNull();
  });
});
