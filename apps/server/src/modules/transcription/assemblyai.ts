import { addAbortSignal, Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { ProviderRetryError } from '../../lib/ai-quota';
import { deduplicateOverlap } from './timeline';
import {
  planSpeechChunks,
  renderSpeechChunk,
  originalTime,
  type SpeechAudio,
  type SpeechTools,
} from '../media';

import { z } from 'zod';

import { PermanentError, RetryableError } from '../../lib/errors';
import {
  mergeSegments,
  type TranscriptionOptions,
  type TranscriptionProvider,
  type TranscriptionResult,
  type DirectTranscriptionOptions,
  type CompletedTranscript,
} from './provider';

const transcriptResponse = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['queued', 'processing']) }),
  z.object({ status: z.literal('error'), error: z.string().optional() }),
  z.object({
    status: z.literal('completed'),
    language_code: z.string().nullish(),
    words: z
      .array(
        z.object({
          start: z.int().nonnegative(),
          end: z.int().positive(),
          text: z.string(),
          confidence: z.number().min(0).max(1).nullish(),
        }),
      )
      .nullish(),
    utterances: z
      .array(
        z.object({
          speaker: z.string().min(1).max(32),
          start: z.int().nonnegative(),
          end: z.int().positive(),
          text: z.string(),
          confidence: z.number().min(0).max(1).nullish(),
        }),
      )
      .nullish(),
  }),
]);

/** A terminal provider job failed transiently and must be submitted again. */
export class RetryableProviderJobError extends RetryableError {
  constructor() {
    super(
      'TRANSCRIPTION_PROVIDER_UNAVAILABLE',
      'The transcription provider could not finish the job.',
    );
  }
}

export function providerHttpError(status: number) {
  if (status === 429 || status === 408 || status >= 500)
    return new RetryableError(
      'TRANSCRIPTION_PROVIDER_UNAVAILABLE',
      'The transcription provider is temporarily unavailable.',
    );
  if (status === 401 || status === 403)
    return new PermanentError(
      'TRANSCRIPTION_PROVIDER_AUTH',
      'The transcription provider rejected its credentials.',
    );
  return new PermanentError(
    'TRANSCRIPTION_PROVIDER_REJECTED',
    'The provider rejected the recording or transcription settings.',
  );
}

export function normalizeAssemblyResult(body: unknown): TranscriptionResult {
  const response = transcriptResponse.safeParse(body);
  if (!response.success)
    throw new RetryableError(
      'TRANSCRIPTION_INVALID_RESPONSE',
      'The provider returned an invalid transcription response.',
    );
  const result = response.data;
  if (result.status === 'queued' || result.status === 'processing') return { status: 'pending' };
  if (result.status !== 'completed') {
    // Inspect provider errors for classification only. Provider strings can contain private data.
    if (
      'error' in result &&
      /temporar|unavailable|internal server|rate limit|try again/i.test(result.error ?? '')
    )
      throw new RetryableProviderJobError();
    if (
      'error' in result &&
      /authenticat|invalid api key|unauthori[sz]ed/i.test(result.error ?? '')
    )
      throw providerHttpError(401);
    if ('error' in result && /language/i.test(result.error ?? ''))
      throw new PermanentError(
        'TRANSCRIPTION_LANGUAGE_UNSUPPORTED',
        'The provider could not transcribe the selected or detected language.',
      );
    throw new PermanentError(
      'TRANSCRIPTION_AUDIO_REJECTED',
      'The provider could not transcribe this recording.',
    );
  }
  return {
    status: 'completed',
    language: result.language_code ?? null,
    segments: mergeSegments(
      (result.utterances ?? result.words?.map((word) => ({ ...word, speaker: '' })) ?? [])
        .filter((utterance) => utterance.end > utterance.start && utterance.text.trim())
        .map((utterance) => ({
          speaker: utterance.speaker ? `Speaker ${utterance.speaker}` : 'Speaker',
          startMs: utterance.start,
          endMs: utterance.end,
          text: utterance.text.trim(),
          confidence: utterance.confidence ?? null,
        })),
    ),
  };
}

