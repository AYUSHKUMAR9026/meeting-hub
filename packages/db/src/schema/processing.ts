import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { user } from './auth';
import { createdAt, id, timestamptz, updatedAt } from './columns';
import { meetings, recordings } from './meetings';

/**
 * Lifecycle of a processing run (ADR 0004). Phase 4 uses queued, preparing_media and the terminal
 * statuses; the rest are reserved for later steps.
 */
export const runStatuses = [
  'queued',
  'preparing_media',
  'transcribing',
  'analyzing',
  'indexing',
  'completed',
  'partially_ready',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof runStatuses)[number];

/** A run in one of these statuses is still going; at most one per meeting. */
export const activeRunStatuses = [
  'queued',
  'preparing_media',
  'transcribing',
  'analyzing',
  'indexing',
] as const satisfies readonly RunStatus[];

export const runTriggers = ['upload', 'reprocess'] as const;
export type RunTrigger = (typeof runTriggers)[number];

export const stepStatuses = [
  'pending',
  'running',
  'waiting_external',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type StepStatus = (typeof stepStatuses)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One processing run of a meeting's recording. Postgres is the source of truth for run and step
 * state; BullMQ only delivers `{ runId, step }` (ADR 0004).
 */
export const processingRuns = pgTable(
  'processing_runs',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    recordingId: uuid('recording_id').notNull(),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    pipelineVersion: integer('pipeline_version').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    currentStep: text('current_step'),
    errorCode: text('error_code'),
    /** User-safe reason, copied from the failed step. */
    errorMessage: text('error_message'),
    requestedBy: uuid('requested_by').references(() => user.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target of processing_steps' composite foreign key.
    unique('processing_runs_id_workspace_id_key').on(t.id, t.workspaceId),
    foreignKey({
      name: 'processing_runs_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'processing_runs_recording_fk',
      columns: [t.recordingId, t.workspaceId],
      foreignColumns: [recordings.id, recordings.workspaceId],
    }).onDelete('cascade'),
    // At most one active run per meeting.
    uniqueIndex('processing_runs_one_active_per_meeting_key')
      .on(t.meetingId)
      .where(sql`${t.status} IN (${inList(activeRunStatuses)})`),
    // The same recording.uploaded event dispatched twice creates one run.
    uniqueIndex('processing_runs_upload_per_recording_key')
      .on(t.recordingId, t.trigger)
      .where(sql`${t.trigger} = 'upload'`),
    index('processing_runs_meeting_id_created_at_idx').on(t.meetingId, t.createdAt.desc()),
    // The sweeper scans active runs.
    index('processing_runs_active_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} IN (${inList(activeRunStatuses)})`),
    check('processing_runs_status_check', sql`${t.status} IN (${inList(runStatuses)})`),
    check('processing_runs_trigger_check', sql`${t.trigger} IN (${inList(runTriggers)})`),
    check('processing_runs_pipeline_version_check', sql`${t.pipelineVersion} > 0`),
  ],
);

/** One row per step of a run (not a jsonb array), so concurrent step updates never race. */
export const processingSteps = pgTable(
  'processing_steps',
  {
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    /** Order within the run's pipeline version (0-based). */
    position: integer('position').notNull(),
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    errorCode: text('error_code'),
    /** Safe to show to every member. */
    errorMessage: text('error_message'),
    /** Internal detail (owners/admins only). Never media content or signed URLs. */
    errorDetail: text('error_detail'),
    /** Id of work at an external provider (e.g. an STT job), for waiting_external steps. */
    externalRef: text('external_ref'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'processing_steps_pkey', columns: [t.runId, t.name] }),
    foreignKey({
      name: 'processing_steps_run_fk',
      columns: [t.runId, t.workspaceId],
      foreignColumns: [processingRuns.id, processingRuns.workspaceId],
    }).onDelete('cascade'),
    unique('processing_steps_run_id_position_key').on(t.runId, t.position),
    check('processing_steps_status_check', sql`${t.status} IN (${inList(stepStatuses)})`),
    check('processing_steps_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

export type ProcessingRunRow = typeof processingRuns.$inferSelect;
export type NewProcessingRun = typeof processingRuns.$inferInsert;
export type ProcessingStepRow = typeof processingSteps.$inferSelect;
export type NewProcessingStep = typeof processingSteps.$inferInsert;
