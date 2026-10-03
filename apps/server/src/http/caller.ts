import type { FastifyRequest } from 'fastify';

import { type RequestOrigin } from '../modules/audit';
import { toFetchHeaders } from '../modules/auth';
import type { CallerContext } from '../modules/workspaces';

export const originOf = (req: FastifyRequest): RequestOrigin => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'] ?? null,
});

/** What services need to act as the caller: their headers (for Better Auth) and origin (audit). */
export const callerOf = (req: FastifyRequest): CallerContext => ({
  headers: toFetchHeaders(req.headers),
  origin: originOf(req),
});

/** Dates go over the wire as ISO-8601 strings. */
export const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();
