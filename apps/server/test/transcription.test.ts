import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { PermanentError, RetryableError } from '../src/lib/errors';
import {
  AssemblyAIProvider,
  mergeSegments,
  normalizeAssemblyResult,
  providerHttpError,
  RetryableProviderJobError,
} from '../src/modules/transcription';

describe('AssemblyAI transcription', () => {
  it('streams the recording to upload and uses provider audio URL, speaker labels and glossary', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ upload_url: 'https://cdn.example.test/recording' }))
      .mockResolvedValueOnce(Response.json({ id: 'job-1' }));
    const provider = new AssemblyAIProvider('test-key', request);
    const job = await provider.submit(Readable.from([Buffer.from('audio')]), {
      durationMs: 1000,
      language: 'en',
      glossary: ['Meeting Hub'],
      signal: new AbortController().signal,
    });
    expect(job).toBe('job-1');
    expect(request.mock.calls[0]?.[0]).toBe('https://api.assemblyai.com/v2/upload');
    const upload = request.mock.calls[0]?.[1];
    expect(await new Response(upload?.body).text()).toBe('audio');
    const submission = request.mock.calls[1]?.[1]?.body;
    if (typeof submission !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(submission)).toMatchObject({
      audio_url: 'https://cdn.example.test/recording',
      language_code: 'en',
      speech_models: ['universal-2'],
      speaker_labels: false,
      keyterms_prompt: ['Meeting Hub'],
    });
  });

  it('normalizes utterances and preserves speaker boundaries', () => {
    expect(
      normalizeAssemblyResult({
        status: 'completed',
        language_code: 'en',
        utterances: [
          { speaker: 'B', start: 1200, end: 1500, text: 'Second speaker', confidence: 0.9 },
          { speaker: 'A', start: 0, end: 1000, text: ' First speaker ', confidence: 0.8 },
          { speaker: 'B', start: 1600, end: 1800, text: '  ' },
        ],
      }),
    ).toEqual({
      status: 'completed',
      language: 'en',
      segments: [
        { speaker: 'Speaker A', startMs: 0, endMs: 1000, text: 'First speaker', confidence: 0.8 },
        {
          speaker: 'Speaker B',
          startMs: 1200,
          endMs: 1500,
          text: 'Second speaker',
          confidence: 0.9,
        },
      ],
    });
    expect(normalizeAssemblyResult({ status: 'processing' })).toEqual({ status: 'pending' });
  });

  it.each([408, 429, 500, 503])('retries HTTP %s', (code) => {
    expect(providerHttpError(code)).toBeInstanceOf(RetryableError);
  });

  it.each([400, 401, 403, 422])('does not retry HTTP %s', (code) => {
    expect(providerHttpError(code)).toBeInstanceOf(PermanentError);
  });

  it('maps job errors without exposing provider content', () => {
    expect(() =>
      normalizeAssemblyResult({ status: 'error', error: 'unsupported language: private data' }),
    ).toThrow('The provider could not transcribe the selected or detected language.');
    expect(() =>
      normalizeAssemblyResult({ status: 'error', error: 'temporarily unavailable' }),
    ).toThrow(RetryableProviderJobError);
    expect(() => normalizeAssemblyResult({ status: 'error', error: 'bad audio' })).toThrow(
      PermanentError,
    );
  });

  it('only merges short neighboring utterances from the same speaker', () => {
    const input = [
      { speaker: 'A', startMs: 0, endMs: 1000, text: 'Hello', confidence: 0.5 },
      { speaker: 'A', startMs: 1200, endMs: 2200, text: 'there.', confidence: 1 },
      { speaker: 'B', startMs: 2400, endMs: 2800, text: 'Hi.', confidence: null },
      { speaker: 'B', startMs: 4000, endMs: 4500, text: 'Next topic.', confidence: null },
    ];
    expect(mergeSegments(input)).toEqual([
      { speaker: 'A', startMs: 0, endMs: 2200, text: 'Hello there.', confidence: 0.75 },
      ...input.slice(2),
    ]);
    expect(input[0]!.text).toBe('Hello');
  });
});
