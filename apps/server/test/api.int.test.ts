import type { S3Client } from '@aws-sdk/client-s3';
import { featureFlags, runMigrations } from '@meeting-hub/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import { type ApiDeps, closeApiDeps, createApiDeps } from '../src/deps';
import { startMaintenance } from '../src/jobs/maintenance';
import { HEARTBEAT_LAST_KEY } from '../src/jobs/processors/heartbeat';
import { loadConfig } from '../src/lib/config';
import { redactPaths } from '../src/lib/logger';
import { MemoryMailer } from '../src/lib/mailer';
import { createRedis } from '../src/lib/redis';
import { createMeetingMaintenance } from '../src/modules/meetings';

import { PG_IMAGE, REDIS_IMAGE } from './support/global-setup';

describe('api + worker against real Postgres and Redis', () => {
  let pg: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let deps: ApiDeps;
  let app: FastifyInstance;
  const logLines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    [pg, redisContainer] = await Promise.all([
      new PostgreSqlContainer(PG_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    await runMigrations(pg.getConnectionUri());

    const config = loadConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_REGION: 'test',
      S3_BUCKET: 'test-bucket',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
      FEATURE_FLAGS_CACHE_TTL_MS: '0',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
      BETTER_AUTH_URL: 'http://localhost:3000',
      SMTP_HOST: 'localhost',
      RATE_LIMIT_ENABLED: 'false',
    });
    const logger = pino(
      { level: 'info', redact: { paths: redactPaths, censor: '[REDACTED]' } },
      { write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const redis = createRedis(config.REDIS_URL, 'test');
    await redis.connect();
    // Uploads run against a real Garage elsewhere (support/global-setup.ts); this file only needs
    // S3 for /ready, and stops Redis mid-run, so it keeps its own containers and a stub S3.
    const s3 = { send: vi.fn().mockResolvedValue({}), destroy: vi.fn() } as unknown as S3Client;
    deps = createApiDeps(config, logger, { redis, s3, mailer: new MemoryMailer() });
    app = await buildApp(deps);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (deps) await closeApiDeps(deps);
    await Promise.all([pg?.stop(), redisContainer?.stop()]);
  });

  it('GET /health is cheap and always ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /ready reports every dependency up', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { 'x-request-id': 'it-ready-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('it-ready-1');
    expect(res.json()).toMatchObject({
      status: 'ready',
      checks: {
        postgres: { status: 'up' },
        redis: { status: 'up' },
        s3: { status: 'up' },
      },
    });
  });

  it('tags every request log line with request_id', () => {
    const lines = logLines.filter((l) => l.request_id === 'it-ready-1');
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['incoming request', 'request completed']),
    );
  });

  it('GET /v1/system/flags evaluates flags from the database', async () => {
    await deps.db.db.insert(featureFlags).values({ key: 'platform.heartbeat', enabled: false });
    const res = await app.inject({ method: 'GET', url: '/v1/system/flags' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ flags: unknown[] }>().flags).toContainEqual({
      key: 'platform.heartbeat',
      enabled: false,
      source: 'database',
    });
    await deps.db.db.delete(featureFlags);
  });

  it('the worker completes and records a heartbeat job', async () => {
    const workerLogs: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (l: string) => workerLogs.push(JSON.parse(l) as Record<string, unknown>) },
    );
    const maintenance = await startMaintenance({
      redisUrl: deps.config.REDIS_URL,
      redis: deps.redis,
      logger,
      flags: deps.flags,
      meetings: createMeetingMaintenance({
        db: deps.db.db,
        storage: deps.storage,
        audit: deps.audit,
        logger,
        staleAfterHours: 24,
      }),
      concurrency: 1,
      heartbeatIntervalMs: 60_000,
    });
    try {
      await vi.waitFor(
        () => expect(workerLogs.some((l) => l.msg === 'heartbeat completed')).toBe(true),
        { timeout: 15_000, interval: 100 },
      );
      const recorded = JSON.parse((await deps.redis.get(HEARTBEAT_LAST_KEY)) ?? '{}') as {
        completedAt?: string;
      };
      expect(recorded.completedAt).toEqual(expect.any(String));
    } finally {
      await maintenance.close();
    }
  });

  it('GET /ready returns 503 when a dependency is down', async () => {
    await redisContainer.stop();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ status: string; checks: Record<string, { status: string }> }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.redis?.status).toBe('down');
    expect(body.checks.postgres?.status).toBe('up');
  });
});
