import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';

import { createdAt, id } from './columns';
import { meetings } from './meetings';
import { processingRuns } from './processing';
import { people } from './workspaces';
import { user } from './auth';

export const transcripts = pgTable(
  'transcripts',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    processingRunId: uuid('processing_run_id').notNull(),
    language: text('language'),
    provider: text('provider').notNull(),
    providerJobId: text('provider_job_id').notNull(),
    speakerSource: text('speaker_source')
      .$type<'generic' | 'attendance'>()
      .notNull()
      .default('generic'),
    fallbackReason: text('fallback_reason'),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').$type<'pending' | 'completed' | 'failed'>().notNull().default('pending'),
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('transcripts_id_workspace_key').on(t.id, t.workspaceId),
    unique('transcripts_meeting_scope_key').on(t.id, t.meetingId, t.workspaceId),
    unique('transcripts_run_key').on(t.processingRunId),
    uniqueIndex('transcripts_current_key')
      .on(t.meetingId)
      .where(sql`${t.isCurrent}`),
    index('transcripts_meeting_idx').on(t.meetingId, t.workspaceId),
    foreignKey({
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
      name: 'transcripts_meeting_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.processingRunId, t.meetingId, t.workspaceId],
      foreignColumns: [processingRuns.id, processingRuns.meetingId, processingRuns.workspaceId],
      name: 'transcripts_run_fk',
    }).onDelete('cascade'),
    check(
      'transcripts_status_check',
      sql`${t.status} IN ('pending', 'completed', 'failed') AND (NOT ${t.isCurrent} OR ${t.status} = 'completed')`,
    ),
    check('transcripts_duration_check', sql`${t.durationMs} > 0`),
  ],
);

export const transcriptSpeakers = pgTable(
  'transcript_speakers',
  {
    id: id(),
    transcriptId: uuid('transcript_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    label: text('label').notNull(),
    personId: uuid('person_id'),
    displayName: text('display_name'),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('transcript_speakers_transcript_label_key').on(t.transcriptId, t.label),
    unique('transcript_speakers_scope_key').on(t.id, t.transcriptId, t.workspaceId),
    foreignKey({
      columns: [t.transcriptId, t.workspaceId],
      foreignColumns: [transcripts.id, transcripts.workspaceId],
      name: 'transcript_speakers_transcript_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.personId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
      name: 'transcript_speakers_person_fk',
    }).onDelete('set null'),
    index('transcript_speakers_person_idx').on(t.personId, t.workspaceId),
  ],
);

/** Durable provider results: content never enters queue payloads or log metadata. */
export const transcriptionCheckpoints = pgTable(
  'transcription_checkpoints',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    runId: uuid('run_id').notNull(),
    key: text('key').notNull(),
    content: jsonb('content').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('transcription_checkpoints_run_key').on(t.runId, t.key),
    foreignKey({
      name: 'transcription_checkpoint_run_fk',
      columns: [t.runId, t.meetingId, t.workspaceId],
      foreignColumns: [processingRuns.id, processingRuns.meetingId, processingRuns.workspaceId],
    }).onDelete('cascade'),
  ],
);

export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: id(),
    transcriptId: uuid('transcript_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    idx: integer('idx').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    speakerId: uuid('speaker_id').notNull(),
    text: text('text').notNull(),
    confidence: real('confidence'),
  },
  (t) => [
    unique('transcript_segments_scope_key').on(t.id, t.transcriptId, t.workspaceId),
    unique('transcript_segments_order_key').on(t.transcriptId, t.idx),
    index('transcript_segments_text_trgm_idx').using('gin', t.text.op('gin_trgm_ops')),
    foreignKey({
      columns: [t.transcriptId, t.workspaceId],
      foreignColumns: [transcripts.id, transcripts.workspaceId],
      name: 'transcript_segments_transcript_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.speakerId, t.transcriptId, t.workspaceId],
      foreignColumns: [
        transcriptSpeakers.id,
        transcriptSpeakers.transcriptId,
        transcriptSpeakers.workspaceId,
      ],
      name: 'transcript_segments_speaker_fk',
    }).onDelete('cascade'),
    check(
      'transcript_segments_range_check',
      sql`${t.idx} >= 0 AND ${t.startMs} >= 0 AND ${t.endMs} > ${t.startMs} AND (${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1)`,
    ),
  ],
);
