import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { ApiDeps } from './deps';
import { registerErrorHandling } from './http/error-handler';
import { genReqId, REQUEST_ID_HEADER } from './http/request-id';
import { systemRoutes } from './http/routes/system';

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
    requestIdLogLabel: 'request_id',
    return503OnClosing: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  registerErrorHandling(app, { exposeInternals: isDev });

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
      tags: [{ name: 'system', description: 'Health, readiness and platform introspection' }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(systemRoutes, { deps });

  if (config.NODE_ENV !== 'production') {
    app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
  }

  return app;
}
