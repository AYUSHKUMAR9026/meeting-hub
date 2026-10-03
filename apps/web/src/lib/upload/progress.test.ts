import { describe, expect, it } from 'vitest';

import { etaSeconds, formatBytes, formatDuration, SpeedMeter } from './progress';
import { checkRecordingFile } from './validate';

describe('SpeedMeter', () => {
  it('reports bytes per second over a sliding window', () => {
    let now = 0;
    const meter = new SpeedMeter(8_000, () => now);
    expect(meter.update(0)).toBe(0);
    now = 1_000;
    expect(meter.update(1_000_000)).toBe(1_000_000);
    now = 20_000;
    meter.update(5_000_000);
    now = 21_000;
    // Old samples fell out of the window: only the last second counts.
    expect(meter.update(6_000_000)).toBe(1_000_000);
  });
});

describe('formatting', () => {
  it('estimates time left, or null when the speed is unknown', () => {
    expect(etaSeconds(10_000_000, 1_000_000)).toBe(10);
    expect(etaSeconds(10, 0)).toBeNull();
    expect(etaSeconds(0, 0)).toBe(0);
  });

  it('formats sizes and durations for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
    expect(formatBytes(150 * 1024 ** 2)).toBe('150 MB');
    expect(formatDuration(7)).toBe('7 s');
    expect(formatDuration(95)).toBe('1 min 35 s');
    expect(formatDuration(3725)).toBe('1 h 2 min');
  });
});

describe('checkRecordingFile', () => {
  it('accepts allowed recordings, inferring the type from the extension if needed', () => {
    expect(checkRecordingFile({ name: 'a.m4a', type: '', size: 10 })).toEqual({
      ok: true,
      contentType: 'audio/mp4',
    });
  });

  it('explains wrong types, empty files and files over the limit', () => {
    const errorOf = (file: { name: string; type: string; size: number }) => {
      const check = checkRecordingFile(file);
      return check.ok ? null : check.error;
    };
    expect(errorOf({ name: 'notes.pdf', type: 'application/pdf', size: 10 })).toContain(
      "isn't a supported recording",
    );
    expect(errorOf({ name: 'a.mp3', type: 'audio/mpeg', size: 0 })).toContain('empty');
    expect(errorOf({ name: 'a.mp3', type: 'audio/mpeg', size: 3 * 1024 ** 3 })).toContain(
      '2 GB limit',
    );
  });
});
