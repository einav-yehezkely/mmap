/** Home page helpers: greetings in the workspace timezone and relative times. */

import { describe, expect, it } from 'vitest';

import { greeting, relativeTime } from './home-model';

describe('greeting', () => {
  it('follows the local time of the workspace timezone', () => {
    const at = Date.parse('2026-10-27T05:30:00.000Z');
    expect(greeting(at, 'UTC')).toBe('Good morning');
    expect(greeting(at, 'America/Los_Angeles')).toBe('Good evening'); // 22:30 the day before
    expect(greeting(Date.parse('2026-10-27T13:00:00.000Z'), 'UTC')).toBe('Good afternoon');
    expect(greeting(at, 'Not/AZone')).toBe('Good morning');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  it('describes how long ago something happened', () => {
    expect(relativeTime('2026-10-27T11:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-27T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-10-27T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-10-26T10:00:00.000Z', now)).toBe('yesterday');
    expect(relativeTime('2026-10-06T12:00:00.000Z', now)).toBe('3 weeks ago');
    expect(relativeTime('2026-10-27T13:00:00.000Z', now)).toBe('just now');
  });
});