const uploaded = z.object({ upload_url: z.url({ protocol: /^https$/ }) });
const submitted = z.object({ id: z.string().min(1).max(255) });

export class AssemblyAIProvider implements TranscriptionProvider {
  readonly name = 'assemblyai' as const;

  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
    private readonly tools: SpeechTools = {
      ffmpegPath: 'ffmpeg',
      threads: 2,
      maxDurationSeconds: 10800,
    },
  ) {}

  async submit(audio: Readable, options: TranscriptionOptions): Promise<string> {
    addAbortSignal(options.signal, audio);
    await options.beforeRequest?.();
    const file = await this.json('/upload', uploaded, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(audio) as ReadableStream<Uint8Array>,
      duplex: 'half',
      signal: options.signal,
    });
    await options.beforeRequest?.();
    const job = await this.json('/transcript', submitted, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: file.upload_url,
        speech_models: ['universal-2'],
        speaker_labels: false,
        ...(options.language ? { language_code: options.language } : { language_detection: true }),
        ...(options.glossary.length ? { keyterms_prompt: options.glossary.slice(0, 200) } : {}),
      }),
      signal: options.signal,
    });
    return job.id;
  }

  async transcribe(
    audio: SpeechAudio,
    options: DirectTranscriptionOptions,
  ): Promise<CompletedTranscript> {
    const segments: CompletedTranscript['segments'] = [];
    let language = options.language;
    for (const [index, chunk] of planSpeechChunks(audio.ranges).entries()) {
      const key = `assemblyai:universal-2:${index}:${chunk.startMs}:${chunk.endMs}`;
      let completed = await options.cache?.load(key);
      if (!completed) {
        let jobId = await options.cache?.loadReceipt?.(key);
        if (!jobId) {
          const path = join(dirname(audio.path), `assembly-${index}.m4a`);
          await renderSpeechChunk(audio, chunk, path, this.tools, options.signal);
          const stream = createReadStream(path, { signal: options.signal });
          try {
            jobId = await this.submit(stream, {
              ...options,
              durationMs: chunk.endMs - chunk.startMs,
            });
          } finally {
            stream.destroy();
          }
          await options.cache?.saveReceipt?.(key, jobId);
        }
        await options.beforeRequest();
        let result: TranscriptionResult;
        try {
          result = await this.getResult(jobId, options.signal);
        } catch (error) {
          if (error instanceof RetryableProviderJobError) await options.cache?.clearReceipt?.(key);
          throw error;
        }
        if (result.status === 'pending') throw new ProviderRetryError(5000, true, true);
        completed = {
          ...result,
          segments: result.segments.map((row) => ({
            ...row,
            speaker: 'Speaker',
            startMs: originalTime(audio.ranges, chunk.startMs + row.startMs),
            endMs: originalTime(
              audio.ranges,
              Math.min(chunk.endMs, chunk.startMs + row.endMs),
              true,
            ),
          })),
        };
        await options.cache?.save(key, completed);
      }
      segments.push(...completed.segments);
      language = completed.language ?? language;
    }
    return { status: 'completed', language, segments: mergeSegments(deduplicateOverlap(segments)) };
  }

  async getResult(jobId: string, signal: AbortSignal): Promise<TranscriptionResult> {
    return normalizeAssemblyResult(
      await this.json(`/transcript/${encodeURIComponent(jobId)}`, z.unknown(), { signal }),
    );
  }

  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestInit & { duplex?: 'half' },
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`https://api.assemblyai.com/v2${path}`, {
        ...options,
        redirect: 'error',
        headers: { authorization: this.apiKey, ...options.headers },
      });
    } catch {
      options.signal?.throwIfAborted();
      throw providerHttpError(503);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw providerHttpError(response.status);
    }
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    options.signal?.throwIfAborted();
    if (!parsed.success)
      throw new RetryableError(
        'TRANSCRIPTION_INVALID_RESPONSE',
        'The provider returned an invalid transcription response.',
      );
    return parsed.data;
  }
}
