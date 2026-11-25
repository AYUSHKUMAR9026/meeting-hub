import { existsSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const positiveInt = z.coerce.number().int().positive();

const MiB = 1024 * 1024;
/** S3 limits for multipart parts (every part but the last must be at least 5 MiB). */
const MIN_PART_SIZE = 5 * MiB;
const MAX_PART_SIZE = 5 * 1024 * MiB;

/** Parses "flag.a=true,flag.b=false" into a record. Throws a descriptive message on bad input. */
export function parseFlagOverrides(raw: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const match = /^([A-Za-z0-9._-]+)=(true|false)$/.exec(entry);
    if (!match) {
      throw new Error(`invalid entry "${entry}" (expected "<flag.key>=true|false")`);
    }
    result[match[1]!] = match[2] === 'true';
  }
  return result;
}

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEB_ORIGIN: z.url(),
    SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
    ROOM_PROVIDER: z.enum(['livekit', 'fake']).default('fake'),
    LIVEKIT_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:7880'),
    LIVEKIT_PUBLIC_URL: z.url({ protocol: /^wss?$/ }).default('ws://localhost:7880'),
    LIVEKIT_API_KEY: z.string().min(1).optional(),
    LIVEKIT_API_SECRET: z.string().min(32).optional(),
    ROOM_MAX_PARTICIPANTS: positiveInt.default(12),
    ROOM_MAX_MINUTES: positiveInt.default(60),
    ROOM_EMPTY_TIMEOUT_SECONDS: positiveInt.default(60),
    ROOM_WORKSPACE_LIMIT: positiveInt.default(3),
    LIVEKIT_EGRESS_S3_ENDPOINT: z.url().optional(),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' }),
    DATABASE_POOL_MAX: positiveInt.default(10),

    REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' }),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanString.default(true),
    // Endpoint baked into presigned URLs; must be reachable from browsers (defaults to S3_ENDPOINT).
    S3_PUBLIC_ENDPOINT: z.url().optional(),

    // Direct-to-storage uploads (ADR 0003).
    UPLOAD_PART_SIZE_BYTES: positiveInt
      .min(MIN_PART_SIZE, 'must be at least 5 MiB (S3 minimum)')
      .max(MAX_PART_SIZE)
      .default(16 * MiB),
    UPLOAD_URL_TTL_SECONDS: positiveInt
      .min(60)
      .max(7 * 24 * 3600)
      .default(15 * 60),
    UPLOAD_URL_BATCH_SIZE: positiveInt.max(100).default(10),
    MAX_UPLOAD_BYTES: positiveInt.max(5 * 1024 ** 4).default(2 * 1024 * MiB),
    UPLOAD_STALE_AFTER_HOURS: positiveInt.max(24 * 30).default(24),
    DOWNLOAD_URL_TTL_SECONDS: positiveInt
      .min(10)
      .max(3600)
      .default(5 * 60),

    FEATURE_FLAGS_OVERRIDE: z
      .string()
      .default('')
      .transform((raw, ctx) => {
        try {
          return parseFlagOverrides(raw);
        } catch (err) {
          ctx.addIssue({ code: 'custom', message: (err as Error).message });
          return z.NEVER;
        }
      }),
    FEATURE_FLAGS_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),

    WORKER_CONCURRENCY: positiveInt.default(5),
    HEARTBEAT_INTERVAL_MS: positiveInt.default(60_000),

    // Processing pipeline and media preparation (ADR 0004).
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    FFPROBE_PATH: z.string().min(1).default('ffprobe'),
    FFMPEG_THREADS: positiveInt.max(64).default(2),
    MEDIA_CONCURRENCY: positiveInt.max(256).default(() => availableParallelism()),
    MEDIA_TMP_DIR: z
      .string()
      .min(1)
      .default(() => tmpdir()),
    MAX_DURATION_SECONDS: positiveInt.max(24 * 3600).default(3 * 3600),
    MEDIA_URL_TTL_SECONDS: positiveInt
      .min(60)
      .max(12 * 3600)
      .default(15 * 60),
    OUTBOX_POLL_INTERVAL_MS: positiveInt.min(50).default(1_000),
    PUBLIC_WEB_URL: z
      .url({ protocol: /^https?$/ })
      .refine((url) => new URL(url).origin === url.replace(/\/$/, ''), 'Expected an HTTP(S) origin')
      .optional(),
    EXPORT_MAX_BYTES: positiveInt
      .min(1024)
      .max(25 * MiB)
      .default(8 * MiB),
    SHARE_MAX_DAYS: positiveInt.max(90).default(90),
    LLM_PROVIDER: z.enum(['gemini', 'groq', 'anthropic', 'fake']).default('fake'),
    LLM_FALLBACK_PROVIDER: z.enum(['gemini', 'groq']).optional(),
    GROQ_API_KEY: z.string().trim().min(1).optional(),
    GEMINI_API_KEY: z.string().trim().min(1).optional(),
    GROQ_STT_MODEL: z
      .enum(['whisper-large-v3-turbo', 'whisper-large-v3'])
      .default('whisper-large-v3-turbo'),
    GEMINI_MODEL: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .default('gemini-3.5-flash-lite'),
    GROQ_LLM_MODEL: z
      .string()
      .regex(/^[a-zA-Z0-9/._-]+$/)
      .default('openai/gpt-oss-20b'),
    GEMINI_RPM: positiveInt.default(1),
    GEMINI_RPD: positiveInt.default(20),
    GEMINI_TPM: positiveInt.min(4096).default(32000),
    GEMINI_CONTEXT_TOKENS: positiveInt.default(1048576),
    GROQ_LLM_RPM: positiveInt.default(30),
    GROQ_LLM_RPD: positiveInt.default(1000),
    GROQ_LLM_TPM: positiveInt.min(4096).default(8000),
    GROQ_LLM_TPD: positiveInt.default(200000),
    GROQ_LLM_CONTEXT_TOKENS: positiveInt.default(131072),
    TRANSCRIPTION_QUOTA_SECONDS_PER_HOUR: positiveInt.min(10).default(7200),
    TRANSCRIPTION_QUOTA_SECONDS_PER_DAY: positiveInt.min(10).default(28800),
    GROQ_STT_RPM: positiveInt.default(20),
    GROQ_STT_RPD: positiveInt.default(2000),
    ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
    LLM_MODEL: z.string().trim().min(1).max(200).default('claude-sonnet-4-6'),
    ANALYSIS_MAX_INPUT_TOKENS: positiveInt.min(1000).max(1000000).default(160000),
    TRANSCRIPTION_PROVIDER: z.enum(['groq', 'assemblyai', 'fake']).default('fake'),
    ASSEMBLYAI_API_KEY: z.string().trim().min(1).optional(),
    TRANSCRIPTION_MAX_DURATION_SECONDS: positiveInt.max(36_000).default(10_800),
    PROCESSING_SWEEP_INTERVAL_MS: positiveInt.min(1_000).default(60_000),
    SSE_HEARTBEAT_MS: positiveInt.min(100).default(15_000),

    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    // Public origin the browser uses: the web app, which proxies /api/auth/* to this API.
    BETTER_AUTH_URL: z.url(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(3).default('Meeting Hub <no-reply@meeting-hub.local>'),

    RATE_LIMIT_ENABLED: booleanString.default(true),
    // Proxies in front of the API whose X-Forwarded-For entries we trust (the web app = 1).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  })
  .superRefine((c, ctx) => {
    const selected = [c.LLM_PROVIDER, c.LLM_FALLBACK_PROVIDER, c.TRANSCRIPTION_PROVIDER];
    for (const [provider, key] of [
      ['groq', 'GROQ_API_KEY'],
      ['gemini', 'GEMINI_API_KEY'],
    ] as const) {
      if (selected.includes(provider) && !c[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `required for the ${provider} provider`,
        });
    }
    if (c.LLM_FALLBACK_PROVIDER === c.LLM_PROVIDER)
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_FALLBACK_PROVIDER'],
        message: 'must differ from the primary provider',
      });
    if (c.ROOM_PROVIDER === 'livekit' && (!c.LIVEKIT_API_KEY || !c.LIVEKIT_API_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ROOM_PROVIDER'],
        message: 'LiveKit credentials are required',
      });
    }
    if (c.LLM_PROVIDER === 'anthropic' && !c.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'required for the Anthropic provider',
      });
    }
    if (c.TRANSCRIPTION_PROVIDER === 'assemblyai' && !c.ASSEMBLYAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ASSEMBLYAI_API_KEY'],
        message: 'required for the AssemblyAI provider',
      });
    }
    if (Boolean(c.GOOGLE_CLIENT_ID) !== Boolean(c.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_SECRET'],
        message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Validates the environment and returns a typed, frozen config.
 * Empty strings are treated as unset so `FOO=` in .env falls back to the default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Readonly<Config> {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = configSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(root)';
        const missing = issue.code === 'invalid_type' && cleaned[key] === undefined;
        return `${key}: ${missing ? 'is required' : issue.message}`;
      }),
    );
  }
  return Object.freeze(result.data);
}

/**
 * In non-production, loads the repo-root .env (found by walking up to pnpm-workspace.yaml).
 * Variables already present in the environment are never overwritten.
 */
export function loadDotEnv(startDir: string = process.cwd()): void {
  if (process.env.NODE_ENV === 'production') return;
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const envFile = join(dir, '.env');
      if (existsSync(envFile)) process.loadEnvFile(envFile);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Loads .env + validates. On failure prints a readable error and exits (fail fast). */
export function loadConfigOrExit(): Readonly<Config> {
  loadDotEnv();
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\nSee .env.example for documentation.\n\n`);
      process.exit(1);
    }
    throw err;
  }
}
