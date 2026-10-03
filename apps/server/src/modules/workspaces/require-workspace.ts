import type { FastifyReply, FastifyRequest } from 'fastify';

import { NotFoundError } from '../../lib/errors';
import { bindLogContext, currentUserOf } from '../auth';
import type { WorkspaceService } from './workspace-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finds the workspace a request targets; null when it can't be determined (→ 404). */
export type WorkspaceResolver = (
  req: FastifyRequest,
  userId: string,
) => Promise<string | null> | string | null;

/** Reads the workspace id from a path parameter (default `wid`). */
export const workspaceFromParam =
  (param = 'wid'): WorkspaceResolver =>
  (req) => {
    const value = (req.params as Record<string, unknown> | undefined)?.[param];
    return typeof value === 'string' ? value : null;
  };

/**
 * preHandler (after requireSession): resolves the workspace, checks the caller is a member and
 * attaches `{ userId, workspaceId, role }` as `req.workspaceActor`. Not a member, malformed id, or
 * no such workspace all give the same 404, so workspace existence never leaks.
 * Membership is read from Postgres on every request: removal takes effect immediately.
 */
export function requireWorkspace(service: WorkspaceService, resolve: WorkspaceResolver) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = currentUserOf(req);
    const workspaceId = await resolve(req, user.id);
    if (!workspaceId || !UUID.test(workspaceId)) throw new NotFoundError();
    const role = await service.findRole(workspaceId, user.id);
    if (!role) throw new NotFoundError();
    req.workspaceActor = { userId: user.id, workspaceId, role };
    bindLogContext(req, reply, { workspace_id: workspaceId });
  };
}
