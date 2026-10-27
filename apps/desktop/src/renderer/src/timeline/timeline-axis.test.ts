/**
 * Time axis of the visual timeline (PRD §5.9): window math for pan and zoom, pixel conversion,
 * ticks at local calendar boundaries (including DST days), and marker layout into rows and
 * clusters. Labels depend on the runtime locale, so they are only checked loosely.
 */

import { localDateOf, startOfLocalDayUtc } from '@mmap/domain';
import { describe, expect, it } from 'vitest';

import {
  initialWindow,
  layoutMarkers,
  msFor,
  narrowerZoom,
  panByPixels,
  panWindow,
  ticksFor,
  todayWindow,
  widerZoom,
  windowFor,
  windowLabel,
  xFor,
  zoomWindow,
  ZOOM_LEVELS,
  ZOOM_SPANS_MS,
  type MarkerInput,
  type PlacedItem,
  type TimeWindow,
} from './timeline-axis';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

function dayStart(date: string, timeZone: string): number {
  return Date.parse(startOfLocalDayUtc(date, timeZone));
}

function localDate(ms: number, timeZone: string): string {
  return localDateOf(new Date(ms).toISOString(), timeZone);
}

function localHour(ms: number, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(ms)
    .find((p) => p.type === 'hour');
  return Number(part?.value) % 24;
}

