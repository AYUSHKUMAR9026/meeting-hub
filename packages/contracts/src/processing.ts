import { z } from 'zod';

import { meetingStatusSchema } from './meetings';

// --- processing runs (ADR 0004) -------------------------------------------------------------------

export const runStatusSchema = z
  .enum([
    'queued',
    'preparing_media',
    'transcribing',
    'analyzing',
    'indexing',
    'completed',
    'partially_ready',
    'failed',
    'cancelled',
  ])
  .meta({ id: 'RunStatus' });
export type RunStatus = z.infer<typeof runStatusSchema>;

export const stepStatusSchema = z
  .enum(['pending', 'running', 'waiting_external', 'succeeded', 'failed', 'skipped'])
  .meta({ id: 'StepStatus' });
export type StepStatus = z.infer<typeof stepStatusSchema>;

/** Steps of the current pipeline, in order. Later phases append to this list. */
export const STEP_NAMES = ['prepare_media'] as const;
export const stepNameSchema = z.enum(STEP_NAMES).meta({ id: 'StepName' });
export type StepName = z.infer<typeof stepNameSchema>;

const fraction = z.number().min(0).max(1);

export const processingStepSchema = z
  .object({
    name: z.string(),
    status: stepStatusSchema,
    attempts: z.int().min(0),
    progress: fraction.describe("This step's own progress, 0 to 1"),
    phase: z.string().nullable().describe('What the running step is doing, e.g. "transcoding"'),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable().describe('Safe to show to every member'),
    errorDetail: z
      .string()
      .nullable()
      .optional()
      .describe('Internal detail; present for owners and admins only'),
  })
  .meta({ id: 'ProcessingStep' });
export type ProcessingStep = z.infer<typeof processingStepSchema>;

export const processingRunSchema = z
  .object({
    id: z.uuid(),
    status: runStatusSchema,
    trigger: z.enum(['upload', 'reprocess']),
    pipelineVersion: z.int().min(1),
    currentStep: z.string().nullable(),
    progress: fraction.describe('Overall progress, 0 to 1'),
    errorCode: z.string().nullable(),
    errorMessage: z
      .string()
      .nullable()
      .describe('Why the run failed; safe to show to every member'),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    steps: z.array(processingStepSchema),
  })
  .meta({ id: 'ProcessingRun' });
export type ProcessingRun = z.infer<typeof processingRunSchema>;

export const meetingProcessingSchema = z
  .object({
    meetingId: z.uuid(),
    meetingStatus: meetingStatusSchema,
    run: processingRunSchema.nullable().describe("The meeting's most recent run, if any"),
  })
  .meta({ id: 'MeetingProcessing' });
export type MeetingProcessing = z.infer<typeof meetingProcessingSchema>;

export const reprocessRequestSchema = z
  .object({
    fromStep: stepNameSchema.optional().describe('Start here; earlier steps are skipped'),
  })
  .meta({ id: 'ReprocessRequest' });

export const meetingMediaSchema = z
  .object({
    audio: z.object({
      url: z.url().describe('Short-lived signed URL; plays inline'),
      contentType: z.string(),
      sizeBytes: z.int(),
      durationMs: z.int().nullable(),
      codec: z.string().nullable(),
      sampleRate: z.int().nullable(),
      channels: z.int().nullable(),
    }),
    peaks: z
      .object({ url: z.url() })
      .nullable()
      .describe('Waveform peaks JSON (audiowaveform layout)'),
    expiresAt: z.iso.datetime().describe('When the URLs stop working; fetch new ones before'),
  })
  .meta({ id: 'MeetingMedia' });
export type MeetingMedia = z.infer<typeof meetingMediaSchema>;

/** Name of the SSE event carrying a `MeetingProcessing` body. */
export const RUN_UPDATED_EVENT = 'run.updated';
