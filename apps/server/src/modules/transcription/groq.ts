import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { QuotaLimiter } from '../../lib/ai-quota';
import { providerError, ProviderRetryError, speechBuckets } from '../../lib/ai-quota';
import { PermanentError } from '../../lib/errors';
import {
  originalTime,
  planSpeechChunks,
  renderSpeechChunk,
  type SpeechAudio,
  type SpeechTools,
} from '../media';
import type {
  CompletedTranscript,
  DirectTranscriptionOptions,
  TranscriptionProvider,
  TranscriptSegment,
} from './provider';
import { deduplicateOverlap } from './timeline';

const word = z.object({
  word: z.string().max(1000),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
const segment = z.object({
  text: z.string().max(10000),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
const resultSchema = z.object({
  language: z.string().optional(),
  words: z.array(word).max(100000).optional(),
  segments: z.array(segment).max(20000).optional(),
});
export function glossaryHint(terms: readonly string[]) {
  let hint = '';
  for (const term of terms) {
    const next = hint ? `${hint}, ${term}` : term;
    if (Buffer.byteLength(next) > 224) break;
    hint = next;
  }
  return hint;
}

export class GroqTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'groq' as const;
  constructor(
    private readonly options: {
      key: string;
      model: string;
      tools: SpeechTools;
      limiter: QuotaLimiter;
      hourSeconds: number;
      daySeconds: number;
      rpm: number;
      rpd: number;
    },
    private readonly request: typeof fetch = fetch,
  ) {}
  submit(): Promise<string> {
    return Promise.reject(
      new PermanentError('TRANSCRIPTION_DIRECT_ONLY', 'This provider requires prepared audio.'),
    );
  }
  getResult(): Promise<CompletedTranscript> {
    return Promise.reject(
      new PermanentError(
        'TRANSCRIPTION_DIRECT_ONLY',
        'This provider does not use remote job polling.',
      ),
    );
  }

  async transcribe(
    audio: SpeechAudio,
    options: DirectTranscriptionOptions,
  ): Promise<CompletedTranscript> {
    const combined: TranscriptSegment[] = [];
    let language = options.language;
    for (const [index, chunk] of planSpeechChunks(
      audio.ranges,
      Math.min(300000, this.options.hourSeconds * 1000, this.options.daySeconds * 1000),
    ).entries()) {
      options.signal.throwIfAborted();
      const cacheKey = `${this.options.model}:${index}:${chunk.startMs}:${chunk.endMs}`;
      let completed = await options.cache?.load(cacheKey);
      if (!completed) {
        const path = join(dirname(audio.path), `chunk-${index}.m4a`);
        await renderSpeechChunk(audio, chunk, path, this.options.tools, options.signal);
        const bytes = await readFile(path);
        if (bytes.length >= 24000000)
          throw new PermanentError(
            'TRANSCRIPTION_CHUNK_TOO_LARGE',
            'The prepared audio exceeds the free transcription file limit.',
          );
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }), 'speech.m4a');
        form.set('model', this.options.model);
        form.set('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'word');
        form.append('timestamp_granularities[]', 'segment');
        form.set('temperature', '0');
        const hint = glossaryHint(options.glossary);
        if (hint) form.set('prompt', hint);
        if (options.language) form.set('language', options.language.split(/[-_]/)[0]!);
        await this.options.limiter.reserve([
          ...speechBuckets(
            Math.max(10, Math.ceil((chunk.endMs - chunk.startMs) / 1000)),
            this.options.hourSeconds,
            this.options.daySeconds,
          ),
          { name: 'stt-rpm', capacity: this.options.rpm, windowMs: 60000, cost: 1 },
          { name: 'stt-rpd', capacity: this.options.rpd, windowMs: 86400000, cost: 1 },
        ]);
        await options.beforeRequest();
        let response: Response;
        try {
          response = await this.request('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            redirect: 'error',
            signal: options.signal,
            headers: { authorization: `Bearer ${this.options.key}` },
            body: form,
          });
        } catch {
          options.signal.throwIfAborted();
          throw new ProviderRetryError(5000, false);
        }
        if (!response.ok) await providerError(response);
        const parsed = resultSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new ProviderRetryError(5000, false);
        const rows = parsed.data.words?.length
          ? parsed.data.words.map((v) => ({ ...v, text: v.word }))
          : (parsed.data.segments ?? []);
        completed = {
          status: 'completed',
          language: parsed.data.language ?? language,
          segments: rows
            .map((row) => ({
              speaker: 'Speaker',
              startMs: originalTime(audio.ranges, chunk.startMs + Math.round(row.start * 1000)),
              endMs: originalTime(
                audio.ranges,
                Math.min(chunk.endMs, chunk.startMs + Math.round(row.end * 1000)),
                true,
              ),
              text: row.text.trim(),
              confidence: null,
            }))
            .filter((row) => row.text && row.endMs > row.startMs),
        };
        await options.cache?.save(cacheKey, completed);
      }
      combined.push(...completed.segments);
      language = completed.language ?? language;
    }
    return { status: 'completed', language, segments: deduplicateOverlap(combined) };
  }
}
