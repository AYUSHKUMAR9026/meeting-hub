import {
  meetingMediaSchema,
  meetingParamsSchema,
  meetingProcessingSchema,
  type MeetingProcessing,
  reprocessRequestSchema,
  RUN_UPDATED_EVENT,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ApiDeps } from '../../deps';
import { isAppError } from '../../lib/errors';
import { workspaceActorOf } from '../../modules/auth';
import type { ProcessingView, RunView } from '../../modules/processing';
import { iso, originOf } from '../caller';
import { problems, WORKSPACE_ERRORS } from './problems';

const isoOrNull = (d: Date | null) => (d ? iso(d) : null);

const toRun = (run: RunView) => ({
  ...run,
  createdAt: iso(run.createdAt),
  startedAt: isoOrNull(run.startedAt),
  finishedAt: isoOrNull(run.finishedAt),
  steps: run.steps.map((s) => ({
    ...s,
    startedAt: isoOrNull(s.startedAt),
    finishedAt: isoOrNull(s.finishedAt),
  })),
});

export const toProcessing = (meetingId: string, view: ProcessingView): MeetingProcessing => ({
  meetingId,
  meetingStatus: view.meetingStatus,
  run: view.run ? toRun(view.run) : null,
});

/** SSE streams end after this long; the browser reconnects and access is checked again. */
export const SSE_MAX_STREAM_MS = 15 * 60_000;

const PIPELINE_FLAG = 'pipeline.media' as const;
const onMeeting = 'meeting' as const;

export const processingRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  const { runs } = deps.processing;

  app.get(
    '/v1/meetings/:id/processing',
    {
      config: { access: { kind: 'workspace', action: 'meeting.read', workspaceFrom: onMeeting } },
      schema: {
        tags: ['processing'],
        summary: "The meeting's current processing run, its steps and progress",
        description: '`errorDetail` on steps is included for owners and admins only.',
        params: meetingParamsSchema,
        response: { 200: meetingProcessingSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) =>
      toProcessing(req.params.id, await runs.getProcessing(workspaceActorOf(req), req.params.id)),
  );

  app.get(
    '/v1/meetings/:id/events',
    {
      config: { access: { kind: 'workspace', action: 'meeting.read', workspaceFrom: onMeeting } },
      schema: {
        tags: ['processing'],
        summary: 'Live processing updates (Server-Sent Events)',
        description:
          `A \`text/event-stream\`. Each \`${RUN_UPDATED_EVENT}\` event carries a MeetingProcessing ` +
          'JSON body; the first is sent on connect. A `: heartbeat` comment goes out every 15 s and ' +
          'the stream closes after 15 minutes (EventSource reconnects).',
        params: meetingParamsSchema,
        response: {
          200: {
            description: 'Event stream',
            content: { 'text/event-stream': { schema: z.string() } },
          },
          ...problems(...WORKSPACE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const actor = workspaceActorOf(req);
      const meetingId = req.params.id;
      // Loading before hijacking means a meeting that vanished still gets a problem+json 404.
      const first = await runs.getProcessing(actor, meetingId);

      reply.hijack();
      const res = reply.raw;
      // Headers set by hooks (request id, CORS) aren't sent for a hijacked reply unless copied.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) res.setHeader(name, value);
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tells nginx-style proxies not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      const send = (view: ProcessingView) =>
        res.write(
          `event: ${RUN_UPDATED_EVENT}\ndata: ${JSON.stringify(toProcessing(meetingId, view))}\n\n`,
        );
      res.write('retry: 3000\n\n');
      send(first);

      let closed = false;
      let queued = false;
      let chain: Promise<void> = Promise.resolve();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        void unsubscribe.then((off) => off());
        if (!res.writableEnded) res.end();
      };
      // Coalesce bursts: at most one reload in flight plus one queued.
      const onChange = () => {
        if (closed || queued) return;
        queued = true;
        chain = chain.then(async () => {
          queued = false;
          if (closed) return;
          try {
            send(await runs.getProcessing(actor, meetingId));
          } catch (err) {
            if (isAppError(err) && err.status === 404) {
              res.write('event: meeting.gone\ndata: {}\n\n');
              close();
            } else {
              req.log.warn({ err }, 'could not load processing for the event stream');
            }
          }
        });
      };
      const heartbeat = setInterval(
        () => res.write(': heartbeat\n\n'),
        deps.config.SSE_HEARTBEAT_MS,
      );
      const lifetime = setTimeout(close, SSE_MAX_STREAM_MS);
      const unsubscribe = deps.processingEvents.subscribe(meetingId, onChange);
      req.raw.on('close', close);
      res.on('error', close);
      await unsubscribe.catch((err: unknown) => {
        req.log.warn({ err }, 'could not subscribe to processing events');
        close();
      });
    },
  );

  app.post(
    '/v1/meetings/:id/runs',
    {
      config: {
        access: {
          kind: 'workspace',
          action: 'processing.reprocess',
          workspaceFrom: onMeeting,
          flag: PIPELINE_FLAG,
        },
      },
      schema: {
        tags: ['processing'],
        summary: 'Reprocess the recording: start a new run (owners and admins)',
        description: '409 `RUN_ALREADY_ACTIVE` while a run is in progress.',
        params: meetingParamsSchema,
        body: reprocessRequestSchema,
        response: { 202: meetingProcessingSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      const view = await runs.requestReprocess(
        workspaceActorOf(req),
        req.params.id,
        req.body.fromStep,
        originOf(req),
      );
      return reply.status(202).send(toProcessing(req.params.id, view));
    },
  );

  app.get(
    '/v1/meetings/:id/media',
    {
      config: { access: { kind: 'workspace', action: 'meeting.read', workspaceFrom: onMeeting } },
      schema: {
        tags: ['processing'],
        summary: 'Short-lived signed URLs for the normalized audio and its waveform peaks',
        params: meetingParamsSchema,
        response: { 200: meetingMediaSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => {
      const media = await runs.getMedia(workspaceActorOf(req), req.params.id);
      return { ...media, expiresAt: iso(media.expiresAt) };
    },
  );

  done();
};
