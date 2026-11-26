import { createHash } from 'node:crypto';
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WebhookEvent } from 'livekit-server-sdk';
import {
  and,
  eq,
  meetings,
  people,
  meetingParticipants,
  roomAttendance,
  recordings,
  processingRuns,
  roomSessions,
  roomWebhookReceipts,
  featureFlags,
} from '@meeting-hub/db';
import {
  createTestApp,
  createUser,
  createWorkspace,
  addMember,
  call,
  testConfig,
  type TestApp,
  type Session,
} from './support/harness';
import { startWorkerRuntime, type WorkerRuntime } from '../src/worker-runtime';
import { NotFoundError } from '../src/lib/errors';

let t: TestApp;
let worker: WorkerRuntime;
let owner: Session;
let workspaceId: string;
it('copies Egress staging objects to extension-free recording keys', async () => {
  const key = `ws/${workspaceId}/meetings/${randomUUID()}/mixed_audio/${randomUUID()}`;
  await t.deps.storage.uploadBuffer(key + '.ogg', Buffer.from('egress fixture'), {
    contentType: 'audio/ogg',
  });
  await t.deps.storage.copyObject(key + '.ogg', key);
  expect((await t.deps.storage.headObject(key))?.sizeBytes).toBe(14);
  await t.deps.storage.deleteObjects([key, key + '.ogg']);
});
const prefix = 'rooms-test-' + randomUUID();
it('keeps the ended room visible when Egress fails', async () => {
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({
      workspaceId,
      title: 'Failed recording',
      occurredAt: new Date(),
      createdBy: owner.userId,
    })
    .returning();
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, true);
  const failed = vi
    .spyOn(t.deps.rooms.provider, 'startRecording')
    .mockRejectedValueOnce(new Error('Egress unavailable'));
  await t.deps.rooms.join(actor, m!.id, true);
  failed.mockRestore();
  await t.deps.rooms.end(actor, m!.id);
  const view = await t.deps.rooms.view(actor, m!.id);
  expect(view.status).toBe('ended');
  expect(view.recordingStatus).toBe('failed');
  expect(
    await t.deps.db.db.select().from(processingRuns).where(eq(processingRuns.meetingId, m!.id)),
  ).toHaveLength(0);
});
beforeAll(async () => {
  t = await createTestApp(
    {
      ROOM_PROVIDER: 'fake',
      ROOM_MAX_PARTICIPANTS: '1',
      FEATURE_FLAGS_OVERRIDE:
        'rooms.enabled=true,workspaces.invitations=true,people.directory=true,meetings.upload=true,pipeline.media=true,transcription.enabled=true,analysis.enabled=true',
    },
    { queuePrefix: prefix },
  );
  owner = await createUser(t, 'rooms-owner');
  workspaceId = (await createWorkspace(t, owner, 'Room lifecycle')).id;
  for (const key of ['pipeline.media', 'transcription.enabled', 'analysis.enabled'])
    await t.deps.db.db.insert(featureFlags).values({ workspaceId, key, enabled: true });
  worker = await startWorkerRuntime(
    testConfig({ ROOM_PROVIDER: 'fake', FEATURE_FLAGS_OVERRIDE: '' }),
    t.deps.logger,
    { queuePrefix: prefix },
  );
}, 120000);
afterAll(async () => {
  await worker?.close();
  await t?.close();
});

it('hides all room entry points when the feature is disabled', async () => {
  const disabled = await createTestApp({ FEATURE_FLAGS_OVERRIDE: 'rooms.enabled=false' });
  try {
    const [m] = await t.deps.db.db
      .insert(meetings)
      .values({
        workspaceId,
        title: 'Disabled room',
        occurredAt: new Date(),
        createdBy: owner.userId,
      })
      .returning();
    for (const suffix of ['', '/start', '/join', '/end']) {
      const response = await call(disabled, owner, {
        method: suffix ? 'POST' : 'GET',
        url: `/v1/meetings/${m!.id}/room${suffix}`,
        ...(suffix
          ? {
              payload:
                suffix === '/join' ? { consentAcknowledged: true } : { recordingEnabled: true },
            }
          : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  } finally {
    await disabled.close();
  }
});

it('lets a linked member join over HTTP without host privileges', async () => {
  const member = await createUser(t, 'room-linked-member');
  await addMember(t, workspaceId, owner, member, 'member');
  const [person] = await t.deps.db.db
    .select()
    .from(people)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.userId, member.userId)));
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({
      workspaceId,
      title: 'Participant access',
      occurredAt: new Date(),
      createdBy: owner.userId,
    })
    .returning();
  await t.deps.db.db
    .insert(meetingParticipants)
    .values({ workspaceId, meetingId: m!.id, personId: person!.id });
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, false);
  const joined = await call(t, member, {
    method: 'POST',
    url: `/v1/meetings/${m!.id}/room/join`,
    payload: { consentAcknowledged: false },
  });
  expect(joined.statusCode, joined.body).toBe(200);
  const body = joined.json<{ token: string; url: string }>();
  expect(typeof body.token).toBe('string');
  expect(typeof body.url).toBe('string');
  expect(joined.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify(t.logLines)).not.toContain(body.token);
  const forbidden = await call(t, member, {
    method: 'POST',
    url: `/v1/meetings/${m!.id}/room/end`,
    payload: {},
  });
  expect(forbidden.statusCode).toBe(404);
  await t.deps.rooms.end(actor, m!.id);
});

