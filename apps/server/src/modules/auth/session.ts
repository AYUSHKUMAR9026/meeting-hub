import type { FastifyReply, FastifyRequest, RawRequestDefaultExpression } from 'fastify';

import { UnauthorizedError } from '../../lib/errors';
import type { WorkspaceActor } from './authorization/authorize';
import type { Auth } from './better-auth';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  image: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession. */
    currentUser: CurrentUser | null;
    /** Set by requireWorkspace. */
    workspaceActor: WorkspaceActor | null;
  }
}

/** Node's incoming headers as a Fetch `Headers` (what Better Auth expects). */
export function toFetchHeaders(raw: RawRequestDefaultExpression['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/** Adds fields to this request's log lines, including Fastify's own "request completed" line. */
export function bindLogContext(
  req: FastifyRequest,
  reply: FastifyReply,
  bindings: Record<string, string>,
): void {
  const child = req.log.child(bindings);
  req.log = child;
  reply.log = child;
}

/** Looks up the session for a request; null when signed out or the session expired/was revoked. */
export async function resolveSession(auth: Auth, req: FastifyRequest): Promise<CurrentUser | null> {
  const result = await auth.api.getSession({ headers: toFetchHeaders(req.headers) });
  if (!result) return null;
  const { id, email, name, emailVerified, image } = result.user;
  return { id, email, name, emailVerified, image: image ?? null };
}

/** preHandler: 401 unless signed in. Attaches `req.currentUser` and `user_id` to the log context. */
export function requireSession(auth: Auth) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const currentUser = await resolveSession(auth, req);
    if (!currentUser) throw new UnauthorizedError();
    req.currentUser = currentUser;
    bindLogContext(req, reply, { user_id: currentUser.id });
  };
}

/** The signed-in user; only valid on routes behind requireSession. */
export function currentUserOf(req: FastifyRequest): CurrentUser {
  if (!req.currentUser) throw new UnauthorizedError();
  return req.currentUser;
}

/** The workspace actor; only valid on routes behind requireWorkspace. */
export function workspaceActorOf(req: FastifyRequest): WorkspaceActor {
  if (!req.workspaceActor) throw new Error('requireWorkspace did not run for this route');
  return req.workspaceActor;
}
