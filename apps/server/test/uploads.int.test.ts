/**
 * Uploads end to end against a real S3-compatible server (Garage): presigned multipart parts are
 * PUT exactly like a browser would, then completed through the API. No storage stubs.
 */
import { ListObjectsV2Command, ListPartsCommand } from '@aws-sdk/client-s3';
import {
  auditLogs,
  and,
  domainEvents,
  eq,
  meetingParticipants,
  meetings,
  recordings,
  sql,
} from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMeetingMaintenance, RECORDING_UPLOADED_EVENT } from '../src/modules/meetings';
import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
} from './support/harness';
import {
  bytes,
  complete,
  createMeeting,
  type MeetingBody,
  MiB,
  putParts,
  startUpload,
  uploadRecording,
  type UploadSessionBody,
} from './support/meetings';

let t: TestApp;
let owner: Session;
let member: Session;
let ws: string;

const getMeeting = async (id: string, session = owner) => {
  const res = await call(t, session, { method: 'GET', url: `/v1/meetings/${id}` });
  return { status: res.statusCode, body: res.json<MeetingBody>() };
};

const eventsFor = (recordingId: string) =>
  t.deps.db.db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.type, RECORDING_UPLOADED_EVENT),
        sql`${domainEvents.payload}->>'recordingId' = ${recordingId}`,
      ),
    );

const auditActions = async (meetingId: string) =>
  (await t.deps.db.db.select().from(auditLogs).where(eq(auditLogs.targetId, meetingId))).map(
    (a) => a.action,
  );

const listKeys = async (prefix: string) =>
  (
    await t.deps.s3.send(
      new ListObjectsV2Command({ Bucket: t.deps.config.S3_BUCKET, Prefix: prefix }),
    )
  ).Contents?.map((o) => o.Key) ?? [];

/** Whether S3 still knows a multipart upload (ListParts fails once it's completed or aborted). */
async function multipartExists(key: string, uploadId: string): Promise<boolean> {
  try {
    await t.deps.s3.send(
      new ListPartsCommand({ Bucket: t.deps.config.S3_BUCKET, Key: key, UploadId: uploadId }),
    );
    return true;
  } catch {
    return false;
  }
}

const recordingRow = async (id: string) =>
  (await t.deps.db.db.select().from(recordings).where(eq(recordings.id, id)))[0];

const maintenance = () =>
  createMeetingMaintenance({
    db: t.deps.db.db,
    storage: t.deps.storage,
    audit: t.deps.audit,
    logger: t.deps.logger,
    runs: t.deps.processing.runs,
    staleAfterHours: 24,
  });

beforeAll(async () => {
  t = await createTestApp();
  owner = await createUser(t, 'uploads-owner');
  ws = (await createWorkspace(t, owner, 'Uploads')).id;
  member = await createUser(t, 'uploads-member');
  await addMember(t, ws, owner, member, 'member');
});

afterAll(() => t?.close());

