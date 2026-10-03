import {
  and,
  asc,
  desc,
  domainEvents,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  meetingParticipants,
  type MeetingRow,
  meetings,
  type MeetingStatus,
  member,
  type NewDomainEvent,
  type NewRecording,
  or,
  people,
  type RecordingRow,
  recordings,
} from '@meeting-hub/db';

import type { Database } from '../../lib/db';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

export interface Participant {
  id: string;
  displayName: string;
}

export type Recording = RecordingRow;

export interface Meeting extends Omit<MeetingRow, 'deletedAt' | 'externalId'> {
  participants: Participant[];
  /** The original recording, if an upload was ever started. */
  recording: Recording | null;
}

export interface MeetingListOptions {
  cursor?: string | undefined;
  limit: number;
  status?: MeetingStatus | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface MeetingInput {
  title: string;
  occurredAt: Date;
  participantIds: string[];
}

/** A participant id that isn't a person in the meeting's workspace. */
export class UnknownParticipantsError extends Error {
  constructor(readonly ids: string[]) {
    super('unknown participants');
  }
}

const encodeCursor = (m: { occurredAt: Date; id: string }) =>
  Buffer.from(`${m.occurredAt.toISOString()}|${m.id}`).toString('base64url');

function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const occurredAt = new Date(iso ?? '');
  return id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(occurredAt.getTime())
    ? { occurredAt, id }
    : null;
}

const visible = (workspaceId: string) =>
  and(eq(meetings.workspaceId, workspaceId), isNull(meetings.deletedAt));

const meetingColumns = {
  id: meetings.id,
  workspaceId: meetings.workspaceId,
  title: meetings.title,
  occurredAt: meetings.occurredAt,
  durationMs: meetings.durationMs,
  language: meetings.language,
  status: meetings.status,
  source: meetings.source,
  createdBy: meetings.createdBy,
  createdAt: meetings.createdAt,
  updatedAt: meetings.updatedAt,
};

/**
 * Data access for meetings and their recordings. Every request-path method takes `workspaceId` and
 * only sees non-deleted meetings. The maintenance methods at the bottom are for background jobs,
 * which act on ids they got from the database itself.
 */
export class MeetingRepository {
  constructor(private readonly db: Database) {}

