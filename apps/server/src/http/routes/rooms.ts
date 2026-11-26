import { z } from 'zod';
import {
  meetingParamsSchema,
  roomMessageRequestSchema,
  roomMessageListSchema,
  roomStartSchema,
  roomJoinSchema,
  roomTokenSchema,
  roomViewSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { workspaceActorOf } from '../../modules/auth';
import type { ApiDeps } from '../../deps';
import { problems, WORKSPACE_ERRORS } from './problems';

export const roomRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  app.addHook('onSend', (_req, reply, payload, sent) => {
    reply.header('Cache-Control', 'no-store');
    sent(null, payload);
  });
  const config = {
    access: {
      kind: 'workspace',
      action: 'meeting.read',
      workspaceFrom: 'meeting',
      flag: 'rooms.enabled',
    },
  } as const;
  const schema = {
    params: meetingParamsSchema,
    response: { 200: roomViewSchema, ...problems(...WORKSPACE_ERRORS, 409) },
  };
  app.get('/v1/meetings/:id/room', { config, schema }, (req) =>
    deps.rooms.view(workspaceActorOf(req), req.params.id),
  );
  app.post(
    '/v1/meetings/:id/room/start',
    { config, schema: { ...schema, body: roomStartSchema } },
    (req) => deps.rooms.start(workspaceActorOf(req), req.params.id, req.body.recordingEnabled),
  );
  app.post(
    '/v1/meetings/:id/room/join',
    {
      config,
      schema: {
        ...schema,
        body: roomJoinSchema,
        response: { 200: roomTokenSchema, ...problems(...WORKSPACE_ERRORS, 409) },
      },
    },
    (req) => deps.rooms.join(workspaceActorOf(req), req.params.id, req.body.consentAcknowledged),
  );
  app.post('/v1/meetings/:id/room/end', { config, schema }, (req) =>
    deps.rooms.end(workspaceActorOf(req), req.params.id),
  );
  app.get(
    '/v1/meetings/:id/room/chat',
    {
      config,
      schema: {
        params: meetingParamsSchema,
        response: { 200: roomMessageListSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    (req) => deps.rooms.messages(workspaceActorOf(req), req.params.id),
  );
  app.post(
    '/v1/meetings/:id/room/chat',
    {
      config,
      schema: {
        params: meetingParamsSchema,
        body: roomMessageRequestSchema,
        response: { 204: z.null(), ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await deps.rooms.saveMessage(workspaceActorOf(req), req.params.id, req.body);
      return reply.code(204).send(null);
    },
  );
  app.register((webhook, _options, registered) => {
    webhook.addContentTypeParser(
      'application/webhook+json',
      { parseAs: 'string' },
      (_req, body, cb) => cb(null, body),
    );
    webhook.post(
      '/v1/rooms/webhook',
      { config: { access: { kind: 'public' } }, logLevel: 'silent' },
      async (req, reply) => {
        await deps.rooms.webhook(
          typeof req.body === 'string' ? req.body : '',
          req.headers.authorization ?? '',
          (workspaceId) => deps.flags.isEnabled('rooms.enabled', { workspaceId }),
        );
        return reply.status(204).send();
      },
    );
    registered();
  });
  done();
};
