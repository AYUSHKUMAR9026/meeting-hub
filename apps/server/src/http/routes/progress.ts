import {
  meetingParamsSchema,
  workspaceParamsSchema,
  progressQuerySchema,
  progressSummarySchema,
  progressSeriesSchema,
  progressOwnersSchema,
  progressMeetingsSchema,
  progressRecapSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { csv } from '../../modules/progress';
import { originOf } from '../caller';
import { problems, WORKSPACE_ERRORS } from './problems';

const access = { kind: 'workspace', action: 'workspace.read', flag: 'progress.enabled' } as const;
const errors = problems(...WORKSPACE_ERRORS);

export const progressRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  app.get(
    '/v1/workspaces/:wid/progress/summary',
    {
      config: { access },
      schema: {
        tags: ['progress'],
        params: workspaceParamsSchema,
        querystring: progressQuerySchema,
        response: { 200: progressSummarySchema, ...errors },
      },
    },
    (req) => deps.progress.summary(workspaceActorOf(req), req.query),
  );
  app.get(
    '/v1/workspaces/:wid/progress/timeseries',
    {
      config: { access },
      schema: {
        tags: ['progress'],
        params: workspaceParamsSchema,
        querystring: progressQuerySchema,
        response: { 200: progressSeriesSchema, ...errors },
      },
    },
    (req) => deps.progress.timeseries(workspaceActorOf(req), req.query),
  );
  app.get(
    '/v1/workspaces/:wid/progress/owners',
    {
      config: { access },
      schema: {
        tags: ['progress'],
        params: workspaceParamsSchema,
        querystring: progressQuerySchema,
        response: { 200: progressOwnersSchema, ...errors },
      },
    },
    (req) => deps.progress.owners(workspaceActorOf(req), req.query),
  );
  app.get(
    '/v1/workspaces/:wid/progress/meetings',
    {
      config: { access },
      schema: {
        tags: ['progress'],
        params: workspaceParamsSchema,
        querystring: progressQuerySchema,
        response: { 200: progressMeetingsSchema, ...errors },
      },
    },
    (req) => deps.progress.meetings(workspaceActorOf(req), req.query),
  );
  app.get(
    '/v1/meetings/:id/progress',
    {
      config: { access: { ...access, action: 'meeting.read', workspaceFrom: 'meeting' } },
      schema: {
        tags: ['progress'],
        params: meetingParamsSchema,
        response: { 200: progressRecapSchema, ...errors },
      },
    },
    (req) => deps.progress.recap(workspaceActorOf(req), req.params.id),
  );
  app.get(
    '/v1/workspaces/:wid/progress/export',
    {
      exposeHeadRoute: false,
      config: { access },
      schema: {
        tags: ['progress'],
        params: workspaceParamsSchema,
        querystring: progressQuerySchema,
        response: {
          200: { content: { 'text/csv': { schema: z.string() } } },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const actor = workspaceActorOf(req);
      const result = await deps.progress.timeseries(actor, req.query);
      const body = csv(result.points);
      await deps.audit.record({
        action: 'progress.exported',
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        target: { type: 'workspace', id: actor.workspaceId },
        metadata: { rows: result.points.length, bucket: req.query.bucket },
        origin: originOf(req),
      });
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="progress.csv"')
        .header('X-Content-Type-Options', 'nosniff')
        .send(body);
    },
  );
  done();
};
