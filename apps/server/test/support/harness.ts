/**
 * Builds the real API against the shared Testcontainers Postgres/Redis, with an in-memory mailer
 * and a stub S3, plus helpers that drive Better Auth over HTTP like a browser would.
 */
import { randomUUID } from 'node:crypto';

import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { expect, inject, vi } from 'vitest';

import { buildApp } from '../../src/app';
import { type ApiDeps, closeApiDeps, createApiDeps } from '../../src/deps';
import { loadConfig } from '../../src/lib/config';
import { redactPaths } from '../../src/lib/logger';
import { MemoryMailer } from '../../src/lib/mailer';
import { createRedis } from '../../src/lib/redis';

export const WEB_ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery-staple';

export interface TestApp {
  app: FastifyInstance;
  deps: ApiDeps;
  mailer: MemoryMailer;
  logLines: Record<string, unknown>[];
  close: () => Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN,
    BETTER_AUTH_URL: WEB_ORIGIN,
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    S3_REGION: 'test',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test',
    SMTP_HOST: 'localhost',
    RATE_LIMIT_ENABLED: 'false',
    FEATURE_FLAGS_CACHE_TTL_MS: '0',
    FEATURE_FLAGS_OVERRIDE: 'workspaces.invitations=true,people.directory=true',
    ...env,
  });
  const logLines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'info', redact: { paths: redactPaths, censor: '[REDACTED]' } },
    { write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const redis = createRedis(config.REDIS_URL, 'test');
  await redis.connect();
  const mailer = new MemoryMailer();
  const s3 = { send: vi.fn().mockResolvedValue({}), destroy: vi.fn() } as unknown as S3Client;
  const deps = createApiDeps(config, logger, { redis, s3, mailer });
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    mailer,
    logLines,
    close: async () => {
      await app.close();
      await closeApiDeps(deps);
    },
  };
}

/** A unique email per call, so test files can share one database. */
export const uniqueEmail = (label: string) =>
  `${label}-${randomUUID().slice(0, 8)}@example.test`.toLowerCase();

/** "name=value; name2=value2" from a response's Set-Cookie headers. */
export function cookiesFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='))
    .join('; ');
}

export interface Session {
  userId: string;
  email: string;
  name: string;
  cookie: string;
}

/** Browser-like request: same-origin Origin header and the session cookie, if any. */
export function call(
  t: TestApp,
  session: Session | null,
  options: Omit<InjectOptions, 'headers'> & { headers?: Record<string, string> },
) {
  return t.app.inject({
    ...options,
    headers: {
      origin: WEB_ORIGIN,
      'user-agent': 'vitest',
      ...(session ? { cookie: session.cookie } : {}),
      ...options.headers,
    },
  });
}

/** Waits for the (background-sent) email to `to` and returns the first link in it. */
export async function linkFromEmail(t: TestApp, to: string, after = 0): Promise<URL> {
  let url: URL | undefined;
  await vi.waitFor(
    () => {
      const message = t.mailer.sent.slice(after).findLast((m) => m.to === to);
      const match = message?.text.match(/https?:\/\/\S+/);
      expect(match).toBeTruthy();
      url = new URL(match![0]);
    },
    { timeout: 5_000, interval: 25 },
  );
  return url!;
}

export async function signUp(t: TestApp, email: string, name = email.split('@')[0]!) {
  const res = await call(t, null, {
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, name, password: PASSWORD, callbackURL: '/' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

/** Follows the verification link like a browser; returns the session it signs in with. */
export async function verifyEmail(t: TestApp, email: string): Promise<string> {
  const link = await linkFromEmail(t, email);
  const res = await t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
  expect([200, 302]).toContain(res.statusCode);
  return cookiesFrom(res);
}

export async function signIn(t: TestApp, email: string, password = PASSWORD): Promise<string> {
  const res = await call(t, null, {
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return cookiesFrom(res);
}

/** Sign up → verify via the emailed link → sign in. */
export async function createUser(t: TestApp, label: string): Promise<Session> {
  const email = uniqueEmail(label);
  await signUp(t, email, label);
  await verifyEmail(t, email);
  const cookie = await signIn(t, email);
  const me = await call(t, { cookie } as Session, { method: 'GET', url: '/v1/me' });
  expect(me.statusCode, me.body).toBe(200);
  return { userId: me.json<{ user: { id: string } }>().user.id, email, name: label, cookie };
}

export async function createWorkspace(t: TestApp, owner: Session, name: string) {
  const res = await call(t, owner, { method: 'POST', url: '/v1/workspaces', payload: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string; slug: string; name: string }>();
}

/** Invites `user` with `role` and accepts as them. */
export async function addMember(
  t: TestApp,
  workspaceId: string,
  inviter: Session,
  user: Session,
  role: string,
) {
  const invite = await call(t, inviter, {
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/invitations`,
    payload: { email: user.email, role },
  });
  expect(invite.statusCode, invite.body).toBe(201);
  const accept = await call(t, user, {
    method: 'POST',
    url: `/v1/invitations/${invite.json<{ id: string }>().id}/accept`,
  });
  expect(accept.statusCode, accept.body).toBe(200);
}
