import { z } from 'zod';
import type { QuotaLimiter } from '../../lib/ai-quota';
import { providerError, ProviderRetryError } from '../../lib/ai-quota';
import { PermanentError } from '../../lib/errors';
import { systemPrompt } from './extraction';
import type { LlmOptions, LlmProvider, LlmResult } from './provider';

export interface FreeLlmOptions {
  key: string;
  model: string;
  limiter: QuotaLimiter;
  rpm: number;
  rpd: number;
  tpm: number;
  tpd?: number;
  context: number;
}
const OUTPUT_TOKENS = 2048;
const geminiEnvelope = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z.array(
              z.object({ text: z.string().optional(), thought: z.boolean().optional() }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .optional(),
});
const groqEnvelope = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable(),
      message: z.object({ content: z.string().nullable() }),
    }),
  ),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

abstract class FreeLlmProvider implements LlmProvider {
  readonly external = true;
  readonly model: string;
  readonly contextBudget: number;
  constructor(
    protected readonly config: FreeLlmOptions,
    protected readonly request: typeof fetch = fetch,
  ) {
    this.model = config.model;
    this.contextBudget = Math.min(
      24000,
      config.context - OUTPUT_TOKENS,
      config.tpm - OUTPUT_TOKENS,
    );
  }
  protected async send(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    options: LlmOptions,
  ): Promise<unknown> {
    await options.beforeRequest?.();
    const estimate = Buffer.byteLength(JSON.stringify(body)) + OUTPUT_TOKENS;
    if (estimate > this.config.context || estimate > this.config.tpm)
      throw new PermanentError(
        'ANALYSIS_CONTEXT_LIMIT',
        'Analysis exceeds the configured free model request budget.',
      );
    await this.config.limiter.reserve([
      { name: `${this.model}:rpm`, capacity: this.config.rpm, windowMs: 60000, cost: 1 },
      { name: `${this.model}:rpd`, capacity: this.config.rpd, windowMs: 86400000, cost: 1 },
      { name: `${this.model}:tpm`, capacity: this.config.tpm, windowMs: 60000, cost: estimate },
      ...(this.config.tpd
        ? [
            {
              name: `${this.model}:tpd`,
              capacity: this.config.tpd,
              windowMs: 86400000,
              cost: estimate,
            },
          ]
        : []),
    ]);
    await options.beforeRequest?.();
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        redirect: 'error',
        signal: options.signal,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch {
      options.signal.throwIfAborted();
      throw new ProviderRetryError(5000, false);
    }
    if (!response.ok) await providerError(response);
    return response.json().catch(() => null);
  }
  abstract generateStructured(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    options: LlmOptions,
  ): Promise<LlmResult>;
}

export class GeminiLlmProvider extends FreeLlmProvider {
  async generateStructured(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    options: LlmOptions,
  ): Promise<LlmResult> {
    const { $schema: dialect, ...schema } = jsonSchema;
    void dialect;
    const value = await this.send(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { 'x-goog-api-key': this.config.key },
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          temperature: 0,
          maxOutputTokens: OUTPUT_TOKENS,
        },
      },
      options,
    );
    const result = geminiEnvelope.safeParse(value);
    if (!result.success) throw new ProviderRetryError(5000, false);
    const candidate = result.data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY')
      throw new PermanentError(
        'ANALYSIS_CONTENT_REJECTED',
        'The analysis provider declined to process this content.',
      );
    const text =
      candidate?.content?.parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join('') ?? '';
    return {
      result: candidate?.finishReason === 'STOP' ? parseJson(text) : null,
      inputTokens: result.data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens:
        (result.data.usageMetadata?.candidatesTokenCount ?? 0) +
        (result.data.usageMetadata?.thoughtsTokenCount ?? 0),
    };
  }
}

export class GroqLlmProvider extends FreeLlmProvider {
  async generateStructured(
    prompt: string,
    jsonSchema: Record<string, unknown>,
    options: LlmOptions,
  ): Promise<LlmResult> {
    const { $schema: dialect, ...schema } = jsonSchema;
    void dialect;
    const supportsSchema = /^(openai\/gpt-oss-|qwen\/|meta-models\/)/.test(this.model);
    const value = await this.send(
      'https://api.groq.com/openai/v1/chat/completions',
      { authorization: `Bearer ${this.config.key}` },
      {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: supportsSchema
              ? prompt
              : `${prompt}\nReturn JSON matching this schema: ${JSON.stringify(schema)}`,
          },
        ],
        response_format: supportsSchema
          ? {
              type: 'json_schema',
              json_schema: { name: 'meeting_extraction', strict: true, schema },
            }
          : { type: 'json_object' },
        max_completion_tokens: OUTPUT_TOKENS,
        ...(this.model.startsWith('openai/gpt-oss-')
          ? { reasoning_effort: 'low', include_reasoning: false }
          : {}),
        temperature: 0,
      },
      options,
    );
    const result = groqEnvelope.safeParse(value);
    if (!result.success) throw new ProviderRetryError(5000, false);
    const choice = result.data.choices[0];
    return {
      result: choice?.finish_reason === 'stop' ? parseJson(choice.message.content ?? '') : null,
      inputTokens: result.data.usage.prompt_tokens,
      outputTokens: result.data.usage.completion_tokens,
    };
  }
}

/** Only quota exhaustion triggers fallback. Both providers retain their own shared limits. */
export class FallbackLlmProvider implements LlmProvider {
  readonly external = true;
  readonly contextBudget: number;
  readonly model: string;
  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
  ) {
    this.model = `${primary.model} / ${fallback.model}`;
    this.contextBudget = Math.min(primary.contextBudget ?? 24000, fallback.contextBudget ?? 24000);
  }
  async generateStructured(prompt: string, schema: Record<string, unknown>, options: LlmOptions) {
    try {
      return await this.primary.generateStructured(prompt, schema, options);
    } catch (error) {
      if (!(error instanceof ProviderRetryError) || !error.quota) throw error;
      return this.fallback.generateStructured(prompt, schema, options);
    }
  }
}
