import type { Config } from '../../lib/config';
import type { Redis } from '../../lib/redis';
import { RedisQuotaLimiter } from '../../lib/ai-quota';
import { AnthropicProvider, FakeLlmProvider, type LlmProvider } from './provider';
import { GeminiLlmProvider, GroqLlmProvider, FallbackLlmProvider } from './free-providers';

export function configuredLlm(config: Config, redis: Redis): LlmProvider {
  const make = (name: Config['LLM_PROVIDER']): LlmProvider => {
    switch (name) {
      case 'gemini':
        return new GeminiLlmProvider({
          key: config.GEMINI_API_KEY!,
          model: config.GEMINI_MODEL,
          limiter: new RedisQuotaLimiter(redis, 'gemini', config.GEMINI_API_KEY!),
          rpm: config.GEMINI_RPM,
          rpd: config.GEMINI_RPD,
          tpm: config.GEMINI_TPM,
          context: config.GEMINI_CONTEXT_TOKENS,
        });
      case 'groq':
        return new GroqLlmProvider({
          key: config.GROQ_API_KEY!,
          model: config.GROQ_LLM_MODEL,
          limiter: new RedisQuotaLimiter(redis, 'groq-llm', config.GROQ_API_KEY!),
          rpm: config.GROQ_LLM_RPM,
          rpd: config.GROQ_LLM_RPD,
          tpm: config.GROQ_LLM_TPM,
          tpd: config.GROQ_LLM_TPD,
          context: config.GROQ_LLM_CONTEXT_TOKENS,
        });
      case 'anthropic':
        return new AnthropicProvider(config.LLM_MODEL, config.ANTHROPIC_API_KEY!);
      default:
        return new FakeLlmProvider();
    }
  };
  const primary = make(config.LLM_PROVIDER);
  return config.LLM_FALLBACK_PROVIDER
    ? new FallbackLlmProvider(primary, make(config.LLM_FALLBACK_PROVIDER))
    : primary;
}
