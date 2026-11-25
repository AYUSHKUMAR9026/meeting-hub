import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PermanentError } from '../../lib/errors';
import { speechPcmArgs, speechChunkArgs } from './ffmpeg/args';
import { runProcess } from './ffmpeg/process';

export interface SpeechRange {
  startMs: number;
  endMs: number;
  trimmedStartMs: number;
}
export interface EnergyFrame {
  startMs: number;
  rms: number;
}
export interface SpeechAudio {
  path: string;
  durationMs: number;
  ranges: SpeechRange[];
  frames: EnergyFrame[];
}
export interface SpeechTools {
  ffmpegPath: string;
  threads: number;
  maxDurationSeconds: number;
}

export function speechRanges(
  frames: readonly EnergyFrame[],
  durationMs: number,
  threshold = 0.01,
  paddingMs = 150,
): SpeechRange[] {
  const spans: { startMs: number; endMs: number }[] = [];
  for (const frame of frames) {
    if (frame.rms < threshold) continue;
    const startMs = Math.max(0, frame.startMs - paddingMs);
    const endMs = Math.min(durationMs, frame.startMs + 20 + paddingMs);
    const previous = spans.at(-1);
    if (previous && startMs <= previous.endMs) previous.endMs = endMs;
    else spans.push({ startMs, endMs });
  }
  let trimmed = 0;
  return spans.map((span) => {
    const result = { ...span, trimmedStartMs: trimmed };
    trimmed += span.endMs - span.startMs;
    return result;
  });
}

export function originalTime(
  ranges: readonly SpeechRange[],
  trimmedMs: number,
  end = false,
): number {
  const range =
    ranges.find((r) =>
      end
        ? trimmedMs <= r.trimmedStartMs + r.endMs - r.startMs
        : trimmedMs < r.trimmedStartMs + r.endMs - r.startMs,
    ) ?? ranges.at(-1);
  if (!range) return 0;
  return Math.round(
    Math.min(range.endMs, range.startMs + Math.max(0, trimmedMs - range.trimmedStartMs)),
  );
}

export interface SpeechChunk {
  startMs: number;
  endMs: number;
  ranges: { startMs: number; endMs: number }[];
}
export function planSpeechChunks(
  ranges: readonly SpeechRange[],
  maxMs = 300000,
  overlapMs = 1000,
): SpeechChunk[] {
  if (maxMs <= overlapMs || overlapMs < 0) throw new Error('Invalid speech chunk overlap');
  const total = ranges.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
  const chunks: SpeechChunk[] = [];
  for (let start = 0; start < total;) {
    let end = Math.min(total, start + maxMs);
    const intersecting = ranges.filter(
      (r) => r.trimmedStartMs + r.endMs - r.startMs > start && r.trimmedStartMs < end,
    );
    if (intersecting.length > 100)
      end = intersecting[99]!.trimmedStartMs + intersecting[99]!.endMs - intersecting[99]!.startMs;
    const selected = intersecting.slice(0, 100).map((r) => ({
      startMs: r.startMs + Math.max(0, start - r.trimmedStartMs),
      endMs: r.endMs - Math.max(0, r.trimmedStartMs + r.endMs - r.startMs - end),
    }));
    chunks.push({ startMs: start, endMs: end, ranges: selected });
    if (end >= total) break;
    start = Math.max(start + 1, end - Math.min(overlapMs, (end - start) / 2));
  }
  return chunks;
}

export function windowRms(frames: readonly EnergyFrame[], startMs: number, endMs: number) {
  let sum = 0;
  let count = 0;
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (frames[mid]!.startMs < startMs) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < frames.length && frames[i]!.startMs < endMs; i++) {
    const frame = frames[i]!;
    sum += frame.rms ** 2;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

export async function prepareSpeechAudio(
  input: string,
  dir: string,
  tools: SpeechTools,
  signal: AbortSignal,
): Promise<SpeechAudio> {
  const path = join(dir, 'speech.pcm');
  const decoded = await runProcess(
    tools.ffmpegPath,
    speechPcmArgs({
      inputPath: input,
      outputPath: path,
      threads: tools.threads,
      maxSeconds: tools.maxDurationSeconds,
    }),
    { signal, timeoutMs: 600000 },
  );
  if (decoded.exitCode !== 0)
    throw new PermanentError(
      'TRANSCRIPTION_AUDIO_REJECTED',
      'The recording could not be decoded for transcription.',
    );
  const frames: EnergyFrame[] = [];
  let pending = Buffer.alloc(0);
  let sample = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    const bytes = Buffer.concat([pending, chunk as Buffer]);
    let offset = 0;
    for (; offset + 640 <= bytes.length; offset += 640) {
      let square = 0;
      for (let j = 0; j < 640; j += 2) square += (bytes.readInt16LE(offset + j) / 32768) ** 2;
      frames.push({ startMs: sample / 16, rms: Math.sqrt(square / 320) });
      sample += 320;
    }
    pending = bytes.subarray(offset);
  }
  if (pending.length >= 2) {
    let square = 0;
    for (let j = 0; j + 1 < pending.length; j += 2) square += (pending.readInt16LE(j) / 32768) ** 2;
    frames.push({ startMs: sample / 16, rms: Math.sqrt(square / Math.floor(pending.length / 2)) });
  }
  const durationMs = Math.floor((await stat(path)).size / 32);
  return { path, durationMs, frames, ranges: speechRanges(frames, durationMs) };
}

export async function renderSpeechChunk(
  audio: SpeechAudio,
  chunk: SpeechChunk,
  output: string,
  tools: SpeechTools,
  signal: AbortSignal,
) {
  const result = await runProcess(
    tools.ffmpegPath,
    speechChunkArgs({
      inputPath: audio.path,
      outputPath: output,
      ranges: chunk.ranges,
      threads: tools.threads,
    }),
    { signal, timeoutMs: 120000 },
  );
  if (result.exitCode !== 0)
    throw new PermanentError(
      'TRANSCRIPTION_AUDIO_REJECTED',
      'Speech could not be prepared for transcription.',
    );
  if ((await stat(output)).size >= 24000000)
    throw new PermanentError(
      'TRANSCRIPTION_CHUNK_TOO_LARGE',
      'The prepared audio exceeds the free transcription file limit.',
    );
}
