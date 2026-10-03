import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, createTestApp, type TestApp, uniqueEmail } from './support/harness';

describe('rate limits (Redis-backed)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
  });
  afterAll(() => t?.close());

  const resetRequest = (ip: string) =>
    call(t, null, {
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email: uniqueEmail('limited'), redirectTo: '/reset-password' },
      headers: { 'x-forwarded-for': ip },
    });

  it('limits password-reset requests per client IP and answers 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await resetRequest('203.0.113.7')).statusCode);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);

    // Another client is unaffected.
    expect((await resetRequest('203.0.113.8')).statusCode).toBe(200);
  });

  it("stores Better Auth's and the HTTP limiter's counters in Redis", async () => {
    const keys = await t.deps.redis.keys('rl:*');
    expect(keys.some((k) => k.startsWith('rl:auth:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('rl:http:'))).toBe(true);
  });

  it('limits repeated sign-in attempts', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await call(t, null, {
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'nobody@example.test', password: 'wrong-password-123' },
        headers: { 'x-forwarded-for': '198.51.100.20' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
  });
});