it('repairs a session whose room finished without a webhook', async () => {
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({ workspaceId, title: 'Missed event', occurredAt: new Date(), createdBy: owner.userId })
    .returning();
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, false);
  const [s] = await t.deps.db.db
    .select()
    .from(roomSessions)
    .where(eq(roomSessions.meetingId, m!.id));
  await t.deps.rooms.provider.endRoom(s!.id);
  await t.deps.db.db
    .update(roomSessions)
    .set({ startedAt: new Date(Date.now() - 120000) })
    .where(eq(roomSessions.id, s!.id));
  await t.deps.rooms.sweep();
  const [ended] = await t.deps.db.db.select().from(roomSessions).where(eq(roomSessions.id, s!.id));
  expect(ended!.endReason).toBe('empty_timeout');
  expect((await t.deps.rooms.view(actor, m!.id)).status).toBe('ended');
});

it('bounds participant reservations under the session lock', async () => {
  const other = await createUser(t, 'room-capacity');
  await addMember(t, workspaceId, owner, other, 'admin');
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({ workspaceId, title: 'One place', occurredAt: new Date(), createdBy: owner.userId })
    .returning();
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, false);
  await t.deps.rooms.join(actor, m!.id, false);
  await expect(
    t.deps.rooms.join({ workspaceId, userId: other.userId, role: 'admin' }, m!.id, false),
  ).rejects.toMatchObject({ code: 'ROOM_FULL' });
  await t.deps.rooms.end(actor, m!.id);
});

it('retries provider shutdown after the session was durably ended', async () => {
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({
      workspaceId,
      title: 'Interrupted shutdown',
      occurredAt: new Date(),
      createdBy: owner.userId,
    })
    .returning();
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, false);
  const [s] = await t.deps.db.db
    .select()
    .from(roomSessions)
    .where(eq(roomSessions.meetingId, m!.id));
  const shutdown = vi
    .spyOn(t.deps.rooms.provider, 'endRoom')
    .mockRejectedValueOnce(new Error('Provider offline'));
  await expect(t.deps.rooms.end(actor, m!.id)).rejects.toThrow('Provider offline');
  shutdown.mockRestore();
  expect((await t.deps.rooms.view(actor, m!.id)).status).toBe('ended');
  expect(await t.deps.rooms.provider.roomExists(s!.id)).toBe(true);
  await t.deps.rooms.sweep();
  expect(await t.deps.rooms.provider.roomExists(s!.id)).toBe(false);
});

it('deduplicates signed event delivery effects and purges live-room assets', async () => {
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({
      workspaceId,
      title: 'Room deletion',
      occurredAt: new Date(),
      createdBy: owner.userId,
    })
    .returning();
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, true);
  await t.deps.rooms.join(actor, m!.id, true);
  const [session] = await t.deps.db.db
    .select()
    .from(roomSessions)
    .where(eq(roomSessions.meetingId, m!.id));
  const event = new WebhookEvent({
    id: randomUUID(),
    event: 'participant_joined',
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    room: { name: session!.id },
    participant: { identity: owner.userId },
  });
  const webhook = vi.spyOn(t.deps.rooms.provider, 'handleWebhook').mockResolvedValue(event);
  await t.deps.rooms.webhook('signed fixture', 'fixture');
  await t.deps.rooms.webhook('signed fixture', 'fixture');
  expect(
    await t.deps.db.db
      .select()
      .from(roomWebhookReceipts)
      .where(eq(roomWebhookReceipts.eventId, event.id)),
  ).toHaveLength(1);
  webhook.mockRestore();
  await t.deps.meetings.delete(actor, m!.id, {});
  await worker.meetings.purgeMeeting(m!.id, owner.userId);
  expect(
    await t.deps.db.db.select().from(roomSessions).where(eq(roomSessions.meetingId, m!.id)),
  ).toHaveLength(0);
  expect(
    await t.deps.db.db
      .select()
      .from(roomWebhookReceipts)
      .where(eq(roomWebhookReceipts.eventId, event.id)),
  ).toHaveLength(0);
  expect(await t.deps.storage.listKeys(`ws/${workspaceId}/meetings/${m!.id}/`)).toHaveLength(0);
  expect(JSON.stringify(t.logLines)).not.toContain('signed fixture');
});