  /** The workspace of a visible meeting, but only if `userId` is a member of it. */
  async workspaceIdForMember(meetingId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ workspaceId: meetings.workspaceId })
      .from(meetings)
      .innerJoin(
        member,
        and(eq(member.organizationId, meetings.workspaceId), eq(member.userId, userId)),
      )
      .where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)));
    return row?.workspaceId ?? null;
  }

  async create(workspaceId: string, createdBy: string, input: MeetingInput): Promise<string> {
    return this.db.transaction(async (tx) => {
      await assertParticipants(tx, workspaceId, input.participantIds);
      const [row] = await tx
        .insert(meetings)
        .values({ workspaceId, title: input.title, occurredAt: input.occurredAt, createdBy })
        .returning({ id: meetings.id });
      await insertParticipants(tx, workspaceId, row!.id, input.participantIds);
      return row!.id;
    });
  }

  async get(workspaceId: string, id: string): Promise<Meeting | undefined> {
    const [row] = await this.db
      .select(meetingColumns)
      .from(meetings)
      .where(and(visible(workspaceId), eq(meetings.id, id)));
    return row ? (await this.hydrate([row]))[0] : undefined;
  }

  /** Newest first, keyset-paginated on (occurred_at, id). */
  async list(
    workspaceId: string,
    options: MeetingListOptions,
  ): Promise<{ meetings: Meeting[]; nextCursor: string | null }> {
    const after = options.cursor ? decodeCursor(options.cursor) : null;
    const rows = await this.db
      .select(meetingColumns)
      .from(meetings)
      .where(
        and(
          visible(workspaceId),
          options.status ? eq(meetings.status, options.status) : undefined,
          options.from ? gte(meetings.occurredAt, options.from) : undefined,
          options.to ? lt(meetings.occurredAt, options.to) : undefined,
          after
            ? or(
                lt(meetings.occurredAt, after.occurredAt),
                and(eq(meetings.occurredAt, after.occurredAt), lt(meetings.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(meetings.occurredAt), desc(meetings.id))
      .limit(options.limit + 1);
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      meetings: await this.hydrate(page),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  }

  /** False if the meeting doesn't exist (or is deleted). */
  async update(workspaceId: string, id: string, patch: Partial<MeetingInput>): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(meetings)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
          updatedAt: new Date(),
        })
        .where(and(visible(workspaceId), eq(meetings.id, id)))
        .returning({ id: meetings.id });
      if (!row) return false;
      if (patch.participantIds) {
        await assertParticipants(tx, workspaceId, patch.participantIds);
        await tx.delete(meetingParticipants).where(eq(meetingParticipants.meetingId, id));
        await insertParticipants(tx, workspaceId, id, patch.participantIds);
      }
      return true;
    });
  }

  /** Hides the meeting from every query at once; the purge job removes it later. */
  async softDelete(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(meetings)
      .set({ deletedAt: new Date() })
      .where(and(visible(workspaceId), eq(meetings.id, id)))
      .returning({ id: meetings.id });
    return rows.length > 0;
  }

  // --- uploads ------------------------------------------------------------------------------------

  async findOriginal(workspaceId: string, meetingId: string): Promise<Recording | undefined> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.workspaceId, workspaceId),
          eq(recordings.meetingId, meetingId),
          eq(recordings.kind, 'original'),
        ),
      );
    return row;
  }

  async findByIdempotencyKey(workspaceId: string, key: string): Promise<Recording | undefined> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.idempotencyKey, key)));
    return row;
  }

  /**
   * Records a started upload and moves the meeting to `uploading`, in one transaction. Replaces a
   * previous failed attempt's row (one original per meeting). Throws a unique violation if another
   * upload for the meeting, or the same idempotency key, got there first.
   */
  async saveStartedUpload(
    values: Omit<NewRecording, 'id' | 'kind' | 'status'>,
    replacing: Recording | undefined,
  ): Promise<Recording> {
    return this.db.transaction(async (tx) => {
      const row = { ...values, kind: 'original' as const, status: 'uploading' as const };
      const [saved] = replacing
        ? await tx
            .update(recordings)
            .set({
              ...row,
              sha256: null,
              durationMs: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(eq(recordings.id, replacing.id), eq(recordings.status, 'failed')))
            .returning()
        : await tx.insert(recordings).values(row).returning();
      if (!saved) throw new UploadRaceError();
      await setMeetingStatus(tx, values.meetingId, 'uploading');
      return saved;
    });
  }

  /**
   * Runs `fn` with the recording row locked (`SELECT … FOR UPDATE`), so completing an upload is
   * serialised: a concurrent or repeated call waits, then sees the committed outcome.
   */
  async withLockedUpload<T>(
    workspaceId: string,
    meetingId: string,
    recordingId: string,
    fn: (recording: Recording | undefined, tx: UploadTx) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(recordings)
        .where(
          and(
            eq(recordings.id, recordingId),
            eq(recordings.workspaceId, workspaceId),
            eq(recordings.meetingId, meetingId),
          ),
        )
        .for('update');
      return fn(row, new UploadTx(tx));
    });
  }

  // --- maintenance (background jobs) --------------------------------------------------------------

  /** In-flight uploads started before `startedBefore`, oldest first. */
  findStaleUploads(startedBefore: Date, limit: number): Promise<Recording[]> {
    return this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.status, 'uploading'), lt(recordings.createdAt, startedBefore)))
      .orderBy(asc(recordings.createdAt))
      .limit(limit);
  }

  /** A soft-deleted meeting and its recordings, for the purge job (undefined if gone already). */
  async findDeleted(
    meetingId: string,
  ): Promise<{ id: string; workspaceId: string; recordings: Recording[] } | undefined> {
    const [row] = await this.db
      .select({ id: meetings.id, workspaceId: meetings.workspaceId })
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), isNotNull(meetings.deletedAt)));
    if (!row) return undefined;
    const recs = await this.db.select().from(recordings).where(eq(recordings.meetingId, meetingId));
    return { ...row, recordings: recs };
  }

  /** Hard-deletes a soft-deleted meeting; participants and recordings cascade. */
  async purge(meetingId: string): Promise<boolean> {
    const rows = await this.db
      .delete(meetings)
      .where(and(eq(meetings.id, meetingId), isNotNull(meetings.deletedAt)))
      .returning({ id: meetings.id });
    return rows.length > 0;
  }

  /** Soft-deleted meetings still present after `deletedBefore` (their purge was lost or failed). */
  async findUnpurged(
    deletedBefore: Date,
    limit: number,
  ): Promise<{ meetingId: string; workspaceId: string }[]> {
    return this.db
      .select({ meetingId: meetings.id, workspaceId: meetings.workspaceId })
      .from(meetings)
      .where(and(isNotNull(meetings.deletedAt), lt(meetings.deletedAt, deletedBefore)))
      .orderBy(asc(meetings.deletedAt))
      .limit(limit);
  }

  // --- helpers ------------------------------------------------------------------------------------

  private async hydrate(rows: Omit<Meeting, 'participants' | 'recording'>[]): Promise<Meeting[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [participantRows, recordingRows] = await Promise.all([
      this.db
        .select({
          meetingId: meetingParticipants.meetingId,
          id: people.id,
          displayName: people.displayName,
        })
        .from(meetingParticipants)
        .innerJoin(people, eq(people.id, meetingParticipants.personId))
        .where(inArray(meetingParticipants.meetingId, ids))
        .orderBy(asc(people.displayName), asc(people.id)),
      this.db
        .select()
        .from(recordings)
        .where(and(inArray(recordings.meetingId, ids), eq(recordings.kind, 'original'))),
    ]);
    return rows.map((row) => ({
      ...row,
      participants: participantRows
        .filter((p) => p.meetingId === row.id)
        .map(({ id, displayName }) => ({ id, displayName })),
      recording: recordingRows.find((r) => r.meetingId === row.id) ?? null,
    }));
  }
}

