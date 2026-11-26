import {
  workspaceParamsSchema,
  contentPurgeRequestSchema,
  contentPurgeResponseSchema,
  meetingParamsSchema,
  savedResultSchema,
  pdfQuerySchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { problems, WORKSPACE_ERRORS } from './problems';

export const resultRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const access = { kind: 'workspace', workspaceFrom: 'meeting', action: 'meeting.read' } as const;
  app.get(
    '/v1/meetings/:id/result',
    {
      config: { access },
      schema: {
        tags: ['results'],
        params: meetingParamsSchema,
        response: { 200: savedResultSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    (req) => deps.results.view(workspaceActorOf(req), req.params.id),
  );
  app.get(
    '/v1/meetings/:id/pdf',
    {
      config: { access },
      exposeHeadRoute: false,
      schema: {
        tags: ['results'],
        params: meetingParamsSchema,
        querystring: pdfQuerySchema,
        response: {
          200: {
            content: {
              'application/pdf': { schema: z.any().meta({ type: 'string', format: 'binary' }) },
            },
          },
          ...problems(...WORKSPACE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const { file, stream } = await deps.results.open(
        workspaceActorOf(req),
        req.params.id,
        req.query.fileId,
      );
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="meeting-decisions.pdf"`,
        )
        .header('Content-Length', file.size)
        .type('application/pdf')
        .send(stream);
    },
  );
  app.post(
    '/v1/meetings/:id/pdf/retry',
    {
      config: { access: { ...access, action: 'processing.reprocess' } },
      schema: {
        tags: ['results'],
        params: meetingParamsSchema,
        response: { 204: z.null(), ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await deps.results.retry(workspaceActorOf(req), req.params.id);
      return reply.code(204).send(null);
    },
  );
  app.post(
    '/v1/workspaces/:wid/content/purge',
    {
      config: { access: { kind: 'workspace', action: 'workspace.purge_content' } },
      schema: {
        tags: ['results'],
        params: workspaceParamsSchema,
        body: contentPurgeRequestSchema,
        response: { 200: contentPurgeResponseSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    (req) => deps.results.purge(workspaceActorOf(req), req.body),
  );
  done();
};
