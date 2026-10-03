/**
 * Mounts Better Auth at /api/auth/* (ADR 0002). Only the endpoints the browser needs are exposed;
 * Better Auth's organization endpoints are reachable only server-side via our /v1 routes.
 */
import type { FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ApiDeps } from '../../deps';
import { NotFoundError } from '../../lib/errors';
import { AUTH_BASE_PATH, toFetchHeaders } from '../../modules/auth';
import { rateLimits } from '../rate-limit';

/** [method, path or prefix ending in '/'] relative to /api/auth. */
const EXPOSED: readonly (readonly [string, string])[] = [
  ['POST', '/sign-up/email'],
  ['POST', '/sign-in/email'],
  ['POST', '/sign-in/social'],
  ['POST', '/sign-out'],
  ['GET', '/get-session'],
  ['GET', '/verify-email'],
  ['POST', '/send-verification-email'],
  ['POST', '/request-password-reset'],
  ['GET', '/reset-password/'],
  ['POST', '/reset-password'],
  ['GET', '/callback/'],
  ['POST', '/callback/'],
  ['GET', '/ok'],
  ['GET', '/error'],
];

const isExposed = (method: string, path: string) =>
  EXPOSED.some(([m, p]) => m === method && (p.endsWith('/') ? path.startsWith(p) : path === p));

const isGooglePath = (path: string) => path === '/sign-in/social' || path.startsWith('/callback/');

export const authRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { auth, config, flags } = deps;
  const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

  async function handle(req: FastifyRequest, reply: FastifyReply) {
    const url = new URL(req.url, config.BETTER_AUTH_URL);
    const path = url.pathname.slice(AUTH_BASE_PATH.length);
    if (!isExposed(req.method, path)) throw new NotFoundError();
    if (
      isGooglePath(path) &&
      !(googleConfigured && (await flags.isEnabled('auth.google_signin')))
    ) {
      throw new NotFoundError();
    }

    const headers = toFetchHeaders(req.headers);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined;
    if (hasBody && typeof req.body !== 'string') headers.set('content-type', 'application/json');
    const response = await auth.handler(
      new Request(url, {
        method: req.method,
        headers,
        ...(hasBody
          ? { body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body) }
          : {}),
      }),
    );

    reply.status(response.status);
    for (const [key, value] of response.headers) {
      if (key !== 'set-cookie') void reply.header(key, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) void reply.header('set-cookie', cookies);
    return reply.send(response.body ? await response.text() : null);
  }

  const route = (rateLimit?: (typeof rateLimits)[keyof typeof rateLimits]) =>
    ({
      schema: { hide: true },
      config: { access: { kind: 'public' }, ...(rateLimit ? { rateLimit } : {}) },
      // Never log credentials: Fastify logs no bodies by default, and these routes stay that way.
    }) satisfies RouteShorthandOptions;

  app.post(`${AUTH_BASE_PATH}/sign-in/email`, route(rateLimits.signIn), handle);
  app.post(`${AUTH_BASE_PATH}/sign-up/email`, route(rateLimits.signUp), handle);
  app.post(`${AUTH_BASE_PATH}/request-password-reset`, route(rateLimits.passwordReset), handle);
  app.post(`${AUTH_BASE_PATH}/reset-password`, route(rateLimits.passwordReset), handle);
  app.route({ method: ['GET', 'POST'], url: `${AUTH_BASE_PATH}/*`, ...route(), handler: handle });

  done();
};
