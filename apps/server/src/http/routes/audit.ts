import {
  auditLogPageSchema,
  auditLogQuerySchema,
  workspaceParamsSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { iso } from '../caller';
import { problems, WORKSPACE_ERRORS } from './problems';

export const auditRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  app.get(
    '/v1/workspaces/:wid/audit-logs',
    {
      config: { access: { kind: 'workspace', action: 'audit.read' } },
      schema: {
        tags: ['audit'],
        summary: 'Audit log, newest first (owners and admins)',
        params: workspaceParamsSchema,
        querystring: auditLogQuerySchema,
        response: { 200: auditLogPageSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => {
      const page = await deps.audit.list(workspaceActorOf(req).workspaceId, req.query);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((item) => ({ ...item, createdAt: iso(item.createdAt) })),
      };
    },
  );

  done();
};
