import { z } from 'zod';

import { PermanentError, RetryableError } from '../../lib/errors';
import { providerError } from '../../lib/ai-quota';
import { systemPrompt } from './extraction';

export interface LlmOptions {
  signal: AbortSignal;
  task: 'extract' | 'summarize';
  segmentIndexes: readonly number[];
  beforeRequest?: () => Promise<void>;
}
export interface LlmResult {
  result: unknown;
  inputTokens: number;
  outputTokens: number;
}
export interface LlmProvider {
  readonly model: string;
  readonly external?: boolean;
  readonly contextBudget?: number;
  generateStructured(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    options: LlmOptions,
  ): Promise<LlmResult>;
}

export function anthropicError(status: number) {
  if (status === 408 || status === 429 || status >= 500)
    return new RetryableError(
      'ANALYSIS_PROVIDER_UNAVAILABLE',
      'The analysis provider is temporarily unavailable.',
    );
  if (status === 401 || status === 403)
    return new PermanentError(
      'ANALYSIS_PROVIDER_AUTH',
      'The analysis provider rejected its credentials.',
    );
  return new PermanentError(
    'ANALYSIS_PROVIDER_REJECTED',
    'The analysis provider rejected this request.',
  );
}

const envelope = z.object({
  stop_reason: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() }),
});

export class AnthropicProvider implements LlmProvider {
  readonly external = true;
  constructor(
    readonly model: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async generateStructured(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    options: LlmOptions,
  ): Promise<LlmResult> {
    // The JSON Schema dialect marker is unnecessary for the provider.
    const { $schema: dialect, ...schema } = jsonSchema;
    void dialect;
    let response: Response;
    await options.beforeRequest?.();
    try {
      response = await this.request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        redirect: 'error',
        signal: options.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.key,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
          output_config: { format: { type: 'json_schema', schema } },
        }),
      });
    } catch {
      options.signal.throwIfAborted();
      throw anthropicError(503);
    }
    if (!response.ok) {
      if (
        response.status === 429 ||
        (response.status >= 500 && response.headers.has('retry-after'))
      )
        await providerError(response);
      await response.body?.cancel().catch(() => {});
      throw anthropicError(response.status);
    }
    const parsed = envelope.safeParse(await response.json().catch(() => null));
    options.signal.throwIfAborted();
    if (!parsed.success) throw anthropicError(502);
    if (parsed.data.stop_reason === 'refusal')
      throw new PermanentError(
        'ANALYSIS_CONTENT_REJECTED',
        'The analysis provider declined to process this content.',
      );
    const text = parsed.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    let result: unknown;
    try {
      result = parsed.data.stop_reason === 'end_turn' ? JSON.parse(text) : null;
    } catch {
      result = null;
    }
    return {
      result,
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
    };
  }
}

export class FakeLlmProvider implements LlmProvider {
  readonly external = false;
  readonly model = 'fake-meeting-extraction/1';

  generateStructured(
    prompt: string,
    _jsonSchema: Record<string, unknown>,
    options: LlmOptions,
  ): Promise<LlmResult> {
    if (options.signal.aborted) {
      const reason =
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('Analysis cancelled.');
      return Promise.reject(reason);
    }
    const summary = {
      paragraph: 'The meeting covered the agenda and next steps.',
      bullets: ['Review the agenda.'],
    };
    const first = options.segmentIndexes[0];
    const last = options.segmentIndexes.at(-1);
    const result =
      options.task === 'summarize'
        ? summary
        : {
            summary,
            decisions:
              first === undefined
                ? []
                : [
                    {
                      title: 'Review the agenda',
                      description: 'The group agreed to review the agenda.',
                      rationale: null,
                      segment_idx: [first],
                    },
                  ],
            action_items:
              last === undefined
                ? []
                : [
                    {
                      title: 'Share next steps',
                      description: 'Share the next steps with the group.',
                      owner_speaker: null,
                      due_date: null,
                      segment_idx: [last],
                    },
                  ],
          };
    return Promise.resolve({
      result,
      inputTokens: Math.ceil(Buffer.byteLength(prompt) / 4),
      outputTokens: 65,
    });
  }
}
