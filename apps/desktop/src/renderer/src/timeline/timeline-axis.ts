/**
 * Pure time-axis math for the visual learning timeline (PRD §5.9).
 *
 * The timeline is a horizontal axis with older events on the left and newer ones on the right.
 * This module owns everything that does not need React or the DOM: the visible time window and
 * how panning and zooming move it, conversion between instants and pixels, tick marks at local
 * calendar boundaries, the range label, and the placement of event markers into rows and clusters.
 *
 * All instants are epoch milliseconds. Calendar boundaries (midnights, month starts) are computed
 * in the workspace's IANA timezone with the domain helpers, which handle DST days of 23 or 25
 * hours and zones whose midnight falls into a DST gap. Adding 24 hours is never used to find the
 * next midnight.
 */

import { isValidTimeZone, localDateOf, startOfLocalDayUtc } from '@mmap/domain';

const MS_PER_HOUR = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Zoom levels from narrowest to widest. */
export type ZoomLevel = 'day' | 'week' | 'month' | 'year';

/** All zoom levels, ordered from the narrowest (`day`) to the widest (`year`). */
export const ZOOM_LEVELS: readonly ZoomLevel[] = ['day', 'week', 'month', 'year'];

/** Visible span per level: 1 day, 7 days, 31 days, 366 days. */
export const ZOOM_SPANS_MS: Readonly<Record<ZoomLevel, number>> = {
  day: MS_PER_DAY,
  week: 7 * MS_PER_DAY,
  month: 31 * MS_PER_DAY,
  year: 366 * MS_PER_DAY,
};

/** Fraction of the width at which "now" sits in the initial and "today" windows. */
const NOW_POSITION = 0.85;

/** Visible time range, half-open `[startMs, endMs)` with `endMs > startMs`. */
export interface TimeWindow {
  readonly startMs: number;
  readonly endMs: number;
}

function spanOf(window: TimeWindow): number {
  return window.endMs - window.startMs;
}

/** Window of the level's span centered on `centerMs`. */
export function windowFor(zoom: ZoomLevel, centerMs: number): TimeWindow {
  const span = ZOOM_SPANS_MS[zoom];
  const startMs = Math.round(centerMs - span / 2);
  return { startMs, endMs: startMs + span };
}

/** Moves the window by `fraction` of its span (positive = later/right). The span is unchanged. */
export function panWindow(window: TimeWindow, fraction: number): TimeWindow {
  const span = spanOf(window);
  const startMs = Math.round(window.startMs + span * fraction);
  return { startMs, endMs: startMs + span };
}

/**
 * Moves the window by a pixel delta from a drag. Positive `deltaPx` means the content was dragged
 * right, which reveals earlier times. A non-positive width leaves the window unchanged.
 */
export function panByPixels(window: TimeWindow, deltaPx: number, widthPx: number): TimeWindow {
  if (!(widthPx > 0)) {
    return window;
  }
  return panWindow(window, -deltaPx / widthPx);
}

/**
 * Changes the zoom level while keeping `anchorMs` at the same relative x position, so zooming
 * around the cursor keeps the instant under the cursor in place. The anchor defaults to the
 * window's center.
 */
export function zoomWindow(window: TimeWindow, zoom: ZoomLevel, anchorMs?: number): TimeWindow {
  const anchor = anchorMs ?? window.startMs + spanOf(window) / 2;
  const relative = (anchor - window.startMs) / spanOf(window);
  const span = ZOOM_SPANS_MS[zoom];
  const startMs = Math.round(anchor - relative * span);
  return { startMs, endMs: startMs + span };
}

/** Next wider level (`day` -> `week` -> ...), or the same level when already the widest. */
export function widerZoom(zoom: ZoomLevel): ZoomLevel {
  const index = ZOOM_LEVELS.indexOf(zoom);
  return ZOOM_LEVELS[Math.min(index + 1, ZOOM_LEVELS.length - 1)] ?? zoom;
}

/** Next narrower level (`year` -> `month` -> ...), or the same level when already the narrowest. */
export function narrowerZoom(zoom: ZoomLevel): ZoomLevel {
  const index = ZOOM_LEVELS.indexOf(zoom);
  return ZOOM_LEVELS[Math.max(index - 1, 0)] ?? zoom;
}

