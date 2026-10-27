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