it('gates publishing on consent and finalizes one mixed recording and an attendance track', async () => {
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({ workspaceId, title: 'Live meeting', occurredAt: new Date(), createdBy: owner.userId })
    .returning();
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  await t.deps.rooms.start(actor, m!.id, true);
  await t.deps.rooms.join(actor, m!.id, false);
  let attendance = await t.deps.db.db
    .select()
    .from(roomAttendance)
    .where(eq(roomAttendance.meetingId, m!.id));
  expect(attendance[0]!.consentAcknowledgedAt).toBeNull();
  await t.deps.rooms.join(actor, m!.id, true);
  attendance = await t.deps.db.db
    .select()
    .from(roomAttendance)
    .where(eq(roomAttendance.meetingId, m!.id));
  expect(attendance).toHaveLength(1);
  expect(attendance[0]!.consentAcknowledgedAt).toBeInstanceOf(Date);
  await t.deps.rooms.end(actor, m!.id);
  await t.deps.rooms.end(actor, m!.id);
  await expect
    .poll(
      async () => {
        const [row] = await t.deps.db.db.select().from(meetings).where(eq(meetings.id, m!.id));
        return row?.status;
      },
      { timeout: 120000 },
    )
    .toBe('ready');
  const files = await t.deps.db.db
    .select()
    .from(recordings)
    .where(and(eq(recordings.meetingId, m!.id), eq(recordings.kind, 'participant_track')));
  expect(files).toHaveLength(1);
  expect(files[0]!.attendanceId).toBe(attendance[0]!.id);
  expect(files[0]!.startOffsetMs).toBeGreaterThanOrEqual(0);
  const runs = await t.deps.db.db
    .select()
    .from(processingRuns)
    .where(eq(processingRuns.meetingId, m!.id));
  expect(runs).toHaveLength(1);
  expect(runs[0]!.pipelineVersion).toBe(3);
}, 150000);

it('hides rooms from unrelated members and other workspaces', async () => {
  const outsider = await createUser(t, 'rooms-outsider');
  const [m] = await t.deps.db.db
    .insert(meetings)
    .values({ workspaceId, title: 'Private call', occurredAt: new Date(), createdBy: owner.userId })
    .returning();
  await expect(
    t.deps.rooms.join({ workspaceId, userId: outsider.userId, role: 'member' }, m!.id, true),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    t.deps.rooms.view({ workspaceId: randomUUID(), userId: owner.userId, role: 'owner' }, m!.id),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('enforces the workspace room cap and the timeout sweeper', async () => {
  const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
  const created = [];
  for (let i = 0; i < 4; i++) {
    const [m] = await t.deps.db.db
      .insert(meetings)
      .values({
        workspaceId,
        title: 'Bounded call',
        occurredAt: new Date(),
        createdBy: owner.userId,
      })
      .returning();
    created.push(m!);
  }
  for (const m of created.slice(0, 3)) await t.deps.rooms.start(actor, m.id, false);
  await expect(t.deps.rooms.start(actor, created[3]!.id, false)).rejects.toMatchObject({
    code: 'ROOM_LIMIT',
  });
  await t.deps.db.db
    .update(roomSessions)
    .set({ startedAt: new Date(Date.now() - 61 * 60000) })
    .where(eq(roomSessions.workspaceId, workspaceId));
  await t.deps.rooms.sweep();
  expect((await t.deps.rooms.view(actor, created[0]!.id)).status).toBe('ended');
});

it.each([true, false])(
  'accepts signed room and egress events without attendance (recording=%s)',
  async (enabled) => {
    const [m] = await t.deps.db.db
      .insert(meetings)
      .values({
        workspaceId,
        title: 'Signed room',
        occurredAt: new Date(),
        createdBy: owner.userId,
      })
      .returning();
    const actor = { workspaceId, userId: owner.userId, role: 'owner' as const };
    await t.deps.rooms.start(actor, m!.id, enabled);
    const [session] = await t.deps.db.db
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.meetingId, m!.id));
    const receiver = new WebhookReceiver('regression-key', 'regression-secret');
    const verify = vi
      .spyOn(t.deps.rooms.provider, 'handleWebhook')
      .mockImplementation((body, auth) => receiver.receive(body, auth));
    try {
      for (const event of ['egress_ended', 'room_finished']) {
        const body = JSON.stringify({
          event,
          id: randomUUID(),
          createdAt: String(Math.floor(Date.now() / 1000)),
          room: { name: session!.id },
          ...(event === 'egress_ended'
            ? {
                egressInfo: {
                  roomName: session!.id,
                  egressId: 'missing-export',
                  status: 'EGRESS_FAILED',
                },
              }
            : {}),
        });
        const token = await new AccessToken('regression-key', 'regression-secret', {
          sha256: createHash('sha256').update(body).digest('base64'),
        }).toJwt();
        const post = (authorization: string) =>
          t.app.inject({
            method: 'POST',
            url: '/v1/rooms/webhook',
            headers: { 'content-type': 'application/webhook+json', authorization },
            payload: body,
          });
        expect((await post('invalid')).statusCode).toBe(401);
        expect((await post(token)).statusCode).toBe(200);
        expect((await post(token)).statusCode).toBe(200);
      }
      const view = await t.deps.rooms.view(actor, m!.id);
      expect(view.status).toBe('ended');
      expect(view.recordingStatus).toBe(enabled ? 'failed' : 'off');
    } finally {
      verify.mockRestore();
    }
  },
);
