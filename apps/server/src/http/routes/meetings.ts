import {
  completeUploadRequestSchema,
  completeUploadResponseSchema,
  createMeetingRequestSchema,
  idempotencyHeadersSchema,
  meetingDeletionSchema,
  meetingListSchema,
  meetingParamsSchema,
  meetingSchema,
  meetingsQuerySchema,
  presignPartsRequestSchema,
  presignPartsResponseSchema,
  recordingDownloadSchema,
  startUploadRequestSchema,
  startUploadResponseSchema,
  updateMeetingRequestSchema,
  uploadParamsSchema,
  workspaceParamsSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import type { Meeting, Recording, UploadSession } from '../../modules/meetings';
import { iso, originOf } from '../caller';
import { rateLimits } from '../rate-limit';
import { problems, WORKSPACE_ERRORS } from './problems';

const toRecording = (r: Recording) => ({
  id: r.id,
  kind: r.kind,
  fileName: r.originalFilename,
  contentType: r.contentType,
  sizeBytes: r.sizeBytes,
  durationMs: r.durationMs,
  status: r.status,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const toMeeting = (m: Meeting) => ({
  id: m.id,
  workspaceId: m.workspaceId,
  title: m.title,
  occurredAt: iso(m.occurredAt),
  durationMs: m.durationMs,
  language: m.language,
  status: m.status,
  source: m.source,
  createdBy: m.createdBy,
  participants: m.participants,
  recording: m.recording ? toRecording(m.recording) : null,
  createdAt: iso(m.createdAt),
  updatedAt: iso(m.updatedAt),
});

const toSession = (s: UploadSession) => ({ ...s, urlsExpireAt: iso(s.urlsExpireAt) });

const optionalDate = (value: string | undefined) => (value ? new Date(value) : undefined);

const UPLOAD_FLAG = 'meetings.upload' as const;
/** Routes under /v1/meetings/{id}: the workspace comes from the meeting (404 if not visible). */
const onMeeting = 'meeting' as const;

export const meetingRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  const { meetings, uploads } = deps;

  // --- meetings -----------------------------------------------------------------------------------

  app.post(
    '/v1/workspaces/:wid/meetings',
    {
      config: { access: { kind: 'workspace', action: 'meeting.create' } },
      schema: {
        tags: ['meetings'],
        summary: 'Create a meeting (upload its recording afterwards)',
        params: workspaceParamsSchema,
        body: createMeetingRequestSchema,
        response: { 201: meetingSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      const meeting = await meetings.create(
        workspaceActorOf(req),
        { ...req.body, occurredAt: new Date(req.body.occurredAt) },
        originOf(req),
      );
      return reply.status(201).send(toMeeting(meeting));
    },
  );

  app.get(
    '/v1/workspaces/:wid/meetings',
    {
      config: { access: { kind: 'workspace', action: 'meeting.read' } },
      schema: {
        tags: ['meetings'],
        summary: 'Meetings, newest first (cursor-paginated)',
        params: workspaceParamsSchema,
        querystring: meetingsQuerySchema,
        response: { 200: meetingListSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => {
      const page = await meetings.list(workspaceActorOf(req), {
        cursor: req.query.cursor,
        limit: req.query.limit,
        status: req.query.status,
        from: optionalDate(req.query.from),
        to: optionalDate(req.query.to),
      });
      return { meetings: page.meetings.map(toMeeting), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/v1/meetings/:id',
    {
      config: { access: { kind: 'workspace', action: 'meeting.read', workspaceFrom: onMeeting } },
      schema: {
        tags: ['meetings'],
        summary: 'A meeting with its participants and recording',
        params: meetingParamsSchema,
        response: { 200: meetingSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => toMeeting(await meetings.get(workspaceActorOf(req), req.params.id)),
  );

  app.patch(
    '/v1/meetings/:id',
    {
      config: {
        access: { kind: 'workspace', action: 'meeting.update', workspaceFrom: onMeeting },
      },
      schema: {
        tags: ['meetings'],
        summary: 'Edit the title, time or participants (members: only meetings they created)',
        params: meetingParamsSchema,
        body: updateMeetingRequestSchema,
        response: { 200: meetingSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) =>
      toMeeting(
        await meetings.update(
          workspaceActorOf(req),
          req.params.id,
          { ...req.body, occurredAt: optionalDate(req.body.occurredAt) },
          originOf(req),
        ),
      ),
  );

  app.delete(
    '/v1/meetings/:id',
    {
      config: {
        access: { kind: 'workspace', action: 'meeting.delete', workspaceFrom: onMeeting },
      },
      schema: {
        tags: ['meetings'],
        summary: 'Delete a meeting: hidden at once, recordings and data purged in the background',
        params: meetingParamsSchema,
        response: { 202: meetingDeletionSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await meetings.delete(workspaceActorOf(req), req.params.id, originOf(req));
      return reply.status(202).send({ id: req.params.id, status: 'deletion_scheduled' as const });
    },
  );

  // --- uploads ------------------------------------------------------------------------------------

  app.post(
    '/v1/meetings/:id/uploads',
    {
      config: {
        access: {
          kind: 'workspace',
          action: 'recording.upload',
          workspaceFrom: onMeeting,
          flag: UPLOAD_FLAG,
        },
        rateLimit: rateLimits.uploadStart,
      },
      schema: {
        tags: ['uploads'],
        summary: 'Start a multipart upload of the meeting recording; returns the first part URLs',
        description:
          'The browser PUTs each part to its presigned URL and keeps the ETag response header. ' +
          'Retrying with the same Idempotency-Key returns the same upload with fresh URLs.',
        params: meetingParamsSchema,
        headers: idempotencyHeadersSchema,
        body: startUploadRequestSchema,
        response: {
          201: startUploadResponseSchema,
          ...problems(409, 413, 415, 422, ...WORKSPACE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const session = await uploads.start(
        workspaceActorOf(req),
        req.params.id,
        req.body,
        req.headers['idempotency-key'],
        originOf(req),
      );
      return reply.status(201).send(toSession(session));
    },
  );

  app.post(
    '/v1/meetings/:id/uploads/:uploadId/parts',
    {
      config: {
        access: {
          kind: 'workspace',
          action: 'recording.upload',
          workspaceFrom: onMeeting,
          flag: UPLOAD_FLAG,
        },
      },
      schema: {
        tags: ['uploads'],
        summary: 'Fresh presigned URLs for more parts',
        params: uploadParamsSchema,
        body: presignPartsRequestSchema,
        response: { 200: presignPartsResponseSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req) => {
      const result = await uploads.presignParts(
        workspaceActorOf(req),
        req.params.id,
        req.params.uploadId,
        req.body.partNumbers,
      );
      return { urlsExpireAt: iso(result.urlsExpireAt), parts: result.parts };
    },
  );

  app.post(
    '/v1/meetings/:id/uploads/:uploadId/complete',
    {
      config: {
        access: {
          kind: 'workspace',
          action: 'recording.upload',
          workspaceFrom: onMeeting,
          flag: UPLOAD_FLAG,
        },
      },
      schema: {
        tags: ['uploads'],
        summary: 'Complete the upload; the meeting becomes `uploaded` (idempotent)',
        params: uploadParamsSchema,
        body: completeUploadRequestSchema,
        response: {
          202: completeUploadResponseSchema,
          ...problems(409, 422, ...WORKSPACE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const result = await uploads.complete(
        workspaceActorOf(req),
        req.params.id,
        req.params.uploadId,
        req.body.parts,
        originOf(req),
      );
      return reply.status(202).send(result);
    },
  );

  app.delete(
    '/v1/meetings/:id/uploads/:uploadId',
    {
      config: {
        access: {
          kind: 'workspace',
          action: 'recording.upload',
          workspaceFrom: onMeeting,
          flag: UPLOAD_FLAG,
        },
      },
      schema: {
        tags: ['uploads'],
        summary: 'Cancel an upload in progress',
        params: uploadParamsSchema,
        response: {
          204: z.null().describe('No content'),
          ...problems(409, ...WORKSPACE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      await uploads.abort(workspaceActorOf(req), req.params.id, req.params.uploadId, originOf(req));
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/meetings/:id/recording',
    {
      config: {
        access: { kind: 'workspace', action: 'recording.download', workspaceFrom: onMeeting },
      },
      schema: {
        tags: ['uploads'],
        summary: 'The original recording with a short-lived download URL (owners and admins)',
        params: meetingParamsSchema,
        response: { 200: recordingDownloadSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => {
      const result = await uploads.download(workspaceActorOf(req), req.params.id, originOf(req));
      return {
        recording: toRecording(result.recording),
        downloadUrl: result.downloadUrl,
        downloadUrlExpiresAt: iso(result.downloadUrlExpiresAt),
      };
    },
  );

  done();
};
