/**
 * Backup schedule and retention (PRD §9: "Back up on first launch each day … Default retention:
 * seven daily and four weekly snapshots").
 *
 * Days and weeks are calendar days and ISO weeks in the workspace timezone, so "one backup per
 * day" matches the user's day, not UTC. Retention keeps:
 * - the newest snapshot of each of the `daily` most recent days that have a snapshot, and
 * - the newest snapshot of each of the `weekly` most recent ISO weeks that have a snapshot,
 * and always the newest snapshot overall, so pruning can never remove the last good backup.
 */

import { localDateOf } from '../timeline/time-zone';

export interface BackupRetention {
  readonly daily: number;
  readonly weekly: number;
}

export const DEFAULT_BACKUP_RETENTION: BackupRetention = { daily: 7, weekly: 4 };
export const MAX_DAILY_SNAPSHOTS = 60;
export const MAX_WEEKLY_SNAPSHOTS = 104;

export interface SnapshotTime {
  readonly id: string;
  /** UTC ISO timestamp of the snapshot. */
  readonly createdAt: string;
}

/** True when no snapshot was taken yet on today's local date. */
export function isBackupDue(
  latestCreatedAt: string | null,
  nowUtc: string,
  timeZone: string,
): boolean {
  return (
    latestCreatedAt === null ||
    localDateOf(latestCreatedAt, timeZone) !== localDateOf(nowUtc, timeZone)
  );
}

/** IDs of the snapshots to keep; every other snapshot may be deleted. */
export function snapshotsToKeep(
  snapshots: readonly SnapshotTime[],
  retention: BackupRetention,
  timeZone: string,
): Set<string> {
  const newestFirst = [...snapshots].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  const keep = new Set<string>();
  if (newestFirst[0] !== undefined) keep.add(newestFirst[0].id);
  keepNewestPerPeriod(newestFirst, retention.daily, (date) => date, keep, timeZone);
  keepNewestPerPeriod(newestFirst, retention.weekly, isoWeekOf, keep, timeZone);
  return keep;
}

function keepNewestPerPeriod(
  newestFirst: readonly SnapshotTime[],
  periods: number,
  periodOf: (localDate: string) => string,
  keep: Set<string>,
  timeZone: string,
): void {
  const seen = new Set<string>();
  for (const snapshot of newestFirst) {
    if (seen.size >= periods) return;
    const period = periodOf(localDateOf(snapshot.createdAt, timeZone));
    if (seen.has(period)) continue;
    seen.add(period);
    keep.add(snapshot.id);
  }
}

/** ISO 8601 week of a calendar date ('YYYY-MM-DD'), as 'YYYY-Www'. */
export function isoWeekOf(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Thursday of the same week decides the ISO year.
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const firstDay = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((date.getTime() - firstDay) / 86_400_000 / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}
