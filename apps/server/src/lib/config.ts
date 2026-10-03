import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const positiveInt = z.coerce.number().int().positive();

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

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' }),
    DATABASE_POOL_MAX: positiveInt.default(10),

    REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' }),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanString.default(true),

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
  })
  .superRefine((c, ctx) => {
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
