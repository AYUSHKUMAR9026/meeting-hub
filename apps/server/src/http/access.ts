/**
 * Route-level access control. Every /v1 route declares `config.access`; one onRequest hook enforces
 * it before body validation, so callers who may not use a route never learn about its schema:
 *
 *   public         → no checks
 *   authenticated  → requireSession (401)
 *   workspace      → requireSession (401) → requireWorkspace (404 if not a member)
 *                    → feature flag (404 if off) → authorize(action) (403)
 *
 * A /v1 route without a declaration fails at startup, and the authorization matrix test
 * (test/authorization-matrix.int.test.ts) checks every declared route against every role.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ForbiddenError, NotFoundError } from '../lib/errors';
import {
  type Action,
  type Auth,
  authorize,
  requireSession,
  workspaceActorOf,
} from '../modules/auth';
import type { MeetingService } from '../modules/meetings';
import type { PeopleService } from '../modules/people';
import type { FeatureFlagService, FlagKey } from '../modules/platform';
import {
  requireWorkspace,
  workspaceFromParam,
  type WorkspaceResolver,
  type WorkspaceService,
} from '../modules/workspaces';

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | {
      kind: 'workspace';
      action: Action;
      /** How to find the workspace: the `wid` path param (default), or the person / meeting in `:id`. */
      workspaceFrom?: 'param' | 'person' | 'meeting';
      /** Feature flag that must be on for the workspace; 404 otherwise. */
      flag?: FlagKey;
      /** Skip the action check when this path param is the caller's own user id (e.g. leaving). */
      unlessSelf?: string;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyInstance {
    /** Every route with its declared access, for the authorization matrix test. */
    routeCatalog: { method: string; url: string; access: RouteAccess | undefined }[];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const param = (req: FastifyRequest, name: string) => {
  const value = (req.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
};

export function registerAccessControl(
  app: FastifyInstance,
  deps: {
    auth: Auth;
    workspaces: WorkspaceService;
    people: PeopleService;
    meetings: MeetingService;
    flags: FeatureFlagService;
    webOrigin: string;
  },
): void {
  app.decorate('routeCatalog', []);
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    if (route.url.startsWith('/v1/') && !access) {
      throw new Error(`${String(route.method)} ${route.url} must declare config.access`);
    }
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') app.routeCatalog.push({ method, url: route.url, access });
    }
  });

  const session = requireSession(deps.auth);
  const idParam = (req: FastifyRequest) => {
    const id = param(req, 'id');
    return id && UUID.test(id) ? id : null;
  };
  const resolvers: Record<'param' | 'person' | 'meeting', WorkspaceResolver> = {
    param: workspaceFromParam('wid'),
    person: (req, userId) => {
      const personId = idParam(req);
      return personId ? deps.people.workspaceIdForMember(personId, userId) : null;
    },
    // Deleted meetings resolve to nothing, so every route on them is a 404.
    meeting: (req, userId) => {
      const meetingId = idParam(req);
      return meetingId ? deps.meetings.workspaceIdForMember(meetingId, userId) : null;
    },
  };

  app.addHook('onRequest', async (req, reply) => {
    const access = req.routeOptions.config.access;
    if (!access || access.kind === 'public') return;

    // Cookie-authenticated writes must come from our web origin (SameSite=Lax is the first line).
    const origin = req.headers.origin;
    if (!SAFE_METHODS.has(req.method) && origin && origin !== deps.webOrigin) {
      throw new ForbiddenError('Cross-origin request rejected', { code: 'CROSS_ORIGIN' });
    }

    await session(req, reply);
    if (access.kind === 'authenticated') return;

    await requireWorkspace(deps.workspaces, resolvers[access.workspaceFrom ?? 'param'])(req, reply);
    const actor = workspaceActorOf(req);
    if (
      access.flag &&
      !(await deps.flags.isEnabled(access.flag, { workspaceId: actor.workspaceId }))
    ) {
      throw new NotFoundError();
    }
    if (access.unlessSelf && param(req, access.unlessSelf) === actor.userId) return;
    authorize(actor, access.action);
  });
}
