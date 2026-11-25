import { describe, expect, it } from 'vitest';

import {
  bucketDate,
  completionRate,
  csv,
  isOverdue,
  localDate,
  shiftDate,
} from '../src/modules/progress/metrics';
import { progressQuerySchema } from '@meeting-hub/contracts';

describe('progress calendar metrics', () => {
  it('uses workspace dates across DST short and long days', () => {
    expect(localDate(new Date('2026-03-08T04:59:00Z'), 'America/New_York')).toBe('2026-03-07');
    expect(localDate(new Date('2026-03-08T07:01:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDate(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(localDate(new Date('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(shiftDate('2026-03-08', 1)).toBe('2026-03-09');
    expect(shiftDate('2026-11-01', 1)).toBe('2026-11-02');
    expect(localDate(new Date('2026-11-24T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-25');
  });
  it('starts weeks on Monday across years', () => {
    expect(bucketDate('2026-01-01', 'week')).toBe('2025-12-29');
    expect(bucketDate('2026-11-22', 'week')).toBe('2026-11-16');
    expect(bucketDate('2026-11-23', 'week')).toBe('2026-11-23');
    expect(bucketDate('2026-11-23', 'day')).toBe('2026-11-23');
  });
  it('only counts open items before today as overdue', () => {
    expect(isOverdue('open', '2026-11-24', '2026-11-25')).toBe(true);
    expect(isOverdue('open', '2026-11-25', '2026-11-25')).toBe(false);
    expect(isOverdue('done', '2026-11-24', '2026-11-25')).toBe(false);
    expect(isOverdue('rejected', '2026-11-24', '2026-11-25')).toBe(false);
    expect(isOverdue('open', null, '2026-11-25')).toBe(false);
    expect(completionRate(0, 0)).toBe(0);
    expect(completionRate(2, 1)).toBe(33.3);
  });
  it('bounds inclusive ranges and meeting limits', () => {
    expect(progressQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-01' }).success).toBe(
      true,
    );
    expect(progressQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success).toBe(
      false,
    );
    expect(progressQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(progressQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(progressQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
  it('escapes CSV commas, quotes, newlines and spreadsheet formulas', () => {
    expect(csv([{ name: 'A,"B"\nC', value: '=SUM(A1)' }])).toBe(
      '"name","value"\r\n"A,""B""\nC","\'=SUM(A1)"\r\n',
    );
    expect(csv([])).toBe('');
  });
});
