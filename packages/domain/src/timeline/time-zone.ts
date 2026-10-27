/**
 * Timezone-aware date helpers for the learning timeline (PRD §5.9: "Store UTC timestamps and
 * display dates in the user's selected timezone.").
 *
 * Timestamps are stored as fixed-width UTC strings. The timeline groups activity by the calendar
 * date in the user's timezone, and its date-range filter lets the user pick local dates that must
 * become UTC bounds for SQL. These helpers do that conversion with `Intl` only, so they stay
 * runtime-agnostic and use the runtime's IANA timezone database for DST rules.
 *
 * Local days are not always 24 hours long: DST transitions produce 23- and 25-hour days, and a few
 * zones switch at midnight, so local midnight sometimes does not exist (the day then starts at the
 * transition instant) or exists twice (the day starts at the earlier one).
 */

import { isUtcTimestamp, type UtcTimestamp } from '../clock';
import { DomainError } from '../errors';

const MS_PER_SECOND = 1_000;
const MS_PER_DAY = 24 * 60 * 60 * MS_PER_SECOND;

/** Strict calendar date: four-digit year from 1000, two-digit month and day. */
const LOCAL_DATE_PATTERN = /^([1-9]\d{3})-(\d{2})-(\d{2})$/;

/** ISO-8601 instant with an explicit `Z` or numeric offset, e.g. `2026-03-29T10:00:00.000Z`. */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Offset-style names such as `+02:00` are accepted by `Intl` but are not IANA zones. */
const OFFSET_TIME_ZONE_PATTERN = /^[+-]/;

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface WallClock extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Formatters are relatively expensive to construct and timelines convert many timestamps, so one
 * formatter per timezone is reused. The cache holds only validated timezone names.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * True when `timeZone` is an IANA name this runtime knows (e.g. `Asia/Jerusalem`, `UTC`). Names
 * are matched the way `Intl` matches them, so case differences and legacy aliases such as
 * `US/Eastern` are accepted. The empty string and offset forms such as `+02:00` are rejected.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === '' || OFFSET_TIME_ZONE_PATTERN.test(timeZone)) {
    return false;
  }
  try {
    formatterFor(timeZone);
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

/** Returns `timeZone` unchanged, or throws `VALIDATION_FAILED` when the runtime does not know it. */
export function validateTimeZone(timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new DomainError('VALIDATION_FAILED', 'This timezone is not recognized.');
  }
  return timeZone;
}

/** Calendar date `YYYY-MM-DD` of the instant `utc` as seen on a wall clock in `timeZone`. */
export function localDateOf(utc: UtcTimestamp | string, timeZone: string): string {
  validateTimeZone(timeZone);
  return formatDate(wallClockAt(parseInstant(utc), timeZone));
}

/**
 * UTC instant at which the local calendar day `date` (`YYYY-MM-DD`) begins in `timeZone`.
 *
 * Usually that is local midnight. When the clocks jump forward at midnight (e.g.
 * `America/Santiago` in September), midnight does not exist and the day begins at the first
 * instant that falls on it, i.e. the transition itself. When the clocks fall back across midnight
 * so that midnight occurs twice, the earlier occurrence is returned.
 */
export function startOfLocalDayUtc(date: string, timeZone: string): UtcTimestamp {
  validateTimeZone(timeZone);
  return toFixedWidthUtc(startOfLocalDayMs(parseLocalDate(date), timeZone));
}

/**
 * Half-open UTC range `[fromUtc, toUtcExclusive)` covering the local dates `fromDate` through
 * `toDate` inclusive in `timeZone`. A `null` bound leaves that side of the range open. The end is
 * exclusive because it is the start of the day after `toDate`, which keeps the last day complete
 * even when it is 23 or 25 hours long.
 */
export function localDateRangeToUtc(
  fromDate: string | null,
  toDate: string | null,
  timeZone: string,
): { fromUtc: UtcTimestamp | null; toUtcExclusive: UtcTimestamp | null } {
  validateTimeZone(timeZone);
  const from = fromDate === null ? null : parseLocalDate(fromDate);
  const to = toDate === null ? null : parseLocalDate(toDate);
  if (from !== null && to !== null && formatDate(from) > formatDate(to)) {
    throw new DomainError('VALIDATION_FAILED', 'The start date must not be after the end date.');
  }
  return {
    fromUtc: from === null ? null : toFixedWidthUtc(startOfLocalDayMs(from, timeZone)),
    toUtcExclusive: to === null ? null : toFixedWidthUtc(startOfLocalDayMs(nextDay(to), timeZone)),
  };
}

