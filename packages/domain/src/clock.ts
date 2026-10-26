/**
 * Time source.
 *
 * All persisted timestamps are UTC (PRD §5.9, §7.2) and stored as ISO-8601 strings with
 * millisecond precision and a trailing `Z`, for example `2026-10-26T14:03:00.000Z`. This fixed
 * width format sorts correctly as text, which keeps date-range queries index-friendly.
 * Conversion to the user's display timezone happens only in presentation code.
 */

/** ISO-8601 UTC timestamp, e.g. `2026-10-26T14:03:00.000Z`. */
export type UtcTimestamp = string & { readonly __utcTimestamp: true };

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Returns true when `value` matches the fixed-width UTC timestamp format used in storage. */
export function isUtcTimestamp(value: string): value is UtcTimestamp {
  return UTC_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** Converts a `Date` to the storage timestamp format. */
export function toUtcTimestamp(date: Date): UtcTimestamp {
  // `toISOString` always returns UTC with millisecond precision, matching the storage format.
  return date.toISOString() as UtcTimestamp;
}

/**
 * Port for reading the current time. Injected everywhere instead of calling `new Date()`
 * directly so that timeline grouping and revision logic can be tested deterministically.
 */
export interface Clock {
  now(): UtcTimestamp;
}
