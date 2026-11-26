import { describe, expect, it } from 'vitest';

import { normalizeTimezone, timezoneSchema } from './workspaces';

describe('workspace time zones', () => {
  it('accepts browser and PostgreSQL names for the India time zone', () => {
    for (const timezone of ['Asia/Calcutta', 'Asia/Kolkata']) {
      expect(timezoneSchema.parse(timezone)).toBe(timezone);
      expect(normalizeTimezone(timezone)).toBe('Asia/Kolkata');
    }
  });

  it('preserves other supported zones and rejects invalid input', () => {
    for (const timezone of ['UTC', 'Europe/Berlin']) {
      expect(normalizeTimezone(timezoneSchema.parse(timezone))).toBe(timezone);
    }
    expect(timezoneSchema.safeParse('not-a-timezone').success).toBe(false);
  });
});
