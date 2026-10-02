import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PROBLEM_CONTENT_TYPE, registerErrorHandling } from '../src/http/error-handler';
import { AppError, NotFoundError, PermanentError } from '../src/lib/errors';

async function buildTestApp(exposeInternals: boolean): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app, { exposeInternals });

  app.get('/boom', () => {
    throw new Error('database password is hunter2');
  });
  app.get('/not-found', () => {
    throw new NotFoundError('Meeting not found');
  });
  app.get('/internal-app-error', () => {
    throw new AppError('UPSTREAM_FAILED', 'secret upstream detail');
  });
  app.get('/permanent', () => {
    throw new PermanentError('UNSUPPORTED_FORMAT', 'File format not supported');
  });
  app.post(
    '/validate',
    { schema: { body: z.object({ name: z.string().min(1), age: z.number() }) } },
    () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

describe('error handler', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  describe('in production', () => {
    it('hides internal messages and stack traces for unknown errors', async () => {
      app = await buildTestApp(false);
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      const body = res.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_ERROR',
        detail: 'An unexpected error occurred.',
        instance: '/boom',
      });
      expect(body.requestId).toEqual(expect.any(String));
      expect(body).not.toHaveProperty('stack');
      expect(res.body).not.toContain('hunter2');
    });

    it('does not expose the message of a 5xx AppError', async () => {
      app = await buildTestApp(false);
      const res = await app.inject({ method: 'GET', url: '/internal-app-error' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: 'UPSTREAM_FAILED' });
      expect(res.body).not.toContain('secret upstream detail');
    });
  });

  it('maps AppError subclasses to their status and stable code', async () => {
    app = await buildTestApp(false);
    const notFound = await app.inject({ method: 'GET', url: '/not-found' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ code: 'NOT_FOUND', detail: 'Meeting not found' });

    const permanent = await app.inject({ method: 'GET', url: '/permanent' });
    expect(permanent.statusCode).toBe(422);
    expect(permanent.json()).toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('returns VALIDATION_FAILED with field errors for bad input', async () => {
    app = await buildTestApp(false);
    const res = await app.inject({ method: 'POST', url: '/validate', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const body = res.json<{ code: string; errors: { path: string }[] }>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['body/name', 'body/age']),
    );
  });

  it('returns NOT_FOUND problem for unknown routes', async () => {
    app = await buildTestApp(false);
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('maps framework 4xx errors (malformed JSON) to a stable code', async () => {
    app = await buildTestApp(false);
    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('includes message and stack in development', async () => {
    app = await buildTestApp(true);
    const res = await app.inject({ method: 'GET', url: '/boom' });
    const body = res.json<{ detail: string; stack: string }>();
    expect(body.detail).toBe('database password is hunter2');
    expect(body.stack).toContain('Error: database password is hunter2');
  });
});
