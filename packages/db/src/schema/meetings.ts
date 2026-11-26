import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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

import { invitation, organization, user } from './auth';
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

export const recordingKinds = [
  'original',
  'normalized',
  'mixed_audio',
  'participant_track',
] as const;
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
    resultPolicy: text('result_policy')
      .$type<'legacy' | 'temporary'>()
      .notNull()
      .default('temporary'),
    pdfState: text('pdf_state')
      .$type<'pending' | 'ready' | 'failed'>()
      .notNull()
      .default('pending'),
    pdfDirtyAt: timestamptz('pdf_dirty_at'),
    transcriptPurgedAt: timestamptz('transcript_purged_at'),
    title: text('title').notNull(),
    occurredAt: timestamptz('occurred_at').notNull(),
    durationMs: integer('duration_ms'),
    language: text('language'),
    status: text('status').$type<MeetingStatus>().notNull().default('awaiting_upload'),
    source: text('source').notNull().default('upload'),
    externalId: text('external_id'),
    roomStatus: text('room_status')
      .$type<'none' | 'scheduled' | 'live' | 'ended'>()
      .notNull()
      .default('none'),
    roomName: text('room_name').unique(),
    roomStartedAt: timestamptz('room_started_at'),
    roomEndedAt: timestamptz('room_ended_at'),
    recordingEnabled: boolean('recording_enabled').notNull().default(true),
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
    check(
      'meetings_room_status_check',
      sql`${t.roomStatus} IN ('none','scheduled','live','ended')`,
    ),
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
export const roomSessions = pgTable(
  'room_sessions',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    startedBy: uuid('started_by').references(() => user.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    endedAt: timestamptz('ended_at'),
    endReason: text('end_reason').$type<
      'host_ended' | 'empty_timeout' | 'max_duration' | 'error'
    >(),
  },
  (t) => [
    foreignKey({
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    unique().on(t.id, t.meetingId, t.workspaceId),
    uniqueIndex('room_sessions_one_active')
      .on(t.meetingId)
      .where(sql`${t.endedAt} IS NULL`),
    index('room_sessions_active_workspace')
      .on(t.workspaceId)
      .where(sql`${t.endedAt} IS NULL`),
    check(
      'room_sessions_end_check',
      sql`(${t.endedAt} IS NULL) = (${t.endReason} IS NULL) AND ${t.endReason} IN ('host_ended','empty_timeout','max_duration','error')`,
    ),
  ],
);

export const roomAttendance = pgTable(
  'room_attendance',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    personId: uuid('person_id'),
    joinedAt: timestamptz('joined_at'),
    leftAt: timestamptz('left_at'),
    consentAcknowledgedAt: timestamptz('consent_acknowledged_at'),
  },
  (t) => [
    foreignKey({
      name: 'attendance_session_fk',
      columns: [t.sessionId, t.meetingId, t.workspaceId],
      foreignColumns: [roomSessions.id, roomSessions.meetingId, roomSessions.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'attendance_person_fk',
      // Migration 0007 nulls only person_id on deletion, preserving the workspace scope.
      columns: [t.personId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
    }),
    unique().on(t.id, t.meetingId, t.workspaceId),
    uniqueIndex('attendance_active_user')
      .on(t.sessionId, t.userId)
      .where(sql`${t.leftAt} IS NULL`),
  ],
);

export const roomExports = pgTable(
  'room_exports',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    attendanceId: uuid('attendance_id'),
    sourceId: text('source_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    egressId: text('egress_id').unique(),
    state: text('state')
      .$type<'pending' | 'active' | 'done' | 'failed'>()
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'room_export_session_fk',
      columns: [t.sessionId, t.meetingId, t.workspaceId],
      foreignColumns: [roomSessions.id, roomSessions.meetingId, roomSessions.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'room_export_attendance_fk',
      columns: [t.attendanceId, t.meetingId, t.workspaceId],
      foreignColumns: [roomAttendance.id, roomAttendance.meetingId, roomAttendance.workspaceId],
    }).onDelete('cascade'),
    unique().on(t.sessionId, t.sourceId),
  ],
);
export const roomWebhookReceipts = pgTable(
  'room_webhook_receipts',
  {
    id: id(),
    sessionId: uuid('session_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    eventId: text('event_id').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'room_webhook_session_fk',
      columns: [t.sessionId, t.meetingId, t.workspaceId],
      foreignColumns: [roomSessions.id, roomSessions.meetingId, roomSessions.workspaceId],
    }).onDelete('cascade'),
  ],
);

export const recordings = pgTable(
  'recordings',
  {
    id: id(),
    meetingId: uuid('meeting_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').$type<RecordingKind>().notNull().default('original'),
    storageKey: text('storage_key').notNull(),
    purgedAt: timestamptz('purged_at'),
    purgeReason: text('purge_reason'),
    originalFilename: text('original_filename').notNull(),
    attendanceId: uuid('attendance_id'),
    startOffsetMs: integer('start_offset_ms'),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    durationMs: integer('duration_ms'),
    // Filled in by prepare_media (ADR 0004): the audio stream's properties as probed.
    codec: text('codec'),
    sampleRate: integer('sample_rate'),
    channels: integer('channels'),
    /** Waveform peaks JSON for this audio (normalized recordings only). */
    peaksStorageKey: text('peaks_storage_key'),
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
    // Target of processing_runs' composite foreign key (same-workspace guarantee).
    unique('recordings_id_workspace_id_key').on(t.id, t.workspaceId),
    foreignKey({
      name: 'recordings_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'recording_attendance_fk',
      columns: [t.attendanceId, t.meetingId, t.workspaceId],
      foreignColumns: [roomAttendance.id, roomAttendance.meetingId, roomAttendance.workspaceId],
    }).onDelete('cascade'),
    check(
      'recordings_track_check',
      sql`CASE WHEN ${t.kind} = 'participant_track' THEN ${t.attendanceId} IS NOT NULL AND ${t.startOffsetMs} IS NOT NULL AND ${t.startOffsetMs} >= 0 ELSE ${t.attendanceId} IS NULL AND ${t.startOffsetMs} IS NULL END`,
    ),
    uniqueIndex('recordings_meeting_id_kind_key')
      .on(t.meetingId, t.kind)
      .where(sql`${t.kind} <> 'participant_track'`),
    uniqueIndex('recordings_one_source_key')
      .on(t.meetingId)
      .where(sql`${t.kind} IN ('original','mixed_audio')`),
    uniqueIndex('recordings_workspace_id_idempotency_key_key')
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    uniqueIndex('recordings_storage_key_key')
      .on(t.storageKey)
      .where(sql`${t.storageKey} <> ''`),
    // The stale-upload sweep looks for old in-flight uploads.
    index('recordings_uploading_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'uploading'`),
    check('recordings_kind_check', sql`${t.kind} IN (${inList(recordingKinds)})`),
    check('recordings_status_check', sql`${t.status} IN (${inList(recordingStatuses)})`),
    check('recordings_size_bytes_check', sql`${t.sizeBytes} > 0`),
    check(
      'recordings_audio_props_check',
      sql`(${t.sampleRate} IS NULL OR ${t.sampleRate} > 0) AND (${t.channels} IS NULL OR ${t.channels} > 0)`,
    ),
  ],
);

export type MeetingRow = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
export type MeetingParticipantRow = typeof meetingParticipants.$inferSelect;
export type RecordingRow = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;

export const meetingInvitations = pgTable(
  'meeting_invitations',
  {
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitation.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.invitationId] }),
    foreignKey({
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
  ],
);

export const roomMessages = pgTable(
  'room_messages',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.meetingId, t.userId, t.clientId),
    foreignKey({
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    index('room_messages_meeting_idx').on(t.workspaceId, t.meetingId, t.createdAt),
  ],
);
