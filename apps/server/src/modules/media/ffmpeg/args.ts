/**
 * Every ffmpeg / ffprobe command line is built here, so the safety flags can't be forgotten
 * (ADR 0004). Inputs are always local temp files passed as `file:<path>`:
 *
 * - `-protocol_whitelist file,pipe` stops a crafted file (playlist, reference movie) from making
 *   ffmpeg open http/tcp/… URLs (SSRF).
 * - `-format_whitelist` limits demuxing to the containers we accept, so playlist-style demuxers
 *   (hls, concat, …) can't read other local files through `file:` entries either.
 * - `-nostdin`, a thread limit and a duration cap bound what one job can consume.
 */

/** Only these protocols may be opened, for inputs and outputs. */
export const PROTOCOL_WHITELIST = 'file,pipe';

/**
 * Demuxers for the upload allowlist (MP3, M4A/AAC, WAV, OGG/Opus, WebM, MP4, MOV). `mov` covers
 * mp4/m4a/3gp/mj2; `matroska` covers webm.
 */
export const FORMAT_WHITELIST = 'mov,mp4,m4a,matroska,webm,ogg,wav,mp3,aac';

/** Normalized audio (ADR 0004): AAC-LC in M4A, mono, 16 kHz, 40 kbit/s, moov first. */
export const NORMALIZED_AUDIO = {
  codec: 'aac',
  sampleRate: 16_000,
  channels: 1,
  bitrate: '40k',
  contentType: 'audio/mp4',
  extension: 'm4a',
} as const;

/** Raw PCM streamed to stdout for waveform peaks: signed 16-bit little-endian, mono, 16 kHz. */
export const PEAKS_PCM = { sampleRate: 16_000, bytesPerSample: 2 } as const;

const fileUrl = (path: string) => {
  if (!path || path.includes('\0')) throw new Error('invalid media path');
  return `file:${path}`;
};

const inputSafety = () => [
  '-protocol_whitelist',
  PROTOCOL_WHITELIST,
  '-format_whitelist',
  FORMAT_WHITELIST,
];

/** ffprobe printing format and streams as JSON. */
export function ffprobeArgs(inputPath: string): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    ...inputSafety(),
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    fileUrl(inputPath),
  ];
}

export interface NormalizeArgsInput {
  inputPath: string;
  outputPath: string;
  /** Index of the audio stream to use (from ffprobe). */
  streamIndex: number;
  threads: number;
  /** Output is cut at this many seconds (a backstop for files whose duration probing missed). */
  maxSeconds: number;
}

/**
 * One decode, two outputs: the normalized M4A file, and 16 kHz mono PCM on stdout for peaks.
 * Metadata (titles, comments, cover art) is dropped: it may hold personal data and isn't needed.
 */
export function normalizeArgs(input: NormalizeArgsInput): string[] {
  if (!Number.isInteger(input.streamIndex) || input.streamIndex < 0) {
    throw new Error('streamIndex must be a non-negative integer');
  }
  const map = ['-map', `0:${input.streamIndex}`];
  const threads = ['-threads', String(input.threads)];
  const cap = ['-t', String(input.maxSeconds)];
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-filter_threads',
    '1',
    ...threads,
    ...inputSafety(),
    '-i',
    fileUrl(input.inputPath),
    // Output 1: normalized audio file.
    ...map,
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-ac',
    String(NORMALIZED_AUDIO.channels),
    '-ar',
    String(NORMALIZED_AUDIO.sampleRate),
    '-c:a',
    NORMALIZED_AUDIO.codec,
    '-b:a',
    NORMALIZED_AUDIO.bitrate,
    ...threads,
    ...cap,
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    fileUrl(input.outputPath),
    // Output 2: raw PCM for waveform peaks.
    ...map,
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    String(PEAKS_PCM.sampleRate),
    '-c:a',
    'pcm_s16le',
    ...cap,
    '-f',
    's16le',
    'pipe:1',
  ];
}

/** Private PCM scratch file for silence/energy analysis. No input metadata is retained. */
export function speechPcmArgs(input: {
  inputPath: string;
  outputPath: string;
  threads: number;
  maxSeconds: number;
}): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-threads',
    String(input.threads),
    ...inputSafety(),
    '-i',
    fileUrl(input.inputPath),
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-t',
    String(input.maxSeconds),
    '-f',
    's16le',
    '-y',
    fileUrl(input.outputPath),
  ];
}

/** ffmpeg removes silent spans and joins the retained intervals into a compressed chunk. */
export function speechChunkArgs(input: {
  inputPath: string;
  outputPath: string;
  ranges: readonly { startMs: number; endMs: number }[];
  threads: number;
}): string[] {
  if (
    !input.ranges.length ||
    input.ranges.length > 100 ||
    input.ranges.some((r) => r.startMs < 0 || r.endMs <= r.startMs || !Number.isFinite(r.endMs))
  )
    throw new Error('Invalid speech intervals');
  const base = input.ranges[0]!.startMs;
  const count = input.ranges.length;
  const filter =
    `[0:a]asplit=${count}${input.ranges.map((_, i) => `[a${i}]`).join('')};` +
    input.ranges
      .map(
        (r, i) =>
          `[a${i}]atrim=start_sample=${Math.round((r.startMs - base) * 16)}:end_sample=${Math.round((r.endMs - base) * 16)},asetpts=PTS-STARTPTS[b${i}]`,
      )
      .join(';') +
    `;${input.ranges.map((_, i) => `[b${i}]`).join('')}concat=n=${count}:v=0:a=1[out]`;
  const duration = input.ranges.reduce((sum, r) => sum + r.endMs - r.startMs, 0) / 1000;
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-threads',
    String(input.threads),
    '-filter_complex_threads',
    '1',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    's16le',
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-ss',
    String(base / 1000),
    '-t',
    String((input.ranges.at(-1)!.endMs - base) / 1000),
    '-i',
    fileUrl(input.inputPath),
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-map_metadata',
    '-1',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'aac',
    '-b:a',
    '40k',
    '-threads',
    String(input.threads),
    '-t',
    String(duration),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    fileUrl(input.outputPath),
  ];
}