/** Window of the level's span with `nowMs` at 85% of the width, so the recent past is visible. */
export function todayWindow(zoom: ZoomLevel, nowMs: number): TimeWindow {
  const span = ZOOM_SPANS_MS[zoom];
  const startMs = Math.round(nowMs - NOW_POSITION * span);
  return { startMs, endMs: startMs + span };
}

/**
 * Initial window: `nowMs` at 85% of the width (recent past visible). If the most recent event is
 * older than that window's start, the window is centered on that event instead, so events are
 * immediately visible. `latestEventMs` is null when there are no events.
 */
export function initialWindow(
  zoom: ZoomLevel,
  nowMs: number,
  latestEventMs: number | null,
): TimeWindow {
  const today = todayWindow(zoom, nowMs);
  if (latestEventMs !== null && latestEventMs < today.startMs) {
    return windowFor(zoom, latestEventMs);
  }
  return today;
}

/** Horizontal position of the instant `ms` in a strip `widthPx` wide showing `window`. */
export function xFor(ms: number, window: TimeWindow, widthPx: number): number {
  return ((ms - window.startMs) / spanOf(window)) * widthPx;
}

/** Instant at horizontal position `x`; the inverse of {@link xFor}. */
export function msFor(x: number, window: TimeWindow, widthPx: number): number {
  return window.startMs + (x / widthPx) * spanOf(window);
}

// ---------------------------------------------------------------------------------------------
// Ticks and labels
// ---------------------------------------------------------------------------------------------

