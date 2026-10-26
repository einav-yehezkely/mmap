/**
 * Editing-session grouping for the learning timeline (PRD §5.9: "Group autosave updates into one
 * activity per editing session rather than recording every keystroke. Define an editing session as
 * a continuous edit period ending after 30 minutes of inactivity.").
 */

export const EDITING_SESSION_INACTIVITY_MS = 30 * 60 * 1_000;

/**
 * True when an edit at `now` continues the session whose last edit was at `lastActivityAt`, i.e.
 * less than 30 minutes have passed. Exactly 30 minutes of inactivity ends the session. A clock
 * that moved backwards (e.g. a time zone or system clock change) starts a new session rather than
 * extending one into the past.
 */
export function continuesEditingSession(lastActivityAt: string, now: string): boolean {
  const gap = Date.parse(now) - Date.parse(lastActivityAt);
  return gap >= 0 && gap < EDITING_SESSION_INACTIVITY_MS;
}
