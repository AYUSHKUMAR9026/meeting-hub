/**
 * Upload speed over a sliding window (default 8 s), so the number reacts to a changing connection
 * without jumping around on every progress event.
 */
export class SpeedMeter {
  private samples: { at: number; bytes: number }[] = [];

  constructor(
    private readonly windowMs = 8_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records the total bytes uploaded so far; returns bytes per second (0 until measurable). */
  update(totalBytes: number): number {
    const at = this.now();
    this.samples.push({ at, bytes: totalBytes });
    while (this.samples.length > 2 && at - this.samples[0]!.at > this.windowMs)
      this.samples.shift();
    return this.bytesPerSecond();
  }

  bytesPerSecond(): number {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last.at - first.at < 500) return 0;
    return Math.max(0, ((last.bytes - first.bytes) * 1000) / (last.at - first.at));
  }

  reset() {
    this.samples = [];
  }
}

/** Seconds left at the current speed, or null when it can't be estimated yet. */
export function etaSeconds(remainingBytes: number, bytesPerSecond: number): number | null {
  if (remainingBytes <= 0) return 0;
  if (bytesPerSecond <= 0) return null;
  return Math.ceil(remainingBytes / bytesPerSecond);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 1536 → "1.5 KB" (binary multiples, labelled the way people read them). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${UNITS[unit]}`;
}

/** 3725 → "1 h 2 min", 95 → "1 min 35 s", 7 → "7 s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min${sec ? ` ${sec} s` : ''}`;
  return `${sec} s`;
}
