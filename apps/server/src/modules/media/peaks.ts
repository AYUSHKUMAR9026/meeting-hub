/**
 * Waveform peaks (ADR 0004): min/max pairs at 10 points per second, capped at 4,000 points
 * whatever the duration. Output follows audiowaveform's JSON layout (8-bit values) so waveform
 * libraries can read it directly.
 */

export const PEAKS_POINTS_PER_SECOND = 10;
export const MAX_PEAK_POINTS = 4_000;

export interface PeaksJson {
  version: 2;
  channels: 1;
  sample_rate: number;
  samples_per_pixel: number;
  bits: 8;
  length: number;
  /** [min0, max0, min1, max1, …], each in -128..127. */
  data: number[];
}

/**
 * Collects min/max per base window (sampleRate / 10 samples) from a stream of signed 16-bit
 * little-endian mono PCM chunks. Chunks may split a sample; the odd byte is carried over.
 */
export class PeaksAccumulator {
  readonly samplesPerWindow: number;
  private mins: number[] = [];
  private maxs: number[] = [];
  private windowMin = 0;
  private windowMax = 0;
  private inWindow = 0;
  private carry: number | null = null;
  private total = 0;

  constructor(readonly sampleRate: number) {
    this.samplesPerWindow = Math.max(1, Math.round(sampleRate / PEAKS_POINTS_PER_SECOND));
  }

  /** Samples seen so far. */
  get sampleCount(): number {
    return this.total;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.add(Buffer.from([this.carry, chunk[0]!]).readInt16LE(0));
      this.carry = null;
      offset = 1;
    }
    const end = chunk.length - ((chunk.length - offset) % 2);
    for (let i = offset; i < end; i += 2) this.add(chunk.readInt16LE(i));
    if (end < chunk.length) this.carry = chunk[end]!;
  }

  private add(sample: number): void {
    if (this.inWindow === 0) {
      this.windowMin = sample;
      this.windowMax = sample;
    } else {
      if (sample < this.windowMin) this.windowMin = sample;
      if (sample > this.windowMax) this.windowMax = sample;
    }
    this.total += 1;
    this.inWindow += 1;
    if (this.inWindow === this.samplesPerWindow) this.flush();
  }

  private flush(): void {
    if (this.inWindow === 0) return;
    this.mins.push(this.windowMin);
    this.maxs.push(this.windowMax);
    this.inWindow = 0;
  }

  /** Finishes the last partial window and returns the peaks, downsampled to the cap. */
  finish(maxPoints = MAX_PEAK_POINTS): PeaksJson {
    this.flush();
    const { mins, maxs, factor } = downsamplePeaks(this.mins, this.maxs, maxPoints);
    const data: number[] = [];
    for (let i = 0; i < mins.length; i++) data.push(toInt8(mins[i]!), toInt8(maxs[i]!));
    return {
      version: 2,
      channels: 1,
      sample_rate: this.sampleRate,
      samples_per_pixel: this.samplesPerWindow * factor,
      bits: 8,
      length: mins.length,
      data,
    };
  }
}

/**
 * Merges consecutive windows so there are at most `maxPoints` (min of mins, max of maxes).
 * `factor` is how many input windows each output point covers.
 */
export function downsamplePeaks(
  mins: readonly number[],
  maxs: readonly number[],
  maxPoints: number,
): { mins: number[]; maxs: number[]; factor: number } {
  if (mins.length !== maxs.length) throw new Error('mins and maxs must have the same length');
  if (!Number.isInteger(maxPoints) || maxPoints < 1) throw new Error('maxPoints must be >= 1');
  const factor = Math.max(1, Math.ceil(mins.length / maxPoints));
  if (factor === 1) return { mins: [...mins], maxs: [...maxs], factor };
  const outMins: number[] = [];
  const outMaxs: number[] = [];
  for (let start = 0; start < mins.length; start += factor) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < Math.min(start + factor, mins.length); i++) {
      if (mins[i]! < lo) lo = mins[i]!;
      if (maxs[i]! > hi) hi = maxs[i]!;
    }
    outMins.push(lo);
    outMaxs.push(hi);
  }
  return { mins: outMins, maxs: outMaxs, factor };
}

/** 16-bit sample → 8-bit (-128..127), as audiowaveform does. */
export const toInt8 = (sample: number) => Math.max(-128, Math.min(127, sample >> 8));
