import { z } from 'zod';

import { PermanentError } from '../../../lib/errors';

/** Shorter recordings can't be meetings (and break downstream steps). */
export const MIN_DURATION_MS = 1_000;

/** Stable error codes for media that can never be processed (ADR 0004). */
export const MEDIA_ERRORS = {
  unreadable: 'UNREADABLE_MEDIA',
  noAudio: 'NO_AUDIO_STREAM',
  tooShort: 'MEDIA_TOO_SHORT',
  tooLong: 'MEDIA_TOO_LONG',
  tooLarge: 'MEDIA_TOO_LARGE',
} as const;

const numeric = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => {
    const n = typeof v === 'string' ? Number.parseFloat(v) : v;
    return n !== undefined && Number.isFinite(n) ? n : null;
  });

const ffprobeOutput = z.object({
  streams: z
    .array(
      z.object({
        index: z.number().int(),
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        sample_rate: numeric,
        channels: z.number().int().optional(),
        duration: numeric,
        disposition: z.object({ default: z.number().optional() }).partial().optional(),
      }),
    )
    .default([]),
  format: z.object({ format_name: z.string().optional(), duration: numeric }).partial().optional(),
});

export interface AudioStreamInfo {
  index: number;
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
}

export interface MediaInfo {
  formatName: string | null;
  /** Null when neither the container nor the stream states a duration. */
  durationMs: number | null;
  hasVideo: boolean;
  audio: AudioStreamInfo | null;
}

const unreadable = (internal: string) =>
  new PermanentError(
    MEDIA_ERRORS.unreadable,
    'The file could not be read as audio or video. It may be damaged, incomplete or in an unsupported format.',
    { details: { internal } },
  );

/** Parses ffprobe's JSON. Picks the default audio stream, else the first one. */
export function parseProbe(json: string): MediaInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw unreadable('ffprobe printed invalid JSON');
  }
  const parsed = ffprobeOutput.safeParse(raw);
  if (!parsed.success) throw unreadable('unexpected ffprobe output');
  const { streams, format } = parsed.data;
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const chosen = audioStreams.find((s) => s.disposition?.default === 1) ?? audioStreams[0];
  const seconds = format?.duration ?? chosen?.duration ?? null;
  return {
    formatName: format?.format_name ?? null,
    durationMs: seconds !== null && seconds >= 0 ? Math.round(seconds * 1000) : null,
    hasVideo: streams.some((s) => s.codec_type === 'video'),
    audio: chosen
      ? {
          index: chosen.index,
          codec: chosen.codec_name ?? null,
          sampleRate: chosen.sample_rate !== null ? Math.round(chosen.sample_rate) : null,
          channels: chosen.channels ?? null,
        }
      : null,
  };
}

/**
 * The checks every recording must pass before it is normalized. `durationMs` may be unknown here
 * (some WebM files don't state it); then the limits are enforced on the decoded audio instead.
 */
export function assertProcessable(
  info: MediaInfo,
  limits: { maxDurationSeconds: number },
): asserts info is MediaInfo & { audio: AudioStreamInfo } {
  if (!info.audio) {
    throw new PermanentError(
      MEDIA_ERRORS.noAudio,
      info.hasVideo
        ? 'The video has no audio track, so there is nothing to transcribe.'
        : 'The file has no audio track.',
      { details: { internal: `format ${info.formatName ?? 'unknown'}, no audio stream` } },
    );
  }
  if (info.durationMs !== null) assertDuration(info.durationMs, limits);
}

export function assertDuration(durationMs: number, limits: { maxDurationSeconds: number }): void {
  if (durationMs < MIN_DURATION_MS) {
    throw new PermanentError(MEDIA_ERRORS.tooShort, 'The recording is shorter than one second.', {
      details: { internal: `duration ${durationMs}ms` },
    });
  }
  if (durationMs > limits.maxDurationSeconds * 1000) {
    throw new PermanentError(
      MEDIA_ERRORS.tooLong,
      `The recording is longer than the ${formatDuration(limits.maxDurationSeconds)} limit.`,
      { details: { internal: `duration ${durationMs}ms` } },
    );
  }
}

/** ffprobe/ffmpeg exited non-zero on the input: the file is not something we can read. */
export const unreadableMedia = unreadable;

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h}-hour`;
  return `${m}-minute`;
}