/** Small deterministic PRNG so "random" inputs are reproducible. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = random(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function idCount(items: readonly PlacedItem[]): number {
  return items.reduce((sum, item) => sum + (item.kind === 'single' ? 1 : item.ids.length), 0);
}

describe('window math', () => {
  it('centers a window of the level span', () => {
    for (const zoom of ZOOM_LEVELS) {
      const window = windowFor(zoom, NOW);
      expect(window.endMs - window.startMs).toBe(ZOOM_SPANS_MS[zoom]);
      expect((window.startMs + window.endMs) / 2).toBe(NOW);
    }
    expect(ZOOM_SPANS_MS).toEqual({ day: DAY, week: 7 * DAY, month: 31 * DAY, year: 366 * DAY });
  });

  it('pans by a fraction of the span and by pixels', () => {
    const window = windowFor('week', NOW);
    expect(panWindow(window, 0.5)).toEqual({
      startMs: window.startMs + 3.5 * DAY,
      endMs: window.endMs + 3.5 * DAY,
    });
    expect(panWindow(window, -1).endMs).toBe(window.startMs);

    // Dragging the content right by a quarter of the width reveals earlier times.
    const dragged = panByPixels(window, 250, 1000);
    expect(dragged.startMs).toBe(window.startMs - 1.75 * DAY);
    expect(dragged.endMs - dragged.startMs).toBe(7 * DAY);
    expect(panByPixels(window, -250, 1000).startMs).toBe(window.startMs + 1.75 * DAY);
    expect(panByPixels(window, 100, 0)).toEqual(window);
  });

  it('zooms keeping the anchor at the same relative position', () => {
    const window = windowFor('month', NOW);
    const anchor = window.startMs + 0.2 * (window.endMs - window.startMs);
    const zoomed = zoomWindow(window, 'day', anchor);
    expect(zoomed.endMs - zoomed.startMs).toBe(DAY);
    expect((anchor - zoomed.startMs) / DAY).toBeCloseTo(0.2, 6);

    const centered = zoomWindow(window, 'year');
    expect(centered.endMs - centered.startMs).toBe(366 * DAY);
    expect((centered.startMs + centered.endMs) / 2).toBeCloseTo(NOW, -1);
  });

  it('steps between zoom levels and stops at the ends', () => {
    expect(widerZoom('day')).toBe('week');
    expect(widerZoom('month')).toBe('year');
    expect(widerZoom('year')).toBe('year');
    expect(narrowerZoom('year')).toBe('month');
    expect(narrowerZoom('week')).toBe('day');
    expect(narrowerZoom('day')).toBe('day');
  });

  it('starts with now at 85% unless the latest event is older than the window', () => {
    for (const zoom of ZOOM_LEVELS) {
      const today = todayWindow(zoom, NOW);
      const span = ZOOM_SPANS_MS[zoom];
      expect((NOW - today.startMs) / span).toBeCloseTo(0.85, 6);
      expect(initialWindow(zoom, NOW, null)).toEqual(today);
      expect(initialWindow(zoom, NOW, NOW - HOUR)).toEqual(today);
    }

    const old = NOW - 90 * DAY;
    const window = initialWindow('week', NOW, old);
    expect((window.startMs + window.endMs) / 2).toBe(old);
    expect(old >= window.startMs && old < window.endMs).toBe(true);
  });
});

describe('xFor / msFor', () => {
  it('maps the window onto the width and round-trips', () => {
    const window: TimeWindow = { startMs: 1_000, endMs: 11_000 };
    expect(xFor(1_000, window, 500)).toBe(0);
    expect(xFor(11_000, window, 500)).toBe(500);
    expect(xFor(6_000, window, 500)).toBe(250);
    expect(msFor(250, window, 500)).toBe(6_000);

    const week = windowFor('week', NOW);
    for (const ms of [week.startMs, NOW, week.endMs - 1, week.startMs - DAY]) {
      expect(msFor(xFor(ms, week, 1234), week, 1234)).toBeCloseTo(ms, -1);
    }
  });
});

describe('ticksFor', () => {
  it('puts 24 hour ticks on a UTC day with the major at midnight', () => {
    const window = { startMs: Date.parse('2026-10-27T00:00:00.000Z'), endMs: 0 };
    const day = { ...window, endMs: window.startMs + DAY };
    const ticks = ticksFor(day, 'day', 'UTC');
    expect(ticks).toHaveLength(24);
    expect(ticks.map((t) => t.ms)).toEqual(
      Array.from({ length: 24 }, (_, i) => day.startMs + i * HOUR),
    );
    expect(ticks.filter((t) => t.major).map((t) => t.ms)).toEqual([day.startMs]);
    expect(ticks[0]!.label).not.toBe('');
    // Labels every third hour only.
    expect(ticks.filter((t) => t.label !== '')).toHaveLength(8);

    // A day window centered on noon starts at that midnight.
    const centered = ticksFor(windowFor('day', NOW), 'day', 'UTC');
    expect(centered).toHaveLength(24);
    expect(centered.filter((t) => t.major).map((t) => t.ms)).toEqual([
      Date.parse('2026-10-27T00:00:00.000Z'),
    ]);
  });

  it('has 23 and 25 hour ticks on New York DST days', () => {
    const zone = 'America/New_York';
    const spring = { startMs: dayStart('2026-03-08', zone), endMs: dayStart('2026-03-09', zone) };
    const fall = { startMs: dayStart('2026-11-01', zone), endMs: dayStart('2026-11-02', zone) };
    expect(spring.endMs - spring.startMs).toBe(23 * HOUR);
    expect(fall.endMs - fall.startMs).toBe(25 * HOUR);

    const springTicks = ticksFor(spring, 'day', zone);
    const fallTicks = ticksFor(fall, 'day', zone);
    expect(springTicks).toHaveLength(23);
    expect(fallTicks).toHaveLength(25);
    for (const ticks of [springTicks, fallTicks]) {
      expect(ticks.filter((t) => t.major)).toHaveLength(1);
      expect(ticks[0]!.major).toBe(true);
    }
    // The skipped 02:00 never appears; 01:00 appears twice on the fall-back day.
    expect(springTicks.map((t) => localHour(t.ms, zone))).not.toContain(2);
    expect(fallTicks.filter((t) => localHour(t.ms, zone) === 1)).toHaveLength(2);
  });

  it('puts 7 midnights in a week with one Monday major', () => {
    const ticks = ticksFor(windowFor('week', NOW), 'week', 'UTC');
    expect(ticks).toHaveLength(7);
    for (const tick of ticks) {
      expect(tick.ms % DAY).toBe(0);
      expect(tick.label).not.toBe('');
    }
    const majors = ticks.filter((t) => t.major);
    expect(majors).toHaveLength(1);
    expect(new Date(majors[0]!.ms).getUTCDay()).toBe(1);
  });

  it('puts 31 or 32 midnights in a month with the 1st major', () => {
    const ticks = ticksFor(windowFor('month', NOW), 'month', 'UTC');
    expect(ticks.length).toBeGreaterThanOrEqual(31);
    expect(ticks.length).toBeLessThanOrEqual(32);
    const majors = ticks.filter((t) => t.major);
    expect(majors).toHaveLength(1);
    expect(new Date(majors[0]!.ms).getUTCDate()).toBe(1);
    expect(majors[0]!.label).not.toBe('');
    expect(ticks.some((t) => t.label === '')).toBe(true);
  });

  it('puts 12 or 13 month starts in a year with January major', () => {
    const ticks = ticksFor(windowFor('year', NOW), 'year', 'UTC');
    expect(ticks.length).toBeGreaterThanOrEqual(12);
    expect(ticks.length).toBeLessThanOrEqual(13);
    for (const tick of ticks) {
      expect(new Date(tick.ms).getUTCDate()).toBe(1);
      expect(tick.ms % DAY).toBe(0);
      expect(tick.label).not.toBe('');
    }
    const majors = ticks.filter((t) => t.major);
    expect(majors).toHaveLength(1);
    expect(new Date(majors[0]!.ms).getUTCMonth()).toBe(0);
    expect(majors[0]!.label).toContain('2027');
  });

  it('keeps every tick inside the window, sorted', () => {
    const next = random(7);
    for (const zone of ['UTC', 'America/New_York', 'Asia/Jerusalem', 'Asia/Kolkata']) {
      for (const zoom of ZOOM_LEVELS) {
        for (let i = 0; i < 5; i += 1) {
          const window = windowFor(zoom, NOW + Math.round((next() - 0.5) * 800 * DAY));
          const ticks = ticksFor(window, zoom, zone);
          expect(ticks.length).toBeGreaterThan(0);
          for (const [index, tick] of ticks.entries()) {
            expect(tick.ms).toBeGreaterThanOrEqual(window.startMs);
            expect(tick.ms).toBeLessThan(window.endMs);
            if (index > 0) {
              expect(tick.ms).toBeGreaterThan(ticks[index - 1]!.ms);
            }
          }
        }
      }
    }
  });

  it('places Jerusalem midnights on the right instants across DST changes', () => {
    const zone = 'Asia/Jerusalem';
    // Israel leaves DST on 2026-10-25 and enters it on 2026-03-27.
    for (const center of ['2026-10-25T12:00:00.000Z', '2026-03-27T12:00:00.000Z']) {
      const ticks = ticksFor(windowFor('month', Date.parse(center)), 'month', zone);
      expect(ticks.length).toBeGreaterThanOrEqual(30);
      for (const [index, tick] of ticks.entries()) {
        expect(localHour(tick.ms, zone)).toBe(0);
        expect(localDate(tick.ms - 1, zone)).not.toBe(localDate(tick.ms, zone));
        if (index > 0) {
          const previous = ticks[index - 1]!;
          const expected = new Date(Date.parse(`${localDate(previous.ms, zone)}T00:00:00Z`) + DAY);
          expect(localDate(tick.ms, zone)).toBe(expected.toISOString().slice(0, 10));
        }
      }
    }
  });

  it('falls back to UTC for an unknown timezone', () => {
    const window = windowFor('week', NOW);
    expect(ticksFor(window, 'week', 'Not/AZone').map((t) => t.ms)).toEqual(
      ticksFor(window, 'week', 'UTC').map((t) => t.ms),
    );
  });
});

describe('windowLabel', () => {
  it('describes every zoom level', () => {
    for (const zoom of ZOOM_LEVELS) {
      const label = windowLabel(windowFor(zoom, NOW), zoom, 'Asia/Jerusalem');
      expect(label.trim()).not.toBe('');
      expect(label).toContain('2026');
    }
  });
});

describe('layoutMarkers', () => {
  const window: TimeWindow = { startMs: 0, endMs: 1_000_000 };
  const width = 1000; // 1 px per 1000 ms
  const options = { clusterRadiusPx: 8, minGapPx: 20, maxRows: 3 };
  const point = (id: string, x: number): MarkerInput => ({
    id,
    startMs: x * 1000,
    endMs: x * 1000,
  });
  const session = (id: string, x1: number, x2: number): MarkerInput => ({
    id,
    startMs: x1 * 1000,
    endMs: x2 * 1000,
  });

  it('returns nothing when no marker is in the window', () => {
    expect(layoutMarkers([], window, width, options)).toEqual([]);
    expect(
      layoutMarkers(
        [point('before', -50), point('after', 1000), session('s', -100, -10)],
        window,
        width,
        options,
      ),
    ).toEqual([]);
  });

  it('puts far-apart singles in row 0', () => {
    const items = layoutMarkers(
      [point('b', 500), point('a', 100), point('c', 900)],
      window,
      width,
      options,
    );
    expect(items).toEqual([
      { kind: 'single', id: 'a', x1: 100, x2: 100, row: 0 },
      { kind: 'single', id: 'b', x1: 500, x2: 500, row: 0 },
      { kind: 'single', id: 'c', x1: 900, x2: 900, row: 0 },
    ]);
  });

  it('clusters nearby events', () => {
    const items = layoutMarkers(
      [point('a', 100), point('b', 104), session('c', 106, 300), point('far', 600)],
      window,
      width,
      options,
    );
    expect(items).toHaveLength(2);
    const cluster = items[0]!;
    expect(cluster).toMatchObject({ kind: 'cluster', ids: ['a', 'b', 'c'], row: 0 });
    if (cluster.kind === 'cluster') {
      expect(cluster.x).toBeCloseTo((100 + 104 + 106) / 3, 6);
      expect(cluster.startMs).toBe(100_000);
      expect(cluster.endMs).toBe(300_000);
    }
    expect(items[1]).toMatchObject({ kind: 'single', id: 'far', row: 0 });
  });

  it('puts overlapping sessions on different rows', () => {
    const items = layoutMarkers(
      [session('s1', 100, 400), session('s2', 200, 500), point('p', 450), point('q', 700)],
      window,
      width,
      options,
    );
    const rowOf = (id: string) => items.find((i) => i.kind === 'single' && i.id === id)?.row;
    expect(rowOf('s1')).toBe(0);
    expect(rowOf('s2')).toBe(1);
    expect(rowOf('p')).toBe(0); // 50 px after s1 ends
    expect(rowOf('q')).toBe(0);
  });

  it('clamps sessions that extend beyond the window', () => {
    const items = layoutMarkers([session('long', -500, 1500)], window, width, options);
    expect(items).toEqual([{ kind: 'single', id: 'long', x1: 0, x2: 1000, row: 0 }]);
  });

  it('is deterministic regardless of input order', () => {
    const next = random(42);
    const markers: MarkerInput[] = Array.from({ length: 300 }, (_, i) => {
      const start = Math.round(next() * 1_200_000) - 100_000;
      const length = next() < 0.3 ? Math.round(next() * 80_000) : 0;
      return { id: `m${i}`, startMs: start, endMs: start + length };
    });
    const expected = layoutMarkers(markers, window, width, options);
    for (const seed of [1, 2, 3]) {
      expect(layoutMarkers(shuffled(markers, seed), window, width, options)).toEqual(expected);
    }
  });

  it('never drops markers and respects the row limit', () => {
    const next = random(9);
    const markers: MarkerInput[] = Array.from({ length: 1000 }, (_, i) => {
      const start = Math.round(next() * 1_400_000) - 200_000;
      const length = next() < 0.4 ? Math.round(next() * 200_000) : 0;
      return { id: `m${i}`, startMs: start, endMs: start + length };
    });
    const inWindow = markers.filter((m) => m.endMs >= window.startMs && m.startMs < window.endMs);
    const items = layoutMarkers(markers, window, width, {
      clusterRadiusPx: 4,
      minGapPx: 30,
      maxRows: 2,
    });
    expect(idCount(items)).toBe(inWindow.length);
    const ids = items.flatMap((i) => (i.kind === 'single' ? [i.id] : i.ids));
    expect(new Set(ids).size).toBe(inWindow.length);
    for (const item of items) {
      expect(item.row).toBeGreaterThanOrEqual(0);
      expect(item.row).toBeLessThan(2);
    }
  });

  it('lays out 5,000 markers in under 200 ms', () => {
    const next = random(5);
    const year = windowFor('year', NOW);
    const markers: MarkerInput[] = Array.from({ length: 5000 }, (_, i) => {
      const start = year.startMs + Math.round(next() * 366 * DAY);
      const length = next() < 0.3 ? Math.round(next() * 3 * HOUR) : 0;
      return { id: `m${i}`, startMs: start, endMs: start + length };
    });
    const started = performance.now();
    const items = layoutMarkers(markers, year, 1200, {
      clusterRadiusPx: 6,
      minGapPx: 14,
      maxRows: 4,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(200);
    expect(idCount(items)).toBe(5000);
  });
});
