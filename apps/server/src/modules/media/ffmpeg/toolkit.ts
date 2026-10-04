import { PermanentError } from '../../../lib/errors';
import { PeaksAccumulator, type PeaksJson } from '../peaks';
import { ffprobeArgs, normalizeArgs, NORMALIZED_AUDIO, PEAKS_PCM } from './args';
import { ProcessSpawnError, runProcess } from './process';
import {
  assertDuration,
  assertProcessable,
  type AudioStreamInfo,
  MEDIA_ERRORS,
  type MediaInfo,
  parseProbe,
  unreadableMedia,
} from './probe';

export interface MediaToolkitOptions {
  ffmpegPath: string;
  ffprobePath: string;
  threads: number;
  maxDurationSeconds: number;
  /** ffprobe should answer in seconds; a hang means something is wrong with the file. */
  probeTimeoutMs?: number;
}

export interface NormalizeResult {
  /** Duration of the decoded audio. */
  durationMs: number;
  peaks: PeaksJson;
  /** What the normalized file contains, as probed. */
  output: AudioStreamInfo & { durationMs: number | null };
}

/** Thrown when ffmpeg/ffprobe can't be started at all: a deployment problem, worth retrying. */
export class MediaToolMissingError extends Error {
  constructor(cause: ProcessSpawnError) {
    super(`${cause.message}; set FFMPEG_PATH/FFPROBE_PATH or install ffmpeg`, { cause });
    this.name = 'MediaToolMissingError';
  }
}

/**
 * ffprobe/ffmpeg operations on local files. All command lines come from ./args (safety flags);
 * every call is bounded by a timeout and an AbortSignal that SIGKILL the process.
 */
export class MediaToolkit {
  constructor(private readonly options: MediaToolkitOptions) {}

  async probe(path: string, signal?: AbortSignal): Promise<MediaInfo> {
    let stdout = '';
    const result = await this.run(this.options.ffprobePath, ffprobeArgs(path), {
      timeoutMs: this.options.probeTimeoutMs ?? 60_000,
      ...(signal ? { signal } : {}),
      onStdout: (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 1_000_000) throw new Error('ffprobe output too large');
      },
    });
    if (result.exitCode !== 0)
      throw unreadableMedia(`ffprobe exited ${result.exitCode}: ${result.stderr}`);
    return parseProbe(stdout);
  }

  /** Probes and applies the processability rules (audio present, duration within limits). */
  async inspect(path: string, signal?: AbortSignal) {
    const info = await this.probe(path, signal);
    assertProcessable(info, this.options);
    return info;
  }

  /**
   * Decodes `streamIndex` once into the normalized M4A at `outputPath` and computes waveform peaks
   * from PCM on stdout. `onProgress` gets decoded seconds as they arrive.
   */
  async normalize(
    input: { inputPath: string; outputPath: string; streamIndex: number },
    options: { timeoutMs: number; signal?: AbortSignal; onProgress?: (seconds: number) => void },
  ): Promise<NormalizeResult> {
    const peaks = new PeaksAccumulator(PEAKS_PCM.sampleRate);
    const result = await this.run(
      this.options.ffmpegPath,
      normalizeArgs({
        ...input,
        threads: this.options.threads,
        // One second over the limit, so "too long" is detectable when probing missed it.
        maxSeconds: this.options.maxDurationSeconds + 1,
      }),
      {
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        onStdout: (chunk) => {
          peaks.push(chunk);
          options.onProgress?.(peaks.sampleCount / PEAKS_PCM.sampleRate);
        },
      },
    );
    if (result.exitCode !== 0) {
      throw unreadableMedia(`ffmpeg exited ${result.exitCode}: ${result.stderr}`);
    }
    const durationMs = Math.round((peaks.sampleCount / PEAKS_PCM.sampleRate) * 1000);
    if (peaks.sampleCount === 0) {
      throw new PermanentError(MEDIA_ERRORS.unreadable, 'The file contains no decodable audio.', {
        details: { internal: 'ffmpeg produced no samples' },
      });
    }
    // Enforced on what was decoded too: probing can miss or misstate the duration.
    assertDuration(durationMs, this.options);

    const output = await this.probe(input.outputPath, options.signal);
    if (
      output.audio?.codec !== NORMALIZED_AUDIO.codec ||
      output.audio.sampleRate !== NORMALIZED_AUDIO.sampleRate ||
      output.audio.channels !== NORMALIZED_AUDIO.channels
    ) {
      // Our own output not matching our own settings is a bug or a broken ffmpeg build, not bad input.
      throw new Error(`normalized output is ${JSON.stringify(output.audio)}`);
    }
    return {
      durationMs,
      peaks: peaks.finish(),
      output: { ...output.audio, durationMs: output.durationMs },
    };
  }

  private async run(...args: Parameters<typeof runProcess>) {
    try {
      return await runProcess(...args);
    } catch (err) {
      if (err instanceof ProcessSpawnError) throw new MediaToolMissingError(err);
      throw err;
    }
  }
}
