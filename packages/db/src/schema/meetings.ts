import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organization, user } from './auth';
import { createdAt, id, timestamptz, updatedAt } from './columns';
import { people } from './workspaces';

/** Lifecycle of a meeting. Phase 3 uses the first three; the rest belong to processing (Phase 4). */
export const meetingStatuses = [
  'awaiting_upload',
  'uploading',
  'uploaded',
  'processing',
  'ready',
  'partially_ready',
  'failed',
] as const;
export type MeetingStatus = (typeof meetingStatuses)[number];

export const recordingKinds = ['original', 'normalized'] as const;
export type RecordingKind = (typeof recordingKinds)[number];

export const recordingStatuses = ['pending', 'uploading', 'uploaded', 'failed', 'deleted'] as const;
export type RecordingStatus = (typeof recordingStatuses)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * A meeting in a workspace. Soft-deleted rows (`deleted_at` set) are invisible to every query and
 * purged by the `meeting.delete` job (ADR 0003).
 */
export const meetings = pgTable(
  'meetings',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    durationMs: integer('duration_ms'),
    language: text('language'),
    status: text('status').$type<MeetingStatus>().notNull().default('awaiting_upload'),
    source: text('source').notNull().default('upload'),
    externalId: text('external_id'),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target of the composite foreign keys that keep participants/recordings in the same workspace.
    unique('meetings_id_workspace_id_key').on(t.id, t.workspaceId),
    uniqueIndex('meetings_workspace_id_source_external_id_key')
      .on(t.workspaceId, t.source, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('meetings_workspace_id_occurred_at_idx')
      .on(t.workspaceId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('meetings_deleted_at_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    check('meetings_status_check', sql`${t.status} IN (${inList(meetingStatuses)})`),
    check('meetings_duration_ms_check', sql`${t.durationMs} IS NULL OR ${t.durationMs} >= 0`),
  ],
);

/**
 * People who took part in a meeting. `workspace_id` is redundant on purpose: the composite foreign
 * keys make Postgres guarantee that the meeting and the person belong to the same workspace.
 */
export const meetingParticipants = pgTable(
  'meeting_participants',
  {
    meetingId: uuid('meeting_id').notNull(),
    personId: uuid('person_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'meeting_participants_pkey', columns: [t.meetingId, t.personId] }),
    foreignKey({
      name: 'meeting_participants_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meeting_participants_person_fk',
      columns: [t.personId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
    }).onDelete('cascade'),
    index('meeting_participants_person_id_idx').on(t.personId),
  ],
);

/**
 * A media file of a meeting in object storage. `storage_key` never contains user input; the
 * original file name lives only in `original_filename` (ADR 0003).
 */
export const recordings = pgTable(
  'recordings',
  {
    id: id(),
    meetingId: uuid('meeting_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').$type<RecordingKind>().notNull().default('original'),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    durationMs: integer('duration_ms'),
    status: text('status').$type<RecordingStatus>().notNull().default('pending'),
    s3UploadId: text('s3_upload_id'),
    partSize: integer('part_size'),
    consentConfirmedBy: uuid('consent_confirmed_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    consentConfirmedAt: timestamptz('consent_confirmed_at'),
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'recordings_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    uniqueIndex('recordings_meeting_id_kind_key').on(t.meetingId, t.kind),
    uniqueIndex('recordings_workspace_id_idempotency_key_key')
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    uniqueIndex('recordings_storage_key_key').on(t.storageKey),
    // The stale-upload sweep looks for old in-flight uploads.
    index('recordings_uploading_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'uploading'`),
    check('recordings_kind_check', sql`${t.kind} IN (${inList(recordingKinds)})`),
    check('recordings_status_check', sql`${t.status} IN (${inList(recordingStatuses)})`),
    check('recordings_size_bytes_check', sql`${t.sizeBytes} > 0`),
  ],
);

export type MeetingRow = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type MeetingParticipantRow = typeof meetingParticipants.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;
