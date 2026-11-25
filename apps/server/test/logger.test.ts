import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { redactPaths } from '../src/lib/logger';

function capture(obj: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    { redact: { paths: redactPaths, censor: '[REDACTED]' } },
    { write: (line: string) => lines.push(line) },
  );
  logger.info(obj, 'test');
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('log redaction', () => {
  it('redacts free-provider keys and nested audio URLs', () => {
    const output = capture({
      GROQ_API_KEY: 'free-key',
      GEMINI_API_KEY: 'gemini-key',
      audioUrl: 'https://private/audio',
      request: { audio_url: 'https://private/recording' },
      nested: { apiKey: 'secret', url: 'https://private/signed' },
    });
    expect(JSON.stringify(output)).not.toMatch(/free-key|gemini-key|https:\/\/private|"secret"/);
  });
  it('redacts authorization and cookie headers', () => {
    const out = capture({
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: '*/*' } },
    });
    expect(out.req).toEqual({
      headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', accept: '*/*' },
    });
  });

  it('redacts transcript search, nested segments, provider utterances and credentials', () => {
    const out = capture({
      req: { body: { q: 'private phrase' } },
      result: { segments: [{ text: 'private text' }] },
      provider: { utterances: [{ text: 'provider text' }] },
      ASSEMBLYAI_API_KEY: 'provider key',
    });
    expect(out).toMatchObject({
      req: { body: { q: '[REDACTED]' } },
      result: { segments: '[REDACTED]' },
      provider: { utterances: '[REDACTED]' },
      ASSEMBLYAI_API_KEY: '[REDACTED]',
    });
  });

  it('redacts transcript/text/content at any depth up to 4 levels', () => {
    const out = capture({
      transcript: 'top secret',
      segment: { text: 'hello', meta: { content: 'x', speaker: 'A' } },
    });
    expect(out.transcript).toBe('[REDACTED]');
    expect(out.segment).toEqual({
      text: '[REDACTED]',
      meta: { content: '[REDACTED]', speaker: 'A' },
    });
  });
});
