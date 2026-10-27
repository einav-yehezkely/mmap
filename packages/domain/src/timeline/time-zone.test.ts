import { describe, expect, it } from 'vitest';

import { isDomainError } from '../errors';
import {
  isValidTimeZone,
  localDateOf,
  localDateRangeToUtc,
  startOfLocalDayUtc,
  validateTimeZone,
} from './time-zone';

const HOUR_MS = 60 * 60 * 1_000;

/** Length in hours of the local day `date`, measured through the half-open UTC range. */
function dayLengthHours(date: string, timeZone: string): number {
  const { fromUtc, toUtcExclusive } = localDateRangeToUtc(date, date, timeZone);
  return (Date.parse(toUtcExclusive ?? '') - Date.parse(fromUtc ?? '')) / HOUR_MS;
}

/** Local wall-clock time `HH:MM:SS` of `utc` in `timeZone`, read independently of the module. */
function localTimeOf(utc: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(utc));
}

function expectValidationError(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(isDomainError(error) && error.code).toBe('VALIDATION_FAILED');
    return;
  }
  throw new Error('Expected a VALIDATION_FAILED error.');
}

function everyDateOf(year: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.UTC(year, 0, 1); ms < Date.UTC(year + 1, 0, 1); ms += 24 * HOUR_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

describe('isValidTimeZone / validateTimeZone', () => {
  it.each(['UTC', 'Asia/Jerusalem', 'America/New_York', 'Pacific/Kiritimati', 'Etc/GMT+2'])(
    'accepts %s',
    (timeZone) => {
      expect(isValidTimeZone(timeZone)).toBe(true);
      expect(validateTimeZone(timeZone)).toBe(timeZone);
    },
  );

  it.each(['', 'Mars/Olympus_Mons', 'Asia/Jerusalem ', '+02:00', 'not a zone'])(
    'rejects %j',
    (timeZone) => {
      expect(isValidTimeZone(timeZone)).toBe(false);
      expect(() => validateTimeZone(timeZone)).toThrow('This timezone is not recognized.');
      expectValidationError(() => validateTimeZone(timeZone));
    },
  );

  it('rejects an unknown timezone in every conversion', () => {
    expectValidationError(() => localDateOf('2026-03-29T10:00:00.000Z', 'Nowhere/City'));
    expectValidationError(() => startOfLocalDayUtc('2026-03-29', 'Nowhere/City'));
    expectValidationError(() => localDateRangeToUtc(null, null, 'Nowhere/City'));
  });
});

describe('UTC', () => {
  it('maps local dates to UTC midnights', () => {
    expect(startOfLocalDayUtc('2026-03-29', 'UTC')).toBe('2026-03-29T00:00:00.000Z');
    expect(localDateRangeToUtc('2026-03-29', '2026-03-31', 'UTC')).toEqual({
      fromUtc: '2026-03-29T00:00:00.000Z',
      toUtcExclusive: '2026-04-01T00:00:00.000Z',
    });
  });

  it('reads the UTC calendar date', () => {
    expect(localDateOf('2026-12-31T23:59:59.999Z', 'UTC')).toBe('2026-12-31');
    expect(localDateOf('2027-01-01T00:00:00.000Z', 'UTC')).toBe('2027-01-01');
  });
});

describe('Asia/Jerusalem', () => {
  const tz = 'Asia/Jerusalem';

  it('uses UTC+2 in winter and UTC+3 in summer', () => {
    expect(startOfLocalDayUtc('2026-01-15', tz)).toBe('2026-01-14T22:00:00.000Z');
    expect(startOfLocalDayUtc('2026-07-01', tz)).toBe('2026-06-30T21:00:00.000Z');
  });

  it('switches to DST on 2026-03-27 at 02:00, a 23-hour day', () => {
    // Confirm the runtime's tz data agrees before relying on it.
    expect(localTimeOf('2026-03-27T00:00:00.000Z', tz)).toBe('03:00:00');
    expect(localDateRangeToUtc('2026-03-27', '2026-03-27', tz)).toEqual({
      fromUtc: '2026-03-26T22:00:00.000Z',
      toUtcExclusive: '2026-03-27T21:00:00.000Z',
    });
    expect(dayLengthHours('2026-03-27', tz)).toBe(23);
  });

  it('leaves DST on 2026-10-25, a 25-hour day', () => {
    expect(localDateRangeToUtc('2026-10-25', '2026-10-25', tz)).toEqual({
      fromUtc: '2026-10-24T21:00:00.000Z',
      toUtcExclusive: '2026-10-25T22:00:00.000Z',
    });
    expect(dayLengthHours('2026-10-25', tz)).toBe(25);
  });

  it.each([
    ['2026-01-14T21:59:59.999Z', '2026-01-14'],
    ['2026-01-14T22:00:00.000Z', '2026-01-15'],
    ['2026-06-30T20:59:59.999Z', '2026-06-30'],
    ['2026-06-30T21:00:00.000Z', '2026-07-01'],
    ['2026-03-26T21:59:59.999Z', '2026-03-26'],
    ['2026-03-26T22:00:00.000Z', '2026-03-27'],
  ])('localDateOf(%s) is %s near midnight', (utc, expected) => {
    expect(localDateOf(utc, tz)).toBe(expected);
  });
});

describe('America/New_York', () => {
  const tz = 'America/New_York';

  it('spring forward on 2026-03-08 makes a 23-hour day', () => {
    expect(localDateRangeToUtc('2026-03-08', '2026-03-08', tz)).toEqual({
      fromUtc: '2026-03-08T05:00:00.000Z',
      toUtcExclusive: '2026-03-09T04:00:00.000Z',
    });
    expect(dayLengthHours('2026-03-08', tz)).toBe(23);
  });

  it('fall back on 2026-11-01 makes a 25-hour day', () => {
    expect(localDateRangeToUtc('2026-11-01', '2026-11-01', tz)).toEqual({
      fromUtc: '2026-11-01T04:00:00.000Z',
      toUtcExclusive: '2026-11-02T05:00:00.000Z',
    });
    expect(dayLengthHours('2026-11-01', tz)).toBe(25);
  });

  it('ordinary days are 24 hours long', () => {
    expect(dayLengthHours('2026-06-15', tz)).toBe(24);
    expect(dayLengthHours('2026-12-15', tz)).toBe(24);
  });
});

describe('DST transitions at midnight', () => {
  // Zones whose clocks jump from 23:59:59 straight to 01:00:00. The first case relies on current
  // Chilean rules; the second is historical Brazilian DST, kept as a fallback for older tz data.
  const gapCases = [
    { tz: 'America/Santiago', date: '2026-09-06', start: '2026-09-06T03:00:00.000Z' },
    { tz: 'America/Sao_Paulo', date: '2018-11-04', start: '2018-11-04T03:00:00.000Z' },
  ];
  const hasMidnightGap = ({ tz, start }: (typeof gapCases)[number]) =>
    localTimeOf(start, tz) === '01:00:00' &&
    localTimeOf(new Date(Date.parse(start) - 1_000).toISOString(), tz) === '23:59:59';
  const gapCase = gapCases.find(hasMidnightGap);

  it('starts a day without a midnight at the transition instant', () => {
    expect(gapCase).toBeDefined();
    if (gapCase === undefined) return;
    const { tz, date, start } = gapCase;

    expect(startOfLocalDayUtc(date, tz)).toBe(start);
    expect(localDateOf(start, tz)).toBe(date);
    expect(localDateOf(new Date(Date.parse(start) - 1).toISOString(), tz)).not.toBe(date);
    expect(dayLengthHours(date, tz)).toBe(23);
  });

  it('starts a day with two midnights at the earlier one', () => {
    // Cuba falls back from 01:00 to 00:00 on 2026-11-01, so midnight happens at 04:00Z and 05:00Z.
    const tz = 'America/Havana';
    expect(localTimeOf('2026-11-01T05:00:00.000Z', tz)).toBe('00:00:00');
    expect(startOfLocalDayUtc('2026-11-01', tz)).toBe('2026-11-01T04:00:00.000Z');
    expect(dayLengthHours('2026-11-01', tz)).toBe(25);
  });
});

describe('extreme offsets', () => {
  const instant = '2026-03-29T10:00:00.000Z';

  it('Pacific/Kiritimati (UTC+14) is already on the next date', () => {
    expect(localDateOf(instant, 'Pacific/Kiritimati')).toBe('2026-03-30');
    expect(startOfLocalDayUtc('2026-03-30', 'Pacific/Kiritimati')).toBe('2026-03-29T10:00:00.000Z');
  });

  it('Pacific/Pago_Pago (UTC-11) is still on the previous date', () => {
    expect(localDateOf(instant, 'Pacific/Pago_Pago')).toBe('2026-03-28');
    expect(startOfLocalDayUtc('2026-03-29', 'Pacific/Pago_Pago')).toBe('2026-03-29T11:00:00.000Z');
  });
});

describe('input validation', () => {
  it.each([
    '2026-02-30',
    '2026-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-4-01',
    '26-04-01',
    '0999-01-01',
    '2026-04-01T00:00:00.000Z',
    ' 2026-04-01',
    '',
  ])('rejects the date %j', (date) => {
    expectValidationError(() => startOfLocalDayUtc(date, 'UTC'));
    expectValidationError(() => localDateRangeToUtc(date, null, 'UTC'));
    expectValidationError(() => localDateRangeToUtc(null, date, 'UTC'));
  });

  it('accepts leap days', () => {
    expect(startOfLocalDayUtc('2024-02-29', 'UTC')).toBe('2024-02-29T00:00:00.000Z');
  });

  it.each(['yesterday', '2026-03-29', '2026-03-29T10:00:00', '2026-03-32T10:00:00.000Z'])(
    'localDateOf rejects the timestamp %j',
    (utc) => {
      expectValidationError(() => localDateOf(utc, 'UTC'));
    },
  );

  it('localDateOf accepts ISO instants with an explicit offset', () => {
    expect(localDateOf('2026-03-29T01:00:00+03:00', 'UTC')).toBe('2026-03-28');
  });
});

describe('localDateRangeToUtc', () => {
  it('rejects a start date after the end date', () => {
    expectValidationError(() => localDateRangeToUtc('2026-03-30', '2026-03-29', 'UTC'));
  });

  it('allows a single-day range', () => {
    expect(dayLengthHours('2026-03-29', 'UTC')).toBe(24);
  });

  it('leaves null bounds open', () => {
    const tz = 'Asia/Jerusalem';
    expect(localDateRangeToUtc(null, null, tz)).toEqual({ fromUtc: null, toUtcExclusive: null });
    expect(localDateRangeToUtc('2026-01-15', null, tz)).toEqual({
      fromUtc: '2026-01-14T22:00:00.000Z',
      toUtcExclusive: null,
    });
    expect(localDateRangeToUtc(null, '2026-01-15', tz)).toEqual({
      fromUtc: null,
      toUtcExclusive: '2026-01-15T22:00:00.000Z',
    });
  });

  it('ends a range that closes on December 31 at the start of the next year', () => {
    expect(localDateRangeToUtc('2026-12-31', '2026-12-31', 'Asia/Jerusalem')).toEqual({
      fromUtc: '2026-12-30T22:00:00.000Z',
      toUtcExclusive: '2026-12-31T22:00:00.000Z',
    });
  });
});

describe('round trip', () => {
  const zones = [
    'UTC',
    'Asia/Jerusalem',
    'America/New_York',
    'America/Santiago',
    'Pacific/Kiritimati',
  ];

  it.each(zones)('every day of 2026 starts on that day and lasts 23–25 hours in %s', (tz) => {
    for (const date of everyDateOf(2026)) {
      const start = startOfLocalDayUtc(date, tz);
      expect(localDateOf(start, tz)).toBe(date);
      expect(localDateOf(new Date(Date.parse(start) - 1).toISOString(), tz)).not.toBe(date);
      expect([23, 24, 25]).toContain(dayLengthHours(date, tz));
    }
  });
});
