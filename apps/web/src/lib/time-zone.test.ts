import { describe, expect, it } from 'vitest';

import { nextDay, startOfDayInZone, utcToZonedLocal, zonedLocalToUtc } from './time-zone';

describe('time zones', () => {
  it('converts wall-clock time in a zone to UTC and back', () => {
    expect(zonedLocalToUtc('2026-10-03T09:30', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-03T07:30:00.000Z',
    );
    expect(zonedLocalToUtc('2026-01-15T09:30', 'Europe/Berlin').toISOString()).toBe(
      '2026-01-15T08:30:00.000Z',
    );
    expect(zonedLocalToUtc('2026-10-03T09:30', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-03T04:00:00.000Z',
    );
    expect(utcToZonedLocal('2026-10-03T07:30:00Z', 'Europe/Berlin')).toBe('2026-10-03T09:30');
    expect(utcToZonedLocal('2026-10-03T23:30:00Z', 'America/New_York')).toBe('2026-10-03T19:30');
    expect(zonedLocalToUtc('2026-10-03T09:30', 'UTC').toISOString()).toBe(
      '2026-10-03T09:30:00.000Z',
    );
  });

  it('round-trips across a DST change and rolls non-existent times forward', () => {
    // Europe/Berlin springs forward on 2026-03-29 at 02:00 → 03:00.
    expect(zonedLocalToUtc('2026-03-29T01:30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(zonedLocalToUtc('2026-03-29T03:30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    const gap = zonedLocalToUtc('2026-03-29T02:30', 'Europe/Berlin');
    expect(utcToZonedLocal(gap, 'Europe/Berlin')).toBe('2026-03-29T03:30');
  });

  it('computes day boundaries in the zone', () => {
    expect(startOfDayInZone('2026-10-03', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-02T22:00:00.000Z',
    );
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });

  it('rejects malformed input', () => {
    expect(() => zonedLocalToUtc('03/10/2026 9:30', 'UTC')).toThrow(RangeError);
  });
});
