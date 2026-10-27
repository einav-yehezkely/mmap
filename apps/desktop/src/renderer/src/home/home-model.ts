/**
 * Pure helpers for the home page: a time-of-day greeting in the workspace timezone and short
 * relative times ("3 hours ago"). Kept free of React for unit tests.
 */

const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The hour (0–23) of `nowMs` in `timeZone`; UTC when the zone is unknown. */
export function localHour(nowMs: number, timeZone: string): number {
  let formatter = HOUR_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
    } catch {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        hour: 'numeric',
        hourCycle: 'h23',
      });
    }
    HOUR_FORMATTERS.set(timeZone, formatter);
  }
  return Number(formatter.format(new Date(nowMs))) % 24;
}

export function greeting(nowMs: number, timeZone: string): string {
  const hour = localHour(nowMs, timeZone);
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3_600_000],
  ['month', 30 * 24 * 3_600_000],
  ['week', 7 * 24 * 3_600_000],
  ['day', 24 * 3_600_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago", … */
export function relativeTime(utcTimestamp: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(utcTimestamp);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return 'just now';
  for (const [unit, size] of UNITS) {
    if (elapsed >= size) return RELATIVE.format(-Math.floor(elapsed / size), unit);
  }
  return 'just now';
}
