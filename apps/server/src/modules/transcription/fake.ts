import { randomUUID } from 'node:crypto';
import { addAbortSignal, type Readable } from 'node:stream';

import { z } from 'zod';

import { PermanentError } from '../../lib/errors';
import type { TranscriptionOptions, TranscriptionProvider, TranscriptionResult } from './provider';

const fixtureJob = z.tuple([z.int().min(2), z.string(), z.uuid()]);

/** Local fixture. Its job IDs carry enough data to resume after a worker restart. */
export class FakeProvider implements TranscriptionProvider {
  readonly name = 'fake' as const;

  async submit(audio: Readable, options: TranscriptionOptions): Promise<string> {
    addAbortSignal(options.signal, audio);
    for await (const chunk of audio) {
      // Consume the stream to exercise the real storage path without retaining audio.
      void chunk;
    }
    return JSON.stringify([options.durationMs, options.language ?? 'en', randomUUID()]);
  }

  getResult(jobId: string, signal: AbortSignal): Promise<TranscriptionResult> {
    if (signal.aborted) {
      const reason =
        signal.reason instanceof Error ? signal.reason : new Error('Transcription was cancelled.');
      return Promise.reject(reason);
    }
    let value: unknown;
    try {
      value = JSON.parse(jobId);
    } catch {
      value = null;
    }
    const job = fixtureJob.safeParse(value);
    if (!job.success) {
      return Promise.reject(
        new PermanentError('TRANSCRIPTION_INVALID_JOB', 'The test transcription job is invalid.'),
      );
    }
    const [durationMs, language] = job.data;
    const split = Math.floor(durationMs / 2);
    return Promise.resolve({
      status: 'completed',
      language,
      segments: [
        {
          speaker: 'Speaker A',
          startMs: 0,
          endMs: split,
          text: 'Welcome to the meeting.',
          confidence: 1,
        },
        {
          speaker: 'Speaker B',
          startMs: split,
          endMs: durationMs,
          text: 'Let’s review the agenda.',
          confidence: 1,
        },
      ],
    });
  }
}