/** Parses a strict `YYYY-MM-DD` string that names a real calendar date (no 2026-02-30). */
function parseLocalDate(date: string): CalendarDate {
  const match = LOCAL_DATE_PATTERN.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (match === null || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new DomainError('VALIDATION_FAILED', 'Dates must be real calendar dates as YYYY-MM-DD.');
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of `month`. Years here are always >= 1000, so
  // `Date.UTC` does not apply its two-digit-year mapping.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextDay({ year, month, day }: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** Parses an ISO-8601 instant to epoch milliseconds. Other string formats are rejected. */
function parseInstant(value: string): number {
  const ms = ISO_INSTANT_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new DomainError('VALIDATION_FAILED', 'Timestamps must be ISO-8601 UTC instants.');
  }
  return ms;
}

/** Converts epoch milliseconds to the storage format, rejecting years it cannot represent. */
function toFixedWidthUtc(ms: number): UtcTimestamp {
  const iso = new Date(ms).toISOString();
  if (!isUtcTimestamp(iso)) {
    throw new DomainError('VALIDATION_FAILED', 'This date is outside the supported range.');
  }
  return iso;
}

/** Local wall-clock reading of the instant `ms` in `timeZone`. */
function wallClockAt(ms: number, timeZone: string): WallClock {
  const fields = new Map<string, number>();
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') {
      fields.set(part.type, Number(part.value));
    }
  }
  const field = (name: string): number => fields.get(name) ?? Number.NaN;
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    // Some ICU versions print midnight as 24 even with `h23`; normalize defensively.
    hour: field('hour') % 24,
    minute: field('minute'),
    second: field('second'),
  };
}

/**
 * Offset of `timeZone` from UTC at the instant `ms`, in milliseconds (positive east of UTC). The
 * instant is truncated to whole seconds because the wall clock is read at second precision.
 */
function offsetMsAt(ms: number, timeZone: string): number {
  const wall = wallClockAt(ms, timeZone);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallAsUtc - Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND;
}

/**
 * Finds the instant the local day begins.
 *
 * Any instant whose wall clock reads midnight of `date` is `midnightAsUtc - offset` for the offset
 * in force at that instant. Offsets change at most once or twice around a given day, so the
 * offsets a day before, at, and a day after that point are the only candidates. Each candidate is
 * checked against the wall clock; the earliest that really reads midnight wins (a fall-back across
 * midnight produces two). If none does, midnight fell into a DST gap.
 */
function startOfLocalDayMs(date: CalendarDate, timeZone: string): number {
  const midnightAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  const offsets = new Set(
    [midnightAsUtc - MS_PER_DAY, midnightAsUtc, midnightAsUtc + MS_PER_DAY].map((ms) =>
      offsetMsAt(ms, timeZone),
    ),
  );
  const candidates = [...offsets].map((offset) => midnightAsUtc - offset).sort((a, b) => a - b);
  const exact = candidates.find((ms) => isMidnightOf(wallClockAt(ms, timeZone), date));
  if (exact !== undefined) {
    return exact;
  }
  return firstInstantOnOrAfter(date, timeZone, candidates[0], candidates[candidates.length - 1]);
}

/**
 * Binary-searches whole seconds in `(earliest, latest]` for the first instant whose local date is
 * `date` or later, i.e. the moment the clocks jumped over midnight. With a gap at midnight the
 * earliest candidate still reads the previous day and the latest already reads `date`, and the
 * local date only moves forward in between, so the search is well-defined.
 */
function firstInstantOnOrAfter(
  date: CalendarDate,
  timeZone: string,
  earliest: number | undefined,
  latest: number | undefined,
): number {
  if (earliest === undefined || latest === undefined) {
    throw new Error('Expected at least one candidate offset.');
  }
  const target = formatDate(date);
  let before = earliest;
  let after = latest;
  while (after - before > MS_PER_SECOND) {
    const middle = before + Math.floor((after - before) / 2 / MS_PER_SECOND) * MS_PER_SECOND;
    if (formatDate(wallClockAt(middle, timeZone)) >= target) {
      after = middle;
    } else {
      before = middle;
    }
  }
  return after;
}

function isMidnightOf(wall: WallClock, date: CalendarDate): boolean {
  return (
    wall.year === date.year &&
    wall.month === date.month &&
    wall.day === date.day &&
    wall.hour === 0 &&
    wall.minute === 0 &&
    wall.second === 0
  );
}

function formatDate({ year, month, day }: CalendarDate): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}
