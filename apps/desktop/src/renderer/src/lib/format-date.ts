/**
 * Date display helpers. Storage is UTC; display uses the workspace's timezone (PRD §5.9) and
 * the system locale.
 */

export function formatDateTime(utcTimestamp: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(utcTimestamp));
  } catch {
    // Unknown timezone name: fall back to the system timezone rather than failing to render.
    return new Date(utcTimestamp).toLocaleString();
  }
}

/** Time of day of `utcTimestamp` in `timeZone`, e.g. "14:05" or "2:05 PM" depending on locale. */
export function formatTime(utcTimestamp: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone }).format(
      new Date(utcTimestamp),
    );
  } catch {
    return new Date(utcTimestamp).toLocaleTimeString();
  }
}

/**
 * A calendar date ('YYYY-MM-DD', already in the user's timezone) as a heading, e.g.
 * "Tuesday, 27 October 2026". Formatted at noon UTC so no timezone can move it to another day.
 */
export function formatCalendarDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00.000Z`),
  );
}
