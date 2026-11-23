import {
  meetingParamsSchema,
  patchTranscriptSpeakerSchema,
  transcriptPageSchema,
  transcriptQuerySchema,
  transcriptSearchSchema,
  transcriptSpeakerParamsSchema,
  transcriptSpeakerSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { originOf } from '../caller';
import { problems, WORKSPACE_ERRORS } from './problems';

const scope = {
  kind: 'workspace',
  workspaceFrom: 'meeting',
  flag: 'transcription.enabled',
} as const;

export const transcriptionRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  app.get(
    '/v1/meetings/:id/transcript',
    {
      config: { access: { ...scope, action: 'meeting.read' } },
      schema: {
        tags: ['transcription'],
        summary: 'Read the current transcript and its speakers',
        params: meetingParamsSchema,
        querystring: transcriptQuerySchema,
        response: { 200: transcriptPageSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return deps.transcription.read(workspaceActorOf(req), req.params.id, req.query);
    },
  );

  app.post(
    '/v1/meetings/:id/transcript/search',
    {
      config: { access: { ...scope, action: 'meeting.read' } },
      schema: {
        tags: ['transcription'],
        summary: 'Search segments without putting meeting text in the URL',
        params: meetingParamsSchema,
        body: transcriptSearchSchema,
        response: { 200: transcriptPageSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return deps.transcription.read(workspaceActorOf(req), req.params.id, req.body);
    },
  );

  app.patch(
    '/v1/meetings/:id/transcript/speakers/:speakerId',
    {
      config: { access: { ...scope, action: 'transcript.speaker.update' } },
      schema: {
        tags: ['transcription'],
        summary: 'Rename a transcript speaker or link a workspace person',
        params: transcriptSpeakerParamsSchema,
        body: patchTranscriptSpeakerSchema,
        response: { 200: transcriptSpeakerSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) =>
      deps.transcription.patchSpeaker(
        workspaceActorOf(req),
        req.params.id,
        req.params.speakerId,
        req.body,
        originOf(req),
      ),
  );
  done();
};
