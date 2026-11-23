import {
  addActionItemSchema,
  addDecisionSchema,
  documentItemMutationSchema,
  documentItemParamsSchema,
  meetingDocumentQuerySchema,
  meetingDocumentResponseSchema,
  meetingParamsSchema,
  patchActionItemSchema,
  patchDecisionSchema,
} from '@meeting-hub/contracts';
import { z } from 'zod';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { originOf } from '../caller';
import { problems, WORKSPACE_ERRORS } from './problems';

const scope = { kind: 'workspace', workspaceFrom: 'meeting', flag: 'analysis.enabled' } as const;
const edit = { access: { ...scope, action: 'meeting.update' } } as const;
const tags = ['analysis'];
const errors = problems(409, ...WORKSPACE_ERRORS);

export const analysisRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  const service = deps.documents;
  app.get(
    '/v1/meetings/:id/document',
    {
      config: { access: { ...scope, action: 'meeting.read' } },
      schema: {
        tags,
        summary: 'Get the current meeting document or a retained revision',
        params: meetingParamsSchema,
        querystring: meetingDocumentQuerySchema,
        response: { 200: meetingDocumentResponseSchema, ...errors },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return service.read(workspaceActorOf(req), req.params.id, req.query.documentId);
    },
  );
  app.post(
    '/v1/meetings/:id/decisions',
    {
      config: edit,
      schema: {
        tags,
        summary: 'Add a cited decision',
        params: meetingParamsSchema,
        body: addDecisionSchema,
        response: { 201: documentItemMutationSchema, ...errors },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.mutate(
            workspaceActorOf(req),
            req.params.id,
            { kind: 'decision', operation: 'add', data: req.body },
            originOf(req),
          ),
        ),
  );
  app.patch(
    '/v1/meetings/:id/decisions/:itemId',
    {
      config: edit,
      schema: {
        tags,
        summary: 'Edit a decision or change its status',
        params: documentItemParamsSchema,
        body: patchDecisionSchema,
        response: { 200: documentItemMutationSchema, ...errors },
      },
    },
    async (req) =>
      service.mutate(
        workspaceActorOf(req),
        req.params.id,
        { kind: 'decision', operation: 'update', id: req.params.itemId, data: req.body },
        originOf(req),
      ),
  );
  app.post(
    '/v1/meetings/:id/action-items',
    {
      config: edit,
      schema: {
        tags,
        summary: 'Add a cited action item',
        params: meetingParamsSchema,
        body: addActionItemSchema,
        response: { 201: documentItemMutationSchema, ...errors },
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await service.mutate(
            workspaceActorOf(req),
            req.params.id,
            { kind: 'action_item', operation: 'add', data: req.body },
            originOf(req),
          ),
        ),
  );
  app.patch(
    '/v1/meetings/:id/action-items/:itemId',
    {
      config: edit,
      schema: {
        tags,
        summary: 'Edit an action item or change its status',
        params: documentItemParamsSchema,
        body: patchActionItemSchema,
        response: { 200: documentItemMutationSchema, ...errors },
      },
    },
    async (req) =>
      service.mutate(
        workspaceActorOf(req),
        req.params.id,
        { kind: 'action_item', operation: 'update', id: req.params.itemId, data: req.body },
        originOf(req),
      ),
  );
  for (const { path, kind } of [
    { path: '/v1/meetings/:id/decisions/:itemId', kind: 'decision' },
    { path: '/v1/meetings/:id/action-items/:itemId', kind: 'action_item' },
  ] as const) {
    app.delete(
      path,
      {
        config: edit,
        schema: {
          tags,
          summary: kind === 'decision' ? 'Delete a decision' : 'Delete an action item',
          params: documentItemParamsSchema,
          response: { 204: z.null().describe('No content'), ...errors },
        },
      },
      async (req, reply) => {
        await service.mutate(
          workspaceActorOf(req),
          req.params.id,
          { kind, operation: 'delete', id: req.params.itemId },
          originOf(req),
        );
        return reply.status(204).send(null);
      },
    );
  }
  done();
};
