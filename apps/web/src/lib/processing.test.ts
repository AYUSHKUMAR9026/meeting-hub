import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatElapsed,
  isRunActive,
  phaseLabel,
  refreshDelayMs,
  runElapsedMs,
  stepLabel,
} from './processing';

describe('processing display helpers', () => {
  it('labels known and future steps', () => {
    expect(stepLabel('prepare_media')).toBe('Preparing audio');
    expect(stepLabel('speaker_naming')).toBe('Speaker naming');
    expect(phaseLabel('transcoding')).toBe('Converting audio');
    expect(phaseLabel(null)).toBeNull();
  });

  it('knows which run statuses are still going', () => {
    expect(isRunActive('queued')).toBe(true);
    expect(isRunActive('preparing_media')).toBe(true);
    expect(isRunActive('completed')).toBe(false);
    expect(isRunActive('failed')).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });

  it('formats elapsed time and media durations', () => {
    expect(formatElapsed(45_400)).toBe('45 s');
    expect(formatElapsed(185_000)).toBe('3 min 05 s');
    expect(formatElapsed(3_725_000)).toBe('1 h 02 min');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_729_000)).toBe('1:02:09');
  });

  it('measures a run until it finished, or until now', () => {
    const createdAt = '2026-10-04T10:00:00.000Z';
    const now = Date.parse('2026-10-04T10:00:30.000Z');
    expect(runElapsedMs({ createdAt, finishedAt: null }, now)).toBe(30_000);
    expect(runElapsedMs({ createdAt, finishedAt: '2026-10-04T10:00:12.000Z' }, now)).toBe(12_000);
  });

  it('refreshes signed URLs a minute before they expire, never too eagerly', () => {
    const now = Date.parse('2026-10-04T10:00:00.000Z');
    expect(refreshDelayMs('2026-10-04T10:15:00.000Z', now)).toBe(14 * 60_000);
    expect(refreshDelayMs('2026-10-04T10:01:00.000Z', now)).toBe(30_000);
    expect(refreshDelayMs('2026-10-04T10:00:02.000Z', now)).toBe(5_000);
  });
});