/** Writes allowed inside `withLockedUpload`'s transaction. */
export class UploadTx {
  constructor(private readonly tx: Tx) {}

  /** Recording and meeting → uploaded, plus the outbox event: all or nothing. */
  async markUploaded(
    recording: Recording,
    sizeBytes: number,
    event: NewDomainEvent,
  ): Promise<void> {
    await this.tx
      .update(recordings)
      .set({ status: 'uploaded', sizeBytes, updatedAt: new Date() })
      .where(eq(recordings.id, recording.id));
    await setMeetingStatus(this.tx, recording.meetingId, 'uploaded');
    await this.tx.insert(domainEvents).values(event);
  }

  /** Cancelled: the row goes away and the meeting is back to awaiting_upload. */
  async deleteUpload(recording: Recording): Promise<void> {
    await this.tx.delete(recordings).where(eq(recordings.id, recording.id));
    await setMeetingStatus(this.tx, recording.meetingId, 'awaiting_upload');
  }

  /** The upload can't succeed: recording failed, meeting back to awaiting_upload. */
  async markFailed(recording: Recording): Promise<void> {
    await this.tx
      .update(recordings)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(recordings.id, recording.id));
    await setMeetingStatus(this.tx, recording.meetingId, 'awaiting_upload');
  }
}

/** The recording row changed between reading and writing it (a concurrent start). */
export class UploadRaceError extends Error {
  constructor() {
    super('upload changed concurrently');
  }
}

async function setMeetingStatus(db: Executor, meetingId: string, status: MeetingStatus) {
  await db
    .update(meetings)
    .set({ status, updatedAt: new Date() })
    .where(eq(meetings.id, meetingId));
}

async function assertParticipants(db: Executor, workspaceId: string, ids: string[]) {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, ids)));
  const known = new Set(found.map((p) => p.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new UnknownParticipantsError(unknown);
}

async function insertParticipants(
  db: Executor,
  workspaceId: string,
  meetingId: string,
  ids: string[],
) {
  if (ids.length === 0) return;
  await db
    .insert(meetingParticipants)
    .values(ids.map((personId) => ({ meetingId, personId, workspaceId })));
}
