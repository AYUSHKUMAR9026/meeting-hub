import {
  bulkDecisionSchema,
  createShareSchema,
  createdShareSchema,
  exportQuerySchema,
  meetingParamsSchema,
  publicShareSchema,
  shareListSchema,
  shareParamsSchema,
  shareTokenParamsSchema,
  trackedActionPageSchema,
  trackedActionQuerySchema,
  trackedDecisionPageSchema,
  trackedDecisionQuerySchema,
  transcriptExportQuerySchema,
  workspaceParamsSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { originOf } from '../caller';
import { rateLimits } from '../rate-limit';
import { problems, WORKSPACE_ERRORS } from './problems';

const meeting = { kind: 'workspace', workspaceFrom: 'meeting' } as const;
const exportAccess = { ...meeting, action: 'meeting.read', flag: 'exports.enabled' } as const;
const shareAccess = { ...meeting, action: 'meeting.update', flag: 'sharing.enabled' } as const;
const trackerAccess = {
  kind: 'workspace',
  action: 'workspace.read',
  flag: 'review.enabled',
} as const;
const errors = problems(...WORKSPACE_ERRORS);
const binary = { schema: z.any().meta({ type: 'string', format: 'binary' }) };
const documentContent = {
  'text/markdown': binary,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': binary,
  'application/pdf': binary,
};
const transcriptContent = {
  'text/plain': binary,
  'application/x-subrip': binary,
};
const empty = z.null().describe('No content');

export const reviewRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  app.get(
    '/v1/meetings/:id/export',
    {
      config: { access: exportAccess },
      exposeHeadRoute: false,
      schema: {
        tags: ['exports'],
        summary: 'Download the meeting document',
        params: meetingParamsSchema,
        querystring: exportQuerySchema,
        response: { 200: { content: documentContent }, ...problems(413, 504, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      const output = await deps.exports.download(
        workspaceActorOf(req),
        req.params.id,
        req.query.format,
        req.query.include === 'transcript',
        originOf(req),
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${output.filename}"`)
        .header('Content-Length', output.length)
        .type(output.contentType)
        .send(output.stream);
    },
  );
  app.get(
    '/v1/meetings/:id/transcript/export',
    {
      config: { access: exportAccess },
      exposeHeadRoute: false,
      schema: {
        tags: ['exports'],
        summary: 'Download the speaker-labelled transcript',
        params: meetingParamsSchema,
        querystring: transcriptExportQuerySchema,
        response: {
          200: { content: transcriptContent },
          ...problems(413, 504, ...WORKSPACE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const output = await deps.exports.download(
        workspaceActorOf(req),
        req.params.id,
        req.query.format,
        true,
        originOf(req),
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${output.filename}"`)
        .header('Content-Length', output.length)
        .type(output.contentType)
        .send(output.stream);
    },
  );

  app.get(
    '/v1/meetings/:id/share-links',
    {
      config: { access: shareAccess },
      schema: {
        tags: ['sharing'],
        summary: 'List share link metadata',
        params: meetingParamsSchema,
        response: { 200: shareListSchema, ...errors },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return deps.shares.list(workspaceActorOf(req), req.params.id);
    },
  );
  app.post(
    '/v1/meetings/:id/share-links',
    {
      config: { access: shareAccess },
      schema: {
        tags: ['sharing'],
        summary: 'Create a share link and show its URL once',
        params: meetingParamsSchema,
        body: createShareSchema,
        response: { 201: createdShareSchema, ...errors },
      },
    },
    async (req, reply) => {
      const link = await deps.shares.create(
        workspaceActorOf(req),
        req.params.id,
        req.body,
        originOf(req),
      );
      return reply.header('Cache-Control', 'private, no-store').status(201).send(link);
    },
  );
  app.delete(
    '/v1/meetings/:id/share-links/:shareId',
    {
      config: { access: shareAccess },
      schema: {
        tags: ['sharing'],
        summary: 'Revoke a public share link',
        params: shareParamsSchema,
        response: { 204: empty, ...errors },
      },
    },
    async (req, reply) => {
      await deps.shares.revoke(
        workspaceActorOf(req),
        req.params.id,
        req.params.shareId,
        originOf(req),
      );
      return reply.status(204).send(null);
    },
  );
  app.get(
    '/v1/public/shares/:token',
    {
      exposeHeadRoute: false,
      config: { access: { kind: 'public' }, rateLimit: rateLimits.publicShare },
      schema: {
        tags: ['sharing'],
        summary: 'Read the public projection for a valid share link',
        params: shareTokenParamsSchema,
        response: { 200: publicShareSchema, ...problems(404, 413, 429, 500) },
      },
    },
    async (req) => deps.shares.view(req.params.token),
  );

  app.get(
    '/v1/workspaces/:wid/decisions',
    {
      config: { access: trackerAccess },
      schema: {
        tags: ['review'],
        summary: 'List workspace decisions from current documents',
        params: workspaceParamsSchema,
        querystring: trackedDecisionQuerySchema,
        response: { 200: trackedDecisionPageSchema, ...errors },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return deps.tracker.decisions(workspaceActorOf(req), req.query);
    },
  );
  app.get(
    '/v1/workspaces/:wid/action-items',
    {
      config: { access: trackerAccess },
      schema: {
        tags: ['review'],
        summary: 'List workspace action items from current documents',
        params: workspaceParamsSchema,
        querystring: trackedActionQuerySchema,
        response: { 200: trackedActionPageSchema, ...errors },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return deps.tracker.actions(workspaceActorOf(req), req.query);
    },
  );
  app.post(
    '/v1/meetings/:id/decisions/bulk-review',
    {
      config: { access: { ...meeting, action: 'meeting.update', flag: 'review.enabled' } },
      schema: {
        tags: ['review'],
        summary: 'Confirm or reject selected proposed decisions atomically',
        params: meetingParamsSchema,
        body: bulkDecisionSchema,
        response: { 204: empty, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await deps.documents.bulkReview(
        workspaceActorOf(req),
        req.params.id,
        req.body.ids,
        req.body.status,
        originOf(req),
      );
      return reply.status(204).send(null);
    },
  );
  done();
};
