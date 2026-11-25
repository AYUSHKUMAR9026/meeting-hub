import { describe, it, expect } from 'vitest';
import {
  ProviderRetryError,
  providerError,
  retryAfter,
  RedisQuotaLimiter,
} from '../src/lib/ai-quota';
import { PermanentError } from '../src/lib/errors';
import {
  speechRanges,
  originalTime,
  planSpeechChunks,
  windowRms,
  speechChunkArgs,
  speechPcmArgs,
} from '../src/modules/media';
import {
  mergeTrackSegments,
  deduplicateOverlap,
  estimateSpeechSeconds,
  shouldUseMixed,
} from '../src/modules/transcription/timeline';
import { glossaryHint } from '../src/modules/transcription/groq';
import {
  extractionSchema,
  guardCitations,
  repairExtraction,
} from '../src/modules/analysis/extraction';
import {
  GeminiLlmProvider,
  GroqLlmProvider,
  FallbackLlmProvider,
  type LlmProvider,
} from '../src/modules/analysis';

describe('speech timeline', () => {
  it('retains padding and maps removed silence exactly', () => {
    const ranges = speechRanges(
      [
        { startMs: 1000, rms: 0.2 },
        { startMs: 1020, rms: 0.2 },
        { startMs: 4000, rms: 0.3 },
      ],
      5000,
    );
    expect(ranges).toEqual([
      { startMs: 850, endMs: 1190, trimmedStartMs: 0 },
      { startMs: 3850, endMs: 4170, trimmedStartMs: 340 },
    ]);
    expect(originalTime(ranges, 340)).toBe(3850);
    expect(originalTime(ranges, 340, true)).toBe(1190);
    expect(originalTime(ranges, 500)).toBe(4010);
    expect(speechRanges([{ startMs: 0, rms: 0 }], 1000)).toEqual([]);
  });
  it('bounds chunks and filter size and carries overlap offsets', () => {
    const chunks = planSpeechChunks([{ startMs: 10000, endMs: 710000, trimmedStartMs: 0 }]);
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 300000],
      [299000, 599000],
      [598000, 700000],
    ]);
    expect(chunks[1]!.ranges).toEqual([{ startMs: 309000, endMs: 609000 }]);
    expect(() => planSpeechChunks([], 100, 100)).toThrow();
    expect(
      planSpeechChunks(
        Array.from({ length: 300 }, (_, i) => ({
          startMs: i * 100,
          endMs: i * 100 + 20,
          trimmedStartMs: i * 20,
        })),
      ).every((c) => c.ranges.length <= 100),
    ).toBe(true);
  });
  it('drops repeated overlap words but preserves later repetitions', () => {
    const s = { speaker: 'Speaker', startMs: 1000, endMs: 1400, text: 'hello', confidence: null };
    expect(
      deduplicateOverlap([
        s,
        { ...s, startMs: 1100, endMs: 1450 },
        { ...s, startMs: 3000, endMs: 3400 },
      ]),
    ).toHaveLength(2);
  });
  it('uses the louder track for bleed and keeps distinct overlapping speech', () => {
    const base = { startMs: 1000, endMs: 2000, text: 'We approved the launch', confidence: null };
    const merged = mergeTrackSegments([
      { ...base, speaker: 'Ada', trackId: 'a', rms: 0.3 },
      { ...base, text: 'we approved the launch!', speaker: 'Bob', trackId: 'b', rms: 0.05 },
      { ...base, text: 'I will send the notes', speaker: 'Bob', trackId: 'b', rms: 0.05 },
      { ...base, startMs: 4000, endMs: 5000, speaker: 'Bob', trackId: 'b', rms: 0.05 },
    ]);
    expect(merged.map((s) => s.speaker)).toEqual(['Ada', 'Bob', 'Bob']);
    expect(
      windowRms(
        [
          { startMs: 1000, rms: 0.4 },
          { startMs: 1020, rms: 0.2 },
        ],
        1000,
        1040,
      ),
    ).toBeCloseTo(Math.sqrt(0.1));
  });
  it('includes chunk billing overhead in the mixed fallback decision', () => {
    expect(estimateSpeechSeconds([4000, 4000], 2)).toBe(28);
    expect(shouldUseMixed(28, 14, 100)).toBe(true);
    expect(shouldUseMixed(10, 14, 100)).toBe(false);
    expect(shouldUseMixed(10, 14, 100, false)).toBe(true);
  });
  it('keeps ffmpeg commands local and bounded and caps glossary bytes', () => {
    for (const args of [
      speechPcmArgs({
        inputPath: 'input.ogg',
        outputPath: 'audio.pcm',
        threads: 2,
        maxSeconds: 60,
      }),
      speechChunkArgs({
        inputPath: 'audio.pcm',
        outputPath: 'chunk.m4a',
        threads: 2,
        ranges: [
          { startMs: 1000, endMs: 1500 },
          { startMs: 3000, endMs: 4000 },
        ],
      }),
    ]) {
      for (const flag of ['-nostdin', '-t', '-threads', '-format_whitelist', '-map_metadata'])
        expect(args).toContain(flag);
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe');
      expect(args.some((v) => /^https?:/.test(v))).toBe(false);
    }
    expect(
      Buffer.byteLength(glossaryHint(Array.from({ length: 100 }, () => 'long glossary term'))),
    ).toBeLessThanOrEqual(224);
  });
});
describe('provider failures', () => {
  it.each([401, 403, 400, 413])('treats %s as permanent', async (status) => {
    await expect(providerError(new Response('private body', { status }))).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
  it.each([429, 500, 503])('honors Retry-After for %s', async (status) => {
    await expect(
      providerError(new Response('{}', { status, headers: { 'retry-after': '123' } })),
    ).rejects.toMatchObject({ retryAfterMs: 123000, quota: status === 429 });
  });
  it('schedules long quota waits and parses HTTP dates', async () => {
    await expect(
      providerError(
        Response.json({ error: { message: 'Audio seconds per day exceeded' } }, { status: 429 }),
      ),
    ).rejects.toMatchObject({ retryAfterMs: 86400000, quota: true });
    await expect(
      providerError(
        Response.json({ error: { message: 'Audio seconds per hour exceeded' } }, { status: 429 }),
      ),
    ).rejects.toMatchObject({ retryAfterMs: 3600000, quota: true });
    expect(retryAfter('Wed, 01 Jan 2031 00:00:10 GMT', Date.parse('2031-01-01T00:00:00Z'))).toBe(
      10000,
    );
    expect(retryAfter('invalid')).toBeNull();
  });
  it('fails closed on Redis failure', async () => {
    const limiter = new RedisQuotaLimiter(
      { eval: () => Promise.reject(new Error('private')) },
      'test',
      'secret',
    );
    await expect(
      limiter.reserve([{ name: 'rpm', capacity: 1, windowMs: 60000, cost: 1 }]),
    ).rejects.toMatchObject({ code: 'FREE_QUOTA_WAIT' });
  });
});
describe('free extraction', () => {
  const valid = {
    summary: { paragraph: 'A plan.', bullets: [] },
    decisions: [{ title: 'Launch', description: 'Proceed', rationale: null, segment_idx: [0] }],
    action_items: [],
  };
  it('salvages valid items without inventing citations', () => {
    const repaired = repairExtraction({
      ...valid,
      decisions: [
        ...valid.decisions,
        { title: 123 },
        { ...valid.decisions[0], segment_idx: [] },
        { ...valid.decisions[0], segment_idx: [999] },
      ],
    });
    expect(extractionSchema.safeParse(repaired).success).toBe(true);
    expect(guardCitations(repaired!, new Set([0])).decisions).toHaveLength(1);
    expect(repairExtraction(null)).toBeNull();
  });
  it('falls back only on quota exhaustion', async () => {
    let calls = 0;
    const fallback: LlmProvider = {
      model: 'fallback',
      generateStructured: () => {
        calls++;
        return Promise.resolve({ result: valid, inputTokens: 1, outputTokens: 1 });
      },
    };
    const primary: LlmProvider = {
      model: 'primary',
      generateStructured: () => Promise.reject(new ProviderRetryError(60000)),
    };
    const combined = new FallbackLlmProvider(primary, fallback);
    const options = {
      signal: new AbortController().signal,
      task: 'extract' as const,
      segmentIndexes: [0],
    };
    await combined.generateStructured('prompt', {}, options);
    expect(calls).toBe(1);
    primary.generateStructured = () => Promise.reject(new PermanentError('AUTH', 'Rejected'));
    await expect(combined.generateStructured('prompt', {}, options)).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(calls).toBe(1);
  });
  it.each(['gemini', 'groq'])('parses %s structured output', async (kind) => {
    const config = {
      key: 'secret',
      model: kind === 'gemini' ? 'gemini-3.5-flash-lite' : 'openai/gpt-oss-20b',
      limiter: { reserve: async () => {}, available: () => Promise.resolve(true) },
      rpm: 30,
      rpd: 1000,
      tpm: 32000,
      context: 131072,
    };
    const response =
      kind === 'gemini'
        ? {
            candidates: [
              { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(valid) }] } },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
          }
        : {
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          };
    const request = () => Promise.resolve(Response.json(response));
    const provider =
      kind === 'gemini'
        ? new GeminiLlmProvider(config, request)
        : new GroqLlmProvider(config, request);
    expect(
      (
        await provider.generateStructured(
          'prompt',
          {},
          { signal: new AbortController().signal, task: 'extract', segmentIndexes: [0] },
        )
      ).result,
    ).toEqual(valid);
  });
});
