import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, parseFlagOverrides } from '../src/lib/config';

const validEnv = {
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:3900',
  S3_REGION: 'garage',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  SMTP_HOST: 'localhost',
};

function issuesFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_PORT: 4000,
      S3_FORCE_PATH_STYLE: true,
      FEATURE_FLAGS_OVERRIDE: {},
      FEATURE_FLAGS_CACHE_TTL_MS: 5000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('coerces numbers and booleans', () => {
    const config = loadConfig({ ...validEnv, API_PORT: '8080', S3_FORCE_PATH_STYLE: 'false' });
    expect(config.API_PORT).toBe(8080);
    expect(config.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ ...validEnv, API_PORT: '', FEATURE_FLAGS_OVERRIDE: '' });
    expect(config.API_PORT).toBe(4000);
    expect(config.FEATURE_FLAGS_OVERRIDE).toEqual({});
  });

  it('reports every missing required variable by name', () => {
    const issues = issuesFor({});
    expect(issues).toEqual(
      expect.arrayContaining([
        'WEB_ORIGIN: is required',
        'DATABASE_URL: is required',
        'REDIS_URL: is required',
        'S3_BUCKET: is required',
      ]),
    );
  });

  it('rejects wrong URL protocols with a clear message', () => {
    const issues = issuesFor({ ...validEnv, DATABASE_URL: 'mysql://x', REDIS_URL: 'http://x' });
    expect(issues).toContain('DATABASE_URL: must be a postgres:// URL');
    expect(issues).toContain('REDIS_URL: must be a redis:// or rediss:// URL');
  });

  it('rejects out-of-range and invalid enum values', () => {
    const issues = issuesFor({ ...validEnv, API_PORT: '70000', NODE_ENV: 'staging' });
    expect(issues.some((i) => i.startsWith('API_PORT:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('NODE_ENV:'))).toBe(true);
  });

  it('parses FEATURE_FLAGS_OVERRIDE and rejects malformed entries', () => {
    expect(
      loadConfig({ ...validEnv, FEATURE_FLAGS_OVERRIDE: 'a.b=true, c=false' })
        .FEATURE_FLAGS_OVERRIDE,
    ).toEqual({ 'a.b': true, c: false });
    expect(issuesFor({ ...validEnv, FEATURE_FLAGS_OVERRIDE: 'a=yes' })[0]).toMatch(
      /^FEATURE_FLAGS_OVERRIDE: invalid entry "a=yes"/,
    );
  });
});

describe('parseFlagOverrides', () => {
  it('ignores blank segments', () => {
    expect(parseFlagOverrides(' x=true,, ')).toEqual({ x: true });
  });
});

describe('loadConfig: auth, mail and rate limits', () => {
  it('requires a long enough auth secret', () => {
    expect(issuesFor({ ...validEnv, BETTER_AUTH_SECRET: 'short' })).toEqual([
      'BETTER_AUTH_SECRET: must be at least 32 characters',
    ]);
  });

  it('requires Google client id and secret together', () => {
    expect(issuesFor({ ...validEnv, GOOGLE_CLIENT_ID: 'id' })).toEqual([
      'GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
    ]);
    expect(
      loadConfig({ ...validEnv, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }),
    ).toMatchObject({ GOOGLE_CLIENT_ID: 'id' });
  });

  it('defaults mail and rate-limit settings', () => {
    expect(loadConfig(validEnv)).toMatchObject({
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      RATE_LIMIT_ENABLED: true,
    });
  });
});