/** A tick mark on the axis. `label` is '' for unlabeled minor ticks. */
export interface Tick {
  readonly ms: number;
  readonly label: string;
  readonly major: boolean;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Falls back to UTC for an unknown zone so a bad setting degrades the display instead of breaking
 * the screen; the settings form validates the zone separately.
 */
function resolveZone(timeZone: string): string {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC';
}

/** Formatters are costly to construct and ticks are recomputed on every pan, so they are cached. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  timeZone: string,
  key: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): Intl.DateTimeFormat {
  const cacheKey = `${timeZone}|${key}`;
  let cached = formatters.get(cacheKey);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formatters.set(cacheKey, cached);
  }
  return cached;
}

/** Local hour (0-23) of `ms` in `timeZone`, read with a fixed locale so it parses reliably. */
function localHour(ms: number, timeZone: string): number {
  const hourFormatter = formatter(
    timeZone,
    'hour-number',
    { hour: '2-digit', hourCycle: 'h23' },
    'en-US',
  );
  const part = hourFormatter.formatToParts(ms).find((p) => p.type === 'hour');
  // Some ICU versions print midnight as 24 even with `h23`; normalize defensively.
  return Number(part?.value ?? 0) % 24;
}

function localDate(ms: number, timeZone: string): CalendarDate {
  const [year, month, day] = localDateOf(new Date(ms).toISOString(), timeZone)
    .split('-')
    .map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

function formatDate({ year, month, day }: CalendarDate): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function addDays({ year, month, day }: CalendarDate, days: number): CalendarDate {
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/** Day of the week of a calendar date, 0 = Sunday ... 6 = Saturday. */
function weekdayOf({ year, month, day }: CalendarDate): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Instant the local day `date` begins (local midnight, or the end of a DST gap at midnight). */
function startOfDayMs(date: CalendarDate, timeZone: string): number {
  return Date.parse(startOfLocalDayUtc(formatDate(date), timeZone));
}

/**
 * Calls `visit` with each local day that starts before `window.endMs`, beginning with the day that
 * contains `window.startMs`, together with its start instant and the next day's start instant.
 */
function forEachLocalDay(
  window: TimeWindow,
  timeZone: string,
  visit: (date: CalendarDate, startMs: number, nextStartMs: number) => void,
): void {
  let date = localDate(window.startMs, timeZone);
  let dayStart = startOfDayMs(date, timeZone);
  while (dayStart < window.endMs) {
    const next = addDays(date, 1);
    const nextStart = startOfDayMs(next, timeZone);
    visit(date, dayStart, nextStart);
    date = next;
    dayStart = nextStart;
  }
}

function inWindow(ms: number, window: TimeWindow): boolean {
  return ms >= window.startMs && ms < window.endMs;
}

/** Day view: one tick per real hour; labels every third local hour; majors at local midnight. */
function hourTicks(window: TimeWindow, timeZone: string): Tick[] {
  const ticks: Tick[] = [];
  const hourLabel = formatter(timeZone, 'hour', { hour: 'numeric' });
  const dateLabel = formatter(timeZone, 'day-month', { month: 'short', day: 'numeric' });
  forEachLocalDay(window, timeZone, (_date, dayStart, nextStart) => {
    // Stepping real hours from the day's start gives 23 ticks on a spring-forward day and 25 on a
    // fall-back day, matching what the wall clock actually shows.
    for (let ms = dayStart; ms < nextStart; ms += MS_PER_HOUR) {
      if (!inWindow(ms, window)) {
        continue;
      }
      if (ms === dayStart) {
        ticks.push({ ms, label: dateLabel.format(ms), major: true });
      } else {
        const label = localHour(ms, timeZone) % 3 === 0 ? hourLabel.format(ms) : '';
        ticks.push({ ms, label, major: false });
      }
    }
  });
  return ticks;
}

/** Week view: every local midnight, labeled with weekday and day; majors on Mondays. */
function weekTicks(window: TimeWindow, timeZone: string): Tick[] {
  const ticks: Tick[] = [];
  const label = formatter(timeZone, 'weekday-day', { weekday: 'short', day: 'numeric' });
  forEachLocalDay(window, timeZone, (date, dayStart) => {
    if (inWindow(dayStart, window)) {
      ticks.push({ ms: dayStart, label: label.format(dayStart), major: weekdayOf(date) === 1 });
    }
  });
  return ticks;
}

/** Month view: every local midnight, odd days labeled; majors on the 1st with the month name. */
function dayTicks(window: TimeWindow, timeZone: string): Tick[] {
  const ticks: Tick[] = [];
  const dayLabel = formatter(timeZone, 'day', { day: 'numeric' });
  const firstLabel = formatter(timeZone, 'day-month', { month: 'short', day: 'numeric' });
  forEachLocalDay(window, timeZone, (date, dayStart) => {
    if (!inWindow(dayStart, window)) {
      return;
    }
    if (date.day === 1) {
      ticks.push({ ms: dayStart, label: firstLabel.format(dayStart), major: true });
    } else {
      const label = date.day % 2 === 1 ? dayLabel.format(dayStart) : '';
      ticks.push({ ms: dayStart, label, major: false });
    }
  });
  return ticks;
}

/** Year view: every local month start, labeled with the short month; January is major. */
function monthTicks(window: TimeWindow, timeZone: string): Tick[] {
  const ticks: Tick[] = [];
  const monthLabel = formatter(timeZone, 'month', { month: 'short' });
  const yearLabel = formatter(timeZone, 'month-year', { month: 'short', year: 'numeric' });
  const first = localDate(window.startMs, timeZone);
  let year = first.year;
  let month = first.month;
  for (;;) {
    const ms = startOfDayMs({ year, month, day: 1 }, timeZone);
    if (ms >= window.endMs) {
      break;
    }
    if (ms >= window.startMs) {
      const major = month === 1;
      ticks.push({ ms, label: (major ? yearLabel : monthLabel).format(ms), major });
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return ticks;
}

/**
 * Ticks inside the window (none outside it), at local boundaries in `timeZone`:
 * - day: every local hour, labels every 3 hours (label '' otherwise), major at local midnight
 *   (label = date);
 * - week: every local midnight, label weekday + day of month, major on Mondays;
 * - month: every local midnight, label every 2nd day (others ''), major on the 1st of a month
 *   (label month + day);
 * - year: every local month start, label short month name, major at January (label includes the
 *   year).
 *
 * Local midnights come from `startOfLocalDayUtc`, so they are DST- and gap-safe. Hour ticks on DST
 * days are real instants: a 23- or 25-hour day has 23 or 25 hour ticks. An unknown timezone falls
 * back to UTC.
 */
export function ticksFor(window: TimeWindow, zoom: ZoomLevel, timeZone: string): Tick[] {
  const zone = resolveZone(timeZone);
  switch (zoom) {
    case 'day':
      return hourTicks(window, zone);
    case 'week':
      return weekTicks(window, zone);
    case 'month':
      return dayTicks(window, zone);
    case 'year':
      return monthTicks(window, zone);
  }
}

/**
 * Human label for the visible range, e.g. "Tuesday, 27 October 2026" (day), "27 Oct – 2 Nov 2026"
 * (week), "October 2026" (month) or "Nov 2025 – Oct 2026" (year). Wording follows the user's
 * locale; dates are shown in `timeZone`.
 */
export function windowLabel(window: TimeWindow, zoom: ZoomLevel, timeZone: string): string {
  const zone = resolveZone(timeZone);
  const center = window.startMs + spanOf(window) / 2;
  // The end is exclusive, so the last visible instant is one millisecond before it.
  const last = Math.max(window.startMs, window.endMs - 1);
  switch (zoom) {
    case 'day':
      return formatter(zone, 'long-date', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(center);
    case 'week':
      return formatter(zone, 'range-day', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).formatRange(window.startMs, last);
    case 'month':
      return formatter(zone, 'long-month', { year: 'numeric', month: 'long' }).format(center);
    case 'year':
      return formatter(zone, 'range-month', { year: 'numeric', month: 'short' }).formatRange(
        window.startMs,
        last,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Marker layout
// ---------------------------------------------------------------------------------------------

/** An event to place: a point when `startMs === endMs`, or an editing session spanning a range. */
export interface MarkerInput {
  readonly id: string;
  readonly startMs: number;
  /** End of the event; `endMs >= startMs`. */
  readonly endMs: number;
}

/**
 * A placed marker. Singles span `x1..x2` (equal for point events). Clusters stand for several
 * nearby markers drawn as one badge at `x`, covering `startMs..endMs`.
 */
export type PlacedItem =
  | {
      readonly kind: 'single';
      readonly id: string;
      readonly x1: number;
      readonly x2: number;
      readonly row: number;
    }
  | {
      readonly kind: 'cluster';
      readonly ids: readonly string[];
      readonly x: number;
      readonly startMs: number;
      readonly endMs: number;
      readonly row: number;
    };

export interface LayoutOptions {
  /** Markers whose start positions are within this distance of a group's first marker merge. */
  readonly clusterRadiusPx: number;
  /** Minimum horizontal gap between items that share a row. */
  readonly minGapPx: number;
  /** Maximum number of rows; items that do not fit are merged into clusters. */
  readonly maxRows: number;
}

interface PositionedMarker {
  readonly marker: MarkerInput;
  readonly x1: number;
  readonly x2: number;
}

/** A single or cluster before its row is known. */
interface Candidate {
  readonly markers: readonly PositionedMarker[];
  /** Position used for sorting and as the item's left edge. */
  readonly x: number;
  /** Right edge of the item's extent (a session's end; a cluster is a point). */
  readonly right: number;
  /** Tie-breaker for equal positions. */
  readonly key: string;
}

/** Mutable cluster under construction, so overflow items can still be merged into it. */
interface MutableCluster {
  readonly ids: string[];
  readonly x: number;
  startMs: number;
  endMs: number;
  readonly row: number;
}

function compareMarkers(a: PositionedMarker, b: PositionedMarker): number {
  return (
    a.x1 - b.x1 ||
    (a.marker.id < b.marker.id ? -1 : a.marker.id > b.marker.id ? 1 : 0) ||
    a.marker.startMs - b.marker.startMs ||
    a.marker.endMs - b.marker.endMs
  );
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Groups markers sorted by start position: a marker joins the current group while its x1 is within
 * `radius` of the group's first marker. Anchoring to the first marker (instead of chaining) keeps a
 * dense stretch from collapsing into one very wide cluster.
 */
function clusterMarkers(sorted: readonly PositionedMarker[], radius: number): Candidate[] {
  const candidates: Candidate[] = [];
  let index = 0;
  while (index < sorted.length) {
    const first = sorted[index];
    if (first === undefined) {
      break;
    }
    const group: PositionedMarker[] = [first];
    index += 1;
    for (let next = sorted[index]; next !== undefined; next = sorted[index]) {
      if (next.x1 - first.x1 > radius) {
        break;
      }
      group.push(next);
      index += 1;
    }
    if (group.length === 1) {
      candidates.push({ markers: group, x: first.x1, right: first.x2, key: first.marker.id });
    } else {
      const x = group.reduce((sum, m) => sum + m.x1, 0) / group.length;
      candidates.push({ markers: group, x, right: x, key: first.marker.id });
    }
  }
  return candidates;
}

/**
 * Lays out markers in the window. Markers entirely outside the window are skipped; positions of
 * the rest are clamped to `[0, widthPx]`. Markers whose x1 positions are within `clusterRadiusPx`
 * of each other form one cluster (x = mean of x1, startMs/endMs = min/max). Singles and clusters
 * are then assigned rows greedily, sorted by x and then id, so items in the same row are at least
 * `minGapPx` apart (a session's x2 counts for its extent). At most `maxRows` rows are used; an item
 * that fits no row is merged into the nearest already-placed cluster within `minGapPx` (whose x
 * stays put), or otherwise becomes a cluster in the last row. Nothing is dropped, and the result
 * does not depend on input order.
 */
export function layoutMarkers(
  markers: readonly MarkerInput[],
  window: TimeWindow,
  widthPx: number,
  options: LayoutOptions,
): PlacedItem[] {
  const clamp = (x: number) => Math.min(Math.max(x, 0), widthPx);
  const visible: PositionedMarker[] = [];
  for (const marker of markers) {
    if (marker.endMs < window.startMs || marker.startMs >= window.endMs) {
      continue;
    }
    const x1 = clamp(xFor(marker.startMs, window, widthPx));
    const x2 = Math.max(x1, clamp(xFor(marker.endMs, window, widthPx)));
    visible.push({ marker, x1, x2 });
  }
  if (visible.length === 0) {
    return [];
  }
  visible.sort(compareMarkers);
  const candidates = clusterMarkers(visible, options.clusterRadiusPx);
  candidates.sort(compareCandidates);

  const maxRows = Math.max(1, Math.floor(options.maxRows));
  /** Right edge of the last item in each opened row. */
  const rowEnds: number[] = [];
  /** Output in placement order; clusters stay mutable until the end. */
  const placed: (PlacedItem | MutableCluster)[] = [];
  /** Clusters in placement order, which is increasing x because candidates are sorted by x. */
  const clusters: MutableCluster[] = [];

  const addCluster = (candidate: Candidate, row: number): void => {
    const cluster: MutableCluster = {
      ids: candidate.markers.map((m) => m.marker.id),
      x: candidate.x,
      startMs: Math.min(...candidate.markers.map((m) => m.marker.startMs)),
      endMs: Math.max(...candidate.markers.map((m) => m.marker.endMs)),
      row,
    };
    clusters.push(cluster);
    placed.push(cluster);
  };

  for (const candidate of candidates) {
    let row = rowEnds.findIndex((end) => candidate.x - end >= options.minGapPx);
    if (row === -1 && rowEnds.length < maxRows) {
      row = rowEnds.length;
      rowEnds.push(Number.NEGATIVE_INFINITY);
    }
    if (row !== -1) {
      rowEnds[row] = Math.max(rowEnds[row] ?? Number.NEGATIVE_INFINITY, candidate.right);
      const only = candidate.markers.length === 1 ? candidate.markers[0] : undefined;
      if (only !== undefined) {
        placed.push({ kind: 'single', id: only.marker.id, x1: only.x1, x2: only.x2, row });
      } else {
        addCluster(candidate, row);
      }
      continue;
    }

    // No row has room: merge into the nearest cluster that already collides with it visually.
    // Earlier clusters have smaller x, so scanning backwards can stop once they are too far left.
    let nearest: MutableCluster | undefined;
    for (let i = clusters.length - 1; i >= 0; i -= 1) {
      const cluster = clusters[i];
      if (cluster === undefined || candidate.x - cluster.x >= options.minGapPx) {
        break;
      }
      if (
        nearest === undefined ||
        Math.abs(cluster.x - candidate.x) < Math.abs(nearest.x - candidate.x)
      ) {
        nearest = cluster;
      }
    }
    if (nearest !== undefined) {
      for (const m of candidate.markers) {
        nearest.ids.push(m.marker.id);
        nearest.startMs = Math.min(nearest.startMs, m.marker.startMs);
        nearest.endMs = Math.max(nearest.endMs, m.marker.endMs);
      }
    } else {
      const lastRow = maxRows - 1;
      rowEnds[lastRow] = Math.max(rowEnds[lastRow] ?? Number.NEGATIVE_INFINITY, candidate.x);
      addCluster(candidate, lastRow);
    }
  }

  return placed.map((item): PlacedItem => {
    if ('kind' in item) {
      return item;
    }
    return {
      kind: 'cluster',
      ids: item.ids,
      x: item.x,
      startMs: item.startMs,
      endMs: item.endMs,
      row: item.row,
    };
  });
}