describe('multipart upload', () => {
  it('uploads 3 parts of 5 MiB straight to storage and marks the meeting uploaded', async () => {
    const meeting = await createMeeting(t, member, ws);
    const data = bytes(2 * 5 * MiB + 1234); // 5 MiB + 5 MiB + a small last part
    const started = await startUpload(t, member, meeting.id, {
      fileName: 'Weekly sync.wav',
      sizeBytes: data.length,
    });
    expect(started.statusCode, started.body).toBe(201);
    const upload = started.json<UploadSessionBody>();
    expect(upload).toMatchObject({ meetingId: meeting.id, partSize: 5 * MiB, partCount: 3 });
    expect(upload.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(new Date(upload.urlsExpireAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    const during = await getMeeting(meeting.id);
    expect(during.body).toMatchObject({ status: 'uploading', recording: { status: 'uploading' } });

    const etags = await putParts(upload.parts, data, upload.partSize);
    const done = await complete(t, member, meeting.id, upload.uploadId, etags);
    expect(done.statusCode, done.body).toBe(202);
    expect(done.json()).toEqual({
      uploadId: upload.uploadId,
      meetingId: meeting.id,
      status: 'uploaded',
      sizeBytes: data.length,
    });

    const after = await getMeeting(meeting.id);
    expect(after.body).toMatchObject({
      status: 'uploaded',
      recording: {
        id: upload.uploadId,
        fileName: 'Weekly sync.wav',
        status: 'uploaded',
        sizeBytes: data.length,
      },
    });

    // Storage key: ws/{wid}/meetings/{mid}/original/{uuid} — never the file name.
    const row = await recordingRow(upload.uploadId);
    expect(row!.storageKey).toMatch(
      new RegExp(`^ws/${ws}/meetings/${meeting.id}/original/[0-9a-f-]{36}$`),
    );
    expect(row).toMatchObject({ consentConfirmedBy: member.userId, contentType: 'audio/wav' });
    expect(row!.consentConfirmedAt).toBeInstanceOf(Date);
    expect(await t.deps.storage.headObject(row!.storageKey)).toEqual({ sizeBytes: data.length });

    const events = await eventsFor(upload.uploadId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      workspaceId: ws,
      meetingId: meeting.id,
      recordingId: upload.uploadId,
      storageKey: row!.storageKey,
      sizeBytes: data.length,
    });
    expect(await auditActions(meeting.id)).toEqual(
      expect.arrayContaining(['meeting.created', 'upload.started', 'upload.completed']),
    );
  });

  it('completing twice (or concurrently) is idempotent: same result, one outbox event', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const data = bytes(6 * MiB, 3);
    const started = (
      await startUpload(t, owner, meeting.id, { sizeBytes: data.length })
    ).json<UploadSessionBody>();
    const etags = await putParts(started.parts, data, started.partSize);

    const [a, b] = await Promise.all([
      complete(t, owner, meeting.id, started.uploadId, etags),
      complete(t, owner, meeting.id, started.uploadId, etags),
    ]);
    const again = await complete(t, owner, meeting.id, started.uploadId, etags);
    for (const res of [a, b, again]) {
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual(a.json());
    }
    expect(await eventsFor(started.uploadId)).toHaveLength(1);
    expect((await auditActions(meeting.id)).filter((x) => x === 'upload.completed')).toHaveLength(
      1,
    );
  });

  it('rejects a size mismatch, removes the object and lets the user try again', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const declared = 5 * MiB + 100;
    const started = (
      await startUpload(t, owner, meeting.id, { sizeBytes: declared })
    ).json<UploadSessionBody>();
    // The last part is shorter than declared.
    const etags = await putParts(started.parts, bytes(declared - 40), started.partSize);
    const res = await complete(t, owner, meeting.id, started.uploadId, etags);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'UPLOAD_SIZE_MISMATCH' });

    const row = await recordingRow(started.uploadId);
    expect(row!.status).toBe('failed');
    expect(await t.deps.storage.headObject(row!.storageKey)).toBeNull();
    expect((await getMeeting(meeting.id)).body.status).toBe('awaiting_upload');
    expect(await eventsFor(started.uploadId)).toHaveLength(0);
    expect(await auditActions(meeting.id)).toContain('upload.failed');

    // A new attempt reuses the meeting's single original-recording slot.
    const data = bytes(1000);
    const retry = await uploadRecording(t, owner, meeting.id, data);
    expect((await getMeeting(meeting.id)).body).toMatchObject({
      status: 'uploaded',
      recording: { id: retry.upload.uploadId, sizeBytes: 1000 },
    });
  });

  it('rejects disallowed types, files over the limit and missing consent before touching storage', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const pdf = await startUpload(t, owner, meeting.id, {
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(pdf.headers['content-type']).toContain('application/problem+json');

    const huge = await startUpload(t, owner, meeting.id, { sizeBytes: 2 * 1024 ** 3 + 1 });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ code: 'UPLOAD_TOO_LARGE' });

    const noConsent = await startUpload(t, owner, meeting.id, {
      sizeBytes: 10,
      consentConfirmed: false,
    });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json()).toMatchObject({ code: 'VALIDATION_FAILED' });

    const noKey = await startUpload(t, owner, meeting.id, { sizeBytes: 10 }, null);
    expect(noKey.statusCode).toBe(400);

    expect((await getMeeting(meeting.id)).body).toMatchObject({
      status: 'awaiting_upload',
      recording: null,
    });
    expect(await listKeys(`ws/${ws}/meetings/${meeting.id}/`)).toEqual([]);
  });

  it('replays a start with the same Idempotency-Key and refuses to reuse it for another file', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const first = await startUpload(t, owner, meeting.id, { sizeBytes: 12 * MiB }, 'same-key-123');
    const replay = await startUpload(t, owner, meeting.id, { sizeBytes: 12 * MiB }, 'same-key-123');
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json<UploadSessionBody>().uploadId).toBe(
      first.json<UploadSessionBody>().uploadId,
    );

    const other = await startUpload(t, owner, meeting.id, { sizeBytes: 99 }, 'same-key-123');
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const second = await startUpload(t, owner, meeting.id, { sizeBytes: 12 * MiB });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'UPLOAD_IN_PROGRESS' });
  });

  it('hands out fresh URLs for more parts and rejects part numbers out of range', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const started = (
      await startUpload(t, owner, meeting.id, { sizeBytes: 12 * MiB })
    ).json<UploadSessionBody>();
    const more = (partNumbers: number[]) =>
      call(t, owner, {
        method: 'POST',
        url: `/v1/meetings/${meeting.id}/uploads/${started.uploadId}/parts`,
        payload: { partNumbers },
      });
    const ok = await more([3, 1]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ parts: { partNumber: number }[] }>().parts.map((p) => p.partNumber)).toEqual([
      3, 1,
    ]);
    const bad = await more([4]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'INVALID_PART_NUMBER' });
  });

  it('aborts an upload in storage and frees the meeting for another one', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const started = (
      await startUpload(t, owner, meeting.id, { sizeBytes: 6 * MiB })
    ).json<UploadSessionBody>();
    await putParts(started.parts.slice(0, 1), bytes(6 * MiB), started.partSize);
    const row = await recordingRow(started.uploadId);

    const res = await call(t, owner, {
      method: 'DELETE',
      url: `/v1/meetings/${meeting.id}/uploads/${started.uploadId}`,
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await multipartExists(row!.storageKey, row!.s3UploadId!)).toBe(false);
    expect(await recordingRow(started.uploadId)).toBeUndefined();
    expect((await getMeeting(meeting.id)).body).toMatchObject({
      status: 'awaiting_upload',
      recording: null,
    });
    expect(await auditActions(meeting.id)).toContain('upload.aborted');

    const again = await call(t, owner, {
      method: 'DELETE',
      url: `/v1/meetings/${meeting.id}/uploads/${started.uploadId}`,
    });
    expect(again.statusCode).toBe(404);
  });

  it('the stale-upload job aborts uploads older than 24 hours and marks them failed', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const fresh = await createMeeting(t, owner, ws);
    const old = (
      await startUpload(t, owner, meeting.id, { sizeBytes: 6 * MiB })
    ).json<UploadSessionBody>();
    const recent = (
      await startUpload(t, owner, fresh.id, { sizeBytes: 6 * MiB })
    ).json<UploadSessionBody>();
    await t.deps.db.db
      .update(recordings)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(recordings.id, old.uploadId));
    const oldRow = await recordingRow(old.uploadId);

    const result = await maintenance().abortStaleUploads();
    expect(result.aborted).toBeGreaterThanOrEqual(1);
    expect((await recordingRow(old.uploadId))!.status).toBe('failed');
    expect(await multipartExists(oldRow!.storageKey, oldRow!.s3UploadId!)).toBe(false);
    expect((await getMeeting(meeting.id)).body.status).toBe('awaiting_upload');
    // A recent upload is left alone.
    expect((await recordingRow(recent.uploadId))!.status).toBe('uploading');
    // Running it again finds nothing new to do for that upload.
    await maintenance().abortStaleUploads();
    expect((await auditActions(meeting.id)).filter((a) => a === 'upload.failed')).toHaveLength(1);
  });
});

