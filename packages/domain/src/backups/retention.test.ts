/**
 * Backup schedule and retention (PRD §9): one backup per local day, seven daily and four weekly
 * snapshots by default, and never pruning the newest.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKUP_RETENTION, isBackupDue, isoWeekOf, snapshotsToKeep } from './retention';

/** One snapshot per day at 09:00 UTC for `days` days ending on 2026-10-27. */
function daily(days: number) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 27 - index, 9));
    return { id: date.toISOString().slice(0, 10), createdAt: date.toISOString() };
  });
}

describe('isBackupDue', () => {
  it('is due once per local day', () => {
    expect(isBackupDue(null, '2026-10-27T09:00:00.000Z', 'UTC')).toBe(true);
    expect(isBackupDue('2026-10-27T01:00:00.000Z', '2026-10-27T23:00:00.000Z', 'UTC')).toBe(false);
    expect(isBackupDue('2026-10-26T23:00:00.000Z', '2026-10-27T01:00:00.000Z', 'UTC')).toBe(true);
    // 23:00 UTC on the 26th is already the 27th in Jerusalem (UTC+2).
    expect(
      isBackupDue('2026-10-26T23:00:00.000Z', '2026-10-27T09:00:00.000Z', 'Asia/Jerusalem'),
    ).toBe(false);
  });
});

describe('snapshotsToKeep', () => {
  it('keeps seven daily and four weekly snapshots by default', () => {
    const kept = [...snapshotsToKeep(daily(60), DEFAULT_BACKUP_RETENTION, 'UTC')].sort();
    // The last seven days, plus the newest snapshot of each of the four most recent ISO weeks:
    // W44 (the 27th), W43 (the 25th, already a daily one), W42 (the 18th) and W41 (the 11th).
    expect(kept).toEqual(
      [
        '2026-10-11',
        '2026-10-18',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-25',
        '2026-10-26',
        '2026-10-27',
      ].sort(),
    );
  });

  it('keeps the newest snapshot of a day with several', () => {
    const snapshots = [
      { id: 'morning', createdAt: '2026-10-27T08:00:00.000Z' },
      { id: 'evening', createdAt: '2026-10-27T20:00:00.000Z' },
    ];
    expect(snapshotsToKeep(snapshots, { daily: 1, weekly: 0 }, 'UTC')).toEqual(
      new Set(['evening']),
    );
  });

  it('always keeps the newest snapshot, even with zero retention', () => {
    expect(snapshotsToKeep(daily(3), { daily: 0, weekly: 0 }, 'UTC')).toEqual(
      new Set(['2026-10-27']),
    );
    expect(snapshotsToKeep([], DEFAULT_BACKUP_RETENTION, 'UTC')).toEqual(new Set());
  });
});

describe('isoWeekOf', () => {
  it('follows ISO 8601, including year boundaries', () => {
    expect(isoWeekOf('2026-10-27')).toBe('2026-W44');
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01');
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53');
    expect(isoWeekOf('2024-12-30')).toBe('2025-W01');
  });
});
