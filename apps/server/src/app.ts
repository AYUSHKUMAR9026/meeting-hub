import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { ApiDeps } from './deps';
import { registerAccessControl } from './http/access';
import { registerErrorHandling } from './http/error-handler';
import { registerRateLimiting } from './http/rate-limit';
import { genReqId, REQUEST_ID_HEADER } from './http/request-id';
import { auditRoutes } from './http/routes/audit';
import { authRoutes } from './http/routes/auth';
import { meetingRoutes } from './http/routes/meetings';
import { meRoutes } from './http/routes/me';
import { peopleRoutes } from './http/routes/people';
import { processingRoutes } from './http/routes/processing';
import { systemRoutes } from './http/routes/system';
import { workspaceRoutes } from './http/routes/workspaces';

/** Builds the Fastify app without listening. Used by api.ts, tests and the OpenAPI export. */
export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const isDev = config.NODE_ENV === 'development';

  const app = Fastify({
    // pino Logger is a FastifyBaseLogger; widen it so the instance type stays the default one
    // (tsc otherwise infers a Logger-typed instance that plugins typed for the default reject).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: deps.logger as FastifyBaseLogger,
    genReqId,
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    return503OnClosing: true,
    // The API sits behind the web app's same-origin proxy (ADR 0002). Next.js forwards the
    // X-Forwarded-For it received (e.g. from a load balancer) without adding to it, so trusting
    // exactly the configured hops makes request.ip the client's address for rate limits and audit.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
  }).withTypeProvider<ZodTypeProvider>();

  app.decorateRequest('currentUser', null);
  app.decorateRequest('workspaceActor', null);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  registerErrorHandling(app, { exposeInternals: isDev });
  registerAccessControl(app, {
    auth: deps.auth,
    workspaces: deps.workspaces,
    people: deps.people,
    meetings: deps.meetings,
    flags: deps.flags,
    webOrigin: config.WEB_ORIGIN,
  });
  await registerRateLimiting(app, { enabled: config.RATE_LIMIT_ENABLED, redis: deps.redis });

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Meeting Hub API',
        version: '0.1.0',
        description: 'Meeting Hub platform API. Errors use application/problem+json (RFC 9457).',
      },
      tags: [
        { name: 'system', description: 'Health, readiness and platform introspection' },
        { name: 'auth', description: 'The signed-in user (sign-in itself lives at /api/auth/*)' },
        { name: 'workspaces', description: 'Workspaces and their settings' },
        { name: 'members', description: 'Workspace membership and roles' },
        { name: 'invitations', description: 'Inviting people to a workspace' },
        { name: 'people', description: 'Directory of people who appear in meetings' },
        { name: 'audit', description: 'Append-only audit log' },
        { name: 'meetings', description: 'Meetings and their participants' },
        {
          name: 'uploads',
          description: 'Recording uploads straight from the browser to object storage (multipart)',
        },
        {
          name: 'processing',
          description: 'Processing runs, live progress (SSE) and the processed audio',
        },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(systemRoutes, { deps });
  await app.register(authRoutes, { deps });
  await app.register(meRoutes, { deps });
  await app.register(workspaceRoutes, { deps });
  await app.register(peopleRoutes, { deps });
  await app.register(auditRoutes, { deps });
  await app.register(meetingRoutes, { deps });
  await app.register(processingRoutes, { deps });

  if (config.NODE_ENV !== 'production') {
    app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
  }

  return app;
}