describe('downloads', () => {
  it('gives owners and admins a short-lived attachment URL, and nobody else', async () => {
    const meeting = await createMeeting(t, member, ws);
    const data = bytes(4096);
    await uploadRecording(t, member, meeting.id, data, {
      fileName: 'Sync “Q4”.mp3',
      contentType: 'audio/mpeg',
    });

    const denied = await call(t, member, {
      method: 'GET',
      url: `/v1/meetings/${meeting.id}/recording`,
    });
    expect(denied.statusCode).toBe(403);

    const res = await call(t, owner, {
      method: 'GET',
      url: `/v1/meetings/${meeting.id}/recording`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ downloadUrl: string; recording: { fileName: string } }>();
    expect(body.recording.fileName).toBe('Sync “Q4”.mp3');
    const file = await fetch(body.downloadUrl);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Sync _Q4_.mp3"/,
    );
    expect(Buffer.from(await file.arrayBuffer()).equals(data)).toBe(true);
    expect(await auditActions(meeting.id)).toContain('recording.downloaded');
  });

  it('is a 404 while nothing is uploaded', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const res = await call(t, owner, {
      method: 'GET',
      url: `/v1/meetings/${meeting.id}/recording`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('deleting a meeting', () => {
  it('hides it at once and the job removes its storage objects and rows', async () => {
    const meeting = await createMeeting(t, owner, ws, {
      participantIds: [
        (
          await call(t, owner, {
            method: 'POST',
            url: `/v1/workspaces/${ws}/people`,
            payload: { displayName: 'Deleted meeting guest' },
          })
        ).json<{ id: string }>().id,
      ],
    });
    await uploadRecording(t, owner, meeting.id, bytes(5 * MiB + 10));
    const prefix = `ws/${ws}/meetings/${meeting.id}/`;
    expect(await listKeys(prefix)).toHaveLength(1);

    const res = await call(t, owner, { method: 'DELETE', url: `/v1/meetings/${meeting.id}` });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ id: meeting.id, status: 'deletion_scheduled' });

    // Gone from every query immediately.
    expect((await getMeeting(meeting.id)).status).toBe(404);
    const list = await call(t, owner, {
      method: 'GET',
      url: `/v1/workspaces/${ws}/meetings?limit=100`,
    });
    expect(list.json<{ meetings: MeetingBody[] }>().meetings.map((m) => m.id)).not.toContain(
      meeting.id,
    );
    expect(
      (await call(t, owner, { method: 'DELETE', url: `/v1/meetings/${meeting.id}` })).statusCode,
    ).toBe(404);

    // The purge job was enqueued for the worker.
    const jobs = await t.deps.maintenanceQueue.get().getJobs(['waiting', 'delayed', 'active']);
    expect(
      jobs.find(
        (j) =>
          j.name === 'meeting.delete' &&
          (j.data as { meetingId?: string }).meetingId === meeting.id,
      ),
    ).toBeDefined();

    const result = await maintenance().purgeMeeting(meeting.id, owner.userId);
    expect(result).toMatchObject({ purged: true, deletedObjects: 1 });
    expect(await listKeys(prefix)).toEqual([]);
    const db = t.deps.db.db;
    expect(await db.select().from(meetings).where(eq(meetings.id, meeting.id))).toEqual([]);
    expect(await db.select().from(recordings).where(eq(recordings.meetingId, meeting.id))).toEqual(
      [],
    );
    expect(
      await db
        .select()
        .from(meetingParticipants)
        .where(eq(meetingParticipants.meetingId, meeting.id)),
    ).toEqual([]);
    expect(await auditActions(meeting.id)).toEqual(
      expect.arrayContaining(['meeting.deleted', 'meeting.purged']),
    );

    // Idempotent: a duplicate job finds nothing to do.
    expect(await maintenance().purgeMeeting(meeting.id, owner.userId)).toMatchObject({
      purged: false,
    });
  });

  it('aborts an in-flight upload when purging, and the sweep finds purges that were lost', async () => {
    const meeting = await createMeeting(t, owner, ws);
    const started = (
      await startUpload(t, owner, meeting.id, { sizeBytes: 6 * MiB })
    ).json<UploadSessionBody>();
    const row = await recordingRow(started.uploadId);
    // Soft-deleted long ago, as if the enqueue had been lost.
    await t.deps.db.db
      .update(meetings)
      .set({ deletedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(meetings.id, meeting.id));

    const lost = await maintenance().findUnpurged(new Date(), 15 * 60_000);
    expect(lost).toContainEqual({ meetingId: meeting.id, workspaceId: ws });

    const result = await maintenance().purgeMeeting(meeting.id, null);
    expect(result).toMatchObject({ purged: true, abortedUploads: 1 });
    expect(await multipartExists(row!.storageKey, row!.s3UploadId!)).toBe(false);
  });

  it('only owners and admins may delete', async () => {
    const meeting = await createMeeting(t, member, ws);
    const res = await call(t, member, { method: 'DELETE', url: `/v1/meetings/${meeting.id}` });
    expect(res.statusCode).toBe(403);
  });
});
