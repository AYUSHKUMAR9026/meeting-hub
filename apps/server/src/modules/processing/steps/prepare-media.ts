import { join } from 'node:path';

import { PermanentError } from '../../../lib/errors';
import {
  MEDIA_ERRORS,
  type MediaToolkit,
  NORMALIZED_AUDIO,
  normalizedAudioKey,
  type ObjectStorage,
  peaksKey,
  withJobDir,
} from '../../media';
import type { RunRef, StepContext, StepDefinition, StepOutcome } from '../pipeline';
import type { ProcessingRepository } from '../repository';

export interface PrepareMediaOptions {
  repo: ProcessingRepository;
  storage: ObjectStorage;
  toolkit: MediaToolkit;
  tmpDir: string;
  /** Inputs larger than this are refused (MAX_UPLOAD_BYTES). */
  maxInputBytes: number;
  queue: string;
  timeoutMs?: number;
}

/** Sub-phase shares of the step's own progress bar. */
const PHASES = { download: 0.25, transcode: 0.6, upload: 0.15 } as const;

/** `Weekly sync.mov` → `Weekly sync.m4a`: display only, never part of a storage key. */
export const normalizedFileName = (original: string) =>
  `${original.replace(/\.[^./\\]{1,8}$/, '') || 'recording'}.${NORMALIZED_AUDIO.extension}`;

/**
 * Step `prepare_media` (ADR 0004): download the original (SHA-256 on the way), probe it, decode it
 * once into normalized AAC/M4A plus waveform peaks, upload both, and commit the recording rows and
 * the meeting's duration together with the step's success.
 */
export function prepareMediaStep(options: PrepareMediaOptions): StepDefinition {
  const { repo, storage, toolkit } = options;
  const timeoutMs = options.timeoutMs ?? 60 * 60_000;

  return {
    name: 'prepare_media',
    queue: options.queue,
    runStatus: 'preparing_media',
    maxAttempts: 3,
    backoffMs: 10_000,
    timeoutMs,
    weight: 1,

    async isAlreadyDone(run: RunRef) {
      const normalized = await repo.findRecording(run.workspaceId, run.meetingId, 'normalized');
      return normalized?.storageKey === normalizedAudioKey(run.workspaceId, run.meetingId, run.id);
    },

    async execute(ctx: StepContext): Promise<StepOutcome> {
      const { run, signal, logger } = ctx;
      const original = await repo.findRecordingById(run.workspaceId, run.recordingId);
      if (original?.status !== 'uploaded') {
        throw new PermanentError('RECORDING_MISSING', 'The recording to process is missing.', {
          details: { internal: `recording ${run.recordingId} is ${original?.status ?? 'gone'}` },
        });
      }
      const audioKey = normalizedAudioKey(run.workspaceId, run.meetingId, run.id);
      const peaksObjectKey = peaksKey(run.workspaceId, run.meetingId, run.id);
      const removeOutputs = () => storage.deleteObjects([audioKey, peaksObjectKey]);

      try {
        return await withJobDir(options.tmpDir, async (dir) => {
          const inputPath = join(dir, 'input');
          const outputPath = join(dir, `normalized.${NORMALIZED_AUDIO.extension}`);

          // 1. Download, hashing as it streams.
          ctx.progress(0, 'downloading');
          const downloaded = await storage.downloadToFile(original.storageKey, inputPath, {
            maxBytes: options.maxInputBytes,
            signal,
            onBytes: (n) =>
              ctx.progress((n / Math.max(1, original.sizeBytes)) * PHASES.download, 'downloading'),
          });
          if (downloaded.sizeBytes === 0) {
            throw new PermanentError(MEDIA_ERRORS.unreadable, 'The uploaded file is empty.', {
              details: { internal: 'zero-byte object' },
            });
          }
          await ctx.checkpoint();

          // 2. Probe: is it media, with audio, of an acceptable length?
          const info = await toolkit.inspect(inputPath, signal);
          logger.info(
            { format: info.formatName, durationMs: info.durationMs, codec: info.audio.codec },
            'probed original',
          );
          await ctx.checkpoint();

          // 3. One decode: normalized audio + peaks.
          ctx.progress(PHASES.download, 'transcoding');
          const expectedSeconds = (info.durationMs ?? 0) / 1000;
          const normalized = await toolkit.normalize(
            { inputPath, outputPath, streamIndex: info.audio.index },
            {
              timeoutMs,
              signal,
              onProgress: (seconds) =>
                expectedSeconds > 0 &&
                ctx.progress(
                  PHASES.download + Math.min(1, seconds / expectedSeconds) * PHASES.transcode,
                  'transcoding',
                ),
            },
          );
          await ctx.checkpoint();

          // 4. Upload both (deterministic keys: a retry overwrites, never duplicates).
          ctx.progress(PHASES.download + PHASES.transcode, 'uploading');
          const audio = await storage.uploadFile(audioKey, outputPath, {
            contentType: NORMALIZED_AUDIO.contentType,
            signal,
          });
          await storage.uploadBuffer(
            peaksObjectKey,
            Buffer.from(JSON.stringify(normalized.peaks)),
            {
              contentType: 'application/json',
              signal,
            },
          );
          ctx.progress(1, 'uploading');

          const durationMs = info.durationMs ?? normalized.durationMs;
          return {
            metadata: {
              format: info.formatName,
              inputCodec: info.audio.codec,
              durationMs,
              normalizedBytes: audio.sizeBytes,
              peakPoints: normalized.peaks.length,
            },
            // 5. All rows commit with the step's success.
            async commit(tx) {
              await tx.recordOriginalMedia(run, {
                sha256: downloaded.sha256,
                durationMs,
                codec: info.audio.codec,
                sampleRate: info.audio.sampleRate,
                channels: info.audio.channels,
              });
              const superseded = await tx.replaceNormalized(run, {
                storageKey: audioKey,
                peaksStorageKey: peaksObjectKey,
                originalFilename: normalizedFileName(original.originalFilename),
                contentType: NORMALIZED_AUDIO.contentType,
                sizeBytes: audio.sizeBytes,
                sha256: audio.sha256,
                durationMs: normalized.output.durationMs ?? normalized.durationMs,
                codec: normalized.output.codec,
                sampleRate: normalized.output.sampleRate,
                channels: normalized.output.channels,
              });
              await tx.supersede(run, superseded);
              await tx.setMeetingDuration(run, durationMs);
            },
            discard: removeOutputs,
          };
        });
      } catch (err) {
        // Whatever this attempt uploaded is useless now; a retry would overwrite it anyway.
        await removeOutputs().catch((cleanupErr: unknown) =>
          logger.warn({ err: cleanupErr }, 'could not remove partial outputs'),
        );
        throw err;
      }
    },
  };
}
