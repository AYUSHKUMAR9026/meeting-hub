import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

import type { Redis } from '../lib/redis';

/**
 * Per-IP limits on abuse-prone endpoints, on top of Better Auth's own limiter. Routes opt in with
 * `config: { rateLimit: rateLimits.<name> }`; nothing else is limited.
 */
export const rateLimits = {
  signIn: { max: 10, timeWindow: '1 minute' },
  signUp: { max: 5, timeWindow: '10 minutes' },
  passwordReset: { max: 5, timeWindow: '15 minutes' },
  invite: { max: 30, timeWindow: '1 hour' },
  acceptInvitation: { max: 20, timeWindow: '15 minutes' },
} as const;

export async function registerRateLimiting(
  app: FastifyInstance,
  options: { enabled: boolean; redis: Redis },
): Promise<void> {
  if (!options.enabled) return;
  await app.register(rateLimit, {
    global: false,
    redis: options.redis,
    nameSpace: 'rl:http:',
    // Fail open: Redis being down must not lock everyone out of signing in.
    skipOnError: true,
    // `request.ip` honours X-Forwarded-For from the web proxy (trustProxy, see app.ts).
    keyGenerator: (req) => req.ip,
  });
}
