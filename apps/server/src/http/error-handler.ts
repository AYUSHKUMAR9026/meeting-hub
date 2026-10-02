import type { Problem } from '@meeting-hub/contracts';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { isAppError } from '../lib/errors';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Stable codes for framework-level 4xx errors (Fastify's own FST_* codes are not a contract). */
const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

const titleFor = (status: number) =>
  STATUS_TITLES[status] ?? (status >= 500 ? 'Internal Server Error' : 'Bad Request');

export type ProblemBody = Problem & { stack?: string };

export interface ProblemOptions {
  /** Include internal error messages and stack traces. Only ever true in development. */
  exposeInternals: boolean;
}

function problem(
  req: FastifyRequest,
  status: number,
  code: string,
  extra: Partial<ProblemBody> = {},
): ProblemBody {
  return {
    type: 'about:blank',
    title: titleFor(status),
    status,
    code,
    instance: req.url,
    requestId: req.id,
    ...extra,
  };
}

/** Maps any thrown value to an RFC 9457 problem body. Pure, so it is unit-testable. */
export function toProblem(err: unknown, req: FastifyRequest, opts: ProblemOptions): ProblemBody {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return problem(req, 400, 'VALIDATION_FAILED', {
      detail: 'The request did not match the expected schema.',
      errors: err.validation.map((v) => ({
        path: `${err.validationContext ?? 'request'}${v.instancePath}`,
        message: v.message ?? 'Invalid value',
      })),
    });
  }

  if (isAppError(err)) {
    const exposeDetail = err.expose || opts.exposeInternals;
    return problem(req, err.status, err.code, {
      ...(exposeDetail ? { detail: err.message } : {}),
      ...(opts.exposeInternals && err.status >= 500 && err.stack ? { stack: err.stack } : {}),
    });
  }

  const fastifyError = err as Partial<FastifyError>;
  const status = fastifyError.statusCode;
  if (
    !isResponseSerializationError(err) &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  ) {
    return problem(req, status, STATUS_CODES[status] ?? 'REQUEST_ERROR', {
      ...(fastifyError.message ? { detail: fastifyError.message } : {}),
    });
  }

  const error = err instanceof Error ? err : new Error(String(err));
  return problem(req, 500, 'INTERNAL_ERROR', opts.exposeInternals
    ? { detail: error.message, ...(error.stack ? { stack: error.stack } : {}) }
    : { detail: 'An unexpected error occurred.' });
}

export function registerErrorHandling(app: FastifyInstance, opts: ProblemOptions): void {
  app.setErrorHandler((err, req, reply) => {
    const body = toProblem(err, req, opts);
    if (body.status >= 500) {
      req.log.error({ err, code: body.code }, 'request failed');
    } else {
      req.log.info({ code: body.code, status: body.status }, 'request rejected');
    }
    return reply.status(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body = problem(req, 404, 'NOT_FOUND', {
      detail: `Route ${req.method} ${req.url} not found`,
    });
    return reply.status(404).type(PROBLEM_CONTENT_TYPE).send(body);
  });
}
