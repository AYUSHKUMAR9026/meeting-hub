import {
  flagsResponseSchema,
  healthResponseSchema,
  problemSchema,
  readyResponseSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ApiDeps } from '../../deps';
import { checkReadiness } from '../readiness';

export const systemRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        description: 'Cheap check that the process is up. Never touches dependencies.',
        response: { 200: healthResponseSchema },
      },
      logLevel: 'warn',
    },
    () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }),
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness probe',
        description: 'Checks Postgres, Redis and S3. Returns 503 if any dependency is down.',
        response: { 200: readyResponseSchema, 503: readyResponseSchema },
      },
    },
    async (_req, reply) => {
      const result = await checkReadiness({
        pool: deps.db.pool,
        redis: deps.redis,
        s3: deps.s3,
        bucket: deps.config.S3_BUCKET,
      });
      return reply.status(result.status === 'ready' ? 200 : 503).send(result);
    },
  );

  // Temporary, dev-only introspection endpoint. Not registered in production.
  if (deps.config.NODE_ENV !== 'production') {
    app.get(
      '/v1/system/flags',
      {
        config: { access: { kind: 'public' } },
        schema: {
          tags: ['system'],
          summary: 'Evaluated feature flags (development only)',
          response: { 200: flagsResponseSchema, 500: problemSchema },
        },
      },
      async () => ({ flags: await deps.flags.evaluateAll() }),
    );
  }

  done();
};
