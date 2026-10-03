import { ForbiddenError, NotFoundError } from '../../../lib/errors';
import { type Action, roleCan, type WorkspaceRole } from './permissions';

/** Who is acting, in which workspace, with which role. Attached to requests by `requireWorkspace`. */
export interface WorkspaceActor {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

/** The resource being acted on. Anything workspace-owned carries its workspace id. */
export interface AuthorizationResource {
  workspaceId: string;
}

/**
 * The single authorization check. Throws:
 * - 404 if the resource belongs to another workspace (never reveal it exists), and
 * - 403 if the actor's role may not perform `action` (see permissions.ts).
 */
export function authorize(
  actor: WorkspaceActor,
  action: Action,
  resource: AuthorizationResource = { workspaceId: actor.workspaceId },
): void {
  if (resource.workspaceId !== actor.workspaceId) throw new NotFoundError();
  if (!roleCan(actor.role, action)) {
    throw new ForbiddenError(`Your role (${actor.role}) cannot perform ${action}`);
  }
}
