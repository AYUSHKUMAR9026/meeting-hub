import { TrackType, TrackSource } from 'livekit-server-sdk';
import {
  and,
  eq,
  isNull,
  isNotNull,
  inArray,
  sql,
  meetings,
  meetingParticipants,
  people,
  user,
  roomSessions,
  roomAttendance,
  roomExports,
  roomWebhookReceipts,
  recordings,
  domainEvents,
} from '@meeting-hub/db';
import type { Database } from '../../lib/db';
import type { Config } from '../../lib/config';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../lib/errors';
import { roleCan, type WorkspaceActor } from '../auth';
import type { AuditService } from '../audit';
import { roomRecordingKey, type ObjectStorage } from '../media';
import { FakeRoomProvider, LiveKitProvider, type RoomProvider } from './provider';

type Session = typeof roomSessions.$inferSelect;
type Export = typeof roomExports.$inferSelect;

export class RoomService {
  readonly provider: RoomProvider;
  constructor(
    private db: Database,
    private cfg: Config,
    private storage: ObjectStorage,
    private audit: AuditService,
    private changed: (id: string) => Promise<void>,
    provider?: RoomProvider,
  ) {
    this.provider =
      provider ??
      (cfg.ROOM_PROVIDER === 'fake' ? new FakeRoomProvider() : new LiveKitProvider(cfg));
  }

  private async access(actor: WorkspaceActor, id: string, mode: 'view' | 'host' | 'join') {
    const [meeting] = await this.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.id, id),
          eq(meetings.workspaceId, actor.workspaceId),
          isNull(meetings.deletedAt),
        ),
      );
    if (!meeting) throw new NotFoundError();
    const manager = roleCan(actor.role, 'meeting.update_any');
    const [linked] = await this.db
      .select({ id: people.id })
      .from(meetingParticipants)
      .innerJoin(
        people,
        and(eq(people.id, meetingParticipants.personId), eq(people.workspaceId, actor.workspaceId)),
      )
      .where(
        and(
          eq(meetingParticipants.meetingId, id),
          eq(meetingParticipants.workspaceId, actor.workspaceId),
          eq(people.userId, actor.userId),
        ),
      );
    const canHost = manager || meeting.createdBy === actor.userId;
    const canJoin = manager || Boolean(linked);
    if (mode === 'host' ? !canHost : mode === 'join' ? !canJoin : !canHost && !canJoin)
      throw new NotFoundError();
    return { meeting, canHost, canJoin, personId: linked?.id ?? null };
  }

  async view(actor: WorkspaceActor, id: string) {
    const { meeting, canHost, canJoin } = await this.access(actor, id, 'view');
    const present = await this.db
      .select({ userId: user.id, name: user.name })
      .from(roomAttendance)
      .innerJoin(user, eq(user.id, roomAttendance.userId))
      .where(
        and(
          eq(roomAttendance.workspaceId, actor.workspaceId),
          eq(roomAttendance.meetingId, id),
          isNotNull(roomAttendance.joinedAt),
          isNull(roomAttendance.leftAt),
        ),
      );
    const exports = await this.db
      .select({ state: roomExports.state, sourceId: roomExports.sourceId })
      .from(roomExports)
      .where(and(eq(roomExports.workspaceId, actor.workspaceId), eq(roomExports.meetingId, id)));
    const mix = exports.find((item) => item.sourceId === 'mixed');
    const failed = exports.some((item) => item.state === 'failed');
    return {
      status: meeting.roomStatus,
      recordingEnabled: meeting.recordingEnabled,
      canHost,
      canJoin,
      present,
      recordingStatus: meeting.recordingEnabled
        ? failed
          ? 'failed'
          : (mix?.state ?? (meeting.roomStatus === 'ended' ? 'failed' : 'pending'))
        : ('off' as const),
    };
  }

  async start(actor: WorkspaceActor, id: string, enabled: boolean) {
    await this.access(actor, id, 'host');
    const session = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.workspaceId},0))`);
      const [meeting] = await tx
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, id),
            eq(meetings.workspaceId, actor.workspaceId),
            isNull(meetings.deletedAt),
          ),
        )
        .for('update');
      if (!meeting) throw new NotFoundError();
      if (
        meeting.roomStatus === 'live' ||
        meeting.roomStatus === 'ended' ||
        meeting.status !== 'awaiting_upload'
      )
        throw new ConflictError('ROOM_UNAVAILABLE', 'Meeting cannot be started');
      const active = await tx
        .select({ id: roomSessions.id })
        .from(roomSessions)
        .where(and(eq(roomSessions.workspaceId, actor.workspaceId), isNull(roomSessions.endedAt)));
      if (active.length >= this.cfg.ROOM_WORKSPACE_LIMIT)
        throw new ConflictError('ROOM_LIMIT', 'Workspace room limit reached');
      const [s] = await tx
        .insert(roomSessions)
        .values({ workspaceId: actor.workspaceId, meetingId: id, startedBy: actor.userId })
        .returning();
      await tx
        .update(meetings)
        .set({
          source: 'live',
          roomStatus: 'live',
          roomName: s!.id,
          recordingEnabled: enabled,
          roomStartedAt: s!.startedAt,
        })
        .where(eq(meetings.id, id));
      return s!;
    });
    try {
      await this.provider.createRoom(session.id);
    } catch {
      await this.finish(session, 'error');
      throw new ConflictError('ROOM_START_FAILED', 'Room could not start');
    }
    for (const action of ['room.started', 'room.recording_toggled'] as const)
      await this.audit.record({
        action,
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        target: { type: 'meeting', id },
        metadata: { recordingEnabled: enabled },
      });
    await this.changed(id);
    return this.view(actor, id);
  }

  private async capture(session: Session, sourceId: string, attendanceId: string | null) {
    const storageKey = roomRecordingKey(
      session.workspaceId,
      session.meetingId,
      attendanceId ? 'participant_track' : 'mixed_audio',
    );
    const [record] = await this.db
      .insert(roomExports)
      .values({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        meetingId: session.meetingId,
        attendanceId,
        sourceId,
        storageKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!record) return;
    try {
      const egressId = await this.provider.startRecording(
        session.id,
        storageKey,
        attendanceId ? sourceId : undefined,
      );
      await this.db
        .update(roomExports)
        .set({ egressId, state: 'active' })
        .where(eq(roomExports.id, record.id));
    } catch {
      await this.db
        .update(roomExports)
        .set({ state: 'failed' })
        .where(eq(roomExports.id, record.id));
    }
  }

  async join(actor: WorkspaceActor, id: string, ack: boolean) {
    const { meeting, personId } = await this.access(actor, id, 'join');
    const { s, att } = await this.db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(roomSessions)
        .where(
          and(
            eq(roomSessions.meetingId, id),
            eq(roomSessions.workspaceId, actor.workspaceId),
            isNull(roomSessions.endedAt),
          ),
        )
        .for('update');
      if (!s) throw new ConflictError('ROOM_ENDED', 'Room is not live');
      const occupants = await tx
        .select()
        .from(roomAttendance)
        .where(and(eq(roomAttendance.sessionId, s.id), isNull(roomAttendance.leftAt)));
      let att = occupants.find((v) => v.userId === actor.userId);
      if (!att) {
        if (occupants.length >= this.cfg.ROOM_MAX_PARTICIPANTS)
          throw new ConflictError('ROOM_FULL', 'Room is full');
        [att] = await tx
          .insert(roomAttendance)
          .values({
            sessionId: s.id,
            workspaceId: actor.workspaceId,
            meetingId: id,
            userId: actor.userId,
            personId,
            joinedAt: this.provider instanceof FakeRoomProvider ? new Date() : null,
            consentAcknowledgedAt: ack ? new Date() : null,
          })
          .returning();
      } else if (ack && !att.consentAcknowledgedAt) {
        [att] = await tx
          .update(roomAttendance)
          .set({ consentAcknowledgedAt: new Date() })
          .where(eq(roomAttendance.id, att.id))
          .returning();
      }
      return { s, att: att! };
    });
    const [profile] = await this.db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, actor.userId));
    if (!profile) throw new NotFoundError();
    if (meeting.recordingEnabled && att.consentAcknowledgedAt) await this.capture(s, 'mixed', null);
    if (
      this.provider instanceof FakeRoomProvider &&
      meeting.recordingEnabled &&
      att.consentAcknowledgedAt
    )
      await this.capture(s, att.id, att.id);
    const token = await this.provider.mintJoinToken({
      room: s.id,
      userId: actor.userId,
      displayName: profile.name,
      recordingEnabled: meeting.recordingEnabled,
      consentAcknowledged: Boolean(att.consentAcknowledgedAt),
    });
    await this.audit.record({
      action: 'room.joined',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id },
    });
    await this.changed(id);
    return { token, url: this.cfg.LIVEKIT_PUBLIC_URL };
  }
  async end(actor: WorkspaceActor, id: string) {
    await this.access(actor, id, 'host');
    const [s] = await this.db
      .select()
      .from(roomSessions)
      .where(
        and(
          eq(roomSessions.workspaceId, actor.workspaceId),
          eq(roomSessions.meetingId, id),
          isNull(roomSessions.endedAt),
        ),
      );
    if (s) await this.finish(s, 'host_ended', actor.userId);
    return this.view(actor, id);
  }
  private async finish(
    s: Session,
    reason: NonNullable<Session['endReason']>,
    actorUserId?: string,
  ) {
    await this.db.transaction(async (tx) => {
      const endedAt = new Date();
      const changed = await tx
        .update(roomSessions)
        .set({ endedAt, endReason: reason })
        .where(and(eq(roomSessions.id, s.id), isNull(roomSessions.endedAt)))
        .returning({ id: roomSessions.id });
      if (!changed.length) return;
      await tx
        .update(meetings)
        .set({ roomStatus: 'ended', roomEndedAt: endedAt })
        .where(eq(meetings.id, s.meetingId));
      await tx
        .update(roomAttendance)
        .set({ leftAt: endedAt })
        .where(and(eq(roomAttendance.sessionId, s.id), isNull(roomAttendance.leftAt)));
    });
    if (await this.provider.roomExists(s.id)) await this.provider.endRoom(s.id);
    await this.audit.record({
      action: 'room.ended',
      workspaceId: s.workspaceId,
      actorUserId: actorUserId ?? null,
      target: { type: 'meeting', id: s.meetingId },
      metadata: { reason },
    });
    const exports = await this.db
      .select()
      .from(roomExports)
      .where(and(eq(roomExports.sessionId, s.id), eq(roomExports.state, 'active')));
    for (const item of exports) await this.reconcile(item, s);
    await this.changed(s.meetingId);
  }

  private async reconcile(item: Export, s: Session) {
    if (!item.egressId) {
      if (Date.now() - item.createdAt.getTime() > 60000)
        await this.db
          .update(roomExports)
          .set({ state: 'failed' })
          .where(eq(roomExports.id, item.id));
      return;
    }
    const state = await this.provider.recordingState(item.egressId);
    if (state === 'active') return;
    if (state === 'failed') {
      await this.db.update(roomExports).set({ state }).where(eq(roomExports.id, item.id));
      return;
    }
    if (!item.attendanceId && !s.endedAt) {
      const [current] = await this.db.select().from(roomSessions).where(eq(roomSessions.id, s.id));
      if (!current?.endedAt) return;
    }
    let contentType = 'audio/ogg';
    if (this.provider instanceof FakeRoomProvider) {
      contentType = 'audio/wav';
      await this.storage.uploadBuffer(item.storageKey, fixtureAudio(), { contentType });
    }
    if (
      !(this.provider instanceof FakeRoomProvider) &&
      !(await this.storage.headObject(item.storageKey))
    ) {
      await this.storage.copyObject(item.storageKey + '.ogg', item.storageKey);
    }
    const head = await this.storage.headObject(item.storageKey);
    if (!head?.sizeBytes || head.sizeBytes > this.cfg.MAX_UPLOAD_BYTES) {
      await this.db.update(roomExports).set({ state: 'failed' }).where(eq(roomExports.id, item.id));
      return;
    }
    let startOffsetMs: number | null = null;
    if (item.attendanceId) {
      const [mixed] = await this.db
        .select()
        .from(roomExports)
        .where(and(eq(roomExports.sessionId, s.id), eq(roomExports.sourceId, 'mixed')));
      const trackStart = await this.provider.recordingStartedAt(item.egressId);
      const mixedStart = mixed?.egressId
        ? await this.provider.recordingStartedAt(mixed.egressId)
        : null;
      startOffsetMs = Math.max(
        0,
        (trackStart ?? item.createdAt).getTime() -
          (mixedStart ?? mixed?.createdAt ?? s.startedAt).getTime(),
      );
    }
    await this.db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, s.meetingId), isNull(meetings.deletedAt)))
        .for('update');
      if (!m) return;
      const inserted = await tx
        .insert(recordings)
        .values({
          workspaceId: s.workspaceId,
          meetingId: s.meetingId,
          kind: item.attendanceId ? 'participant_track' : 'mixed_audio',
          attendanceId: item.attendanceId,
          startOffsetMs,
          storageKey: item.storageKey,
          contentType,
          sizeBytes: head.sizeBytes,
          originalFilename: contentType === 'audio/wav' ? 'room.wav' : 'room.ogg',
          status: 'uploaded',
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0] && !item.attendanceId) {
        await tx.update(meetings).set({ status: 'uploaded' }).where(eq(meetings.id, s.meetingId));
        await tx.insert(domainEvents).values({
          type: 'recording.uploaded',
          payload: {
            workspaceId: s.workspaceId,
            meetingId: s.meetingId,
            recordingId: inserted[0].id,
            storageKey: item.storageKey,
            contentType,
            sizeBytes: head.sizeBytes,
          },
        });
      }
      if (!inserted.length) {
        const [existing] = await tx
          .select({ id: recordings.id })
          .from(recordings)
          .where(eq(recordings.storageKey, item.storageKey));
        if (!existing) {
          await tx.update(roomExports).set({ state: 'failed' }).where(eq(roomExports.id, item.id));
          return;
        }
      }
      await tx.update(roomExports).set({ state: 'done' }).where(eq(roomExports.id, item.id));
    });
    if (!(this.provider instanceof FakeRoomProvider))
      await this.storage.deleteObject(item.storageKey + '.ogg');
  }
  async webhook(
    body: string,
    authorization: string,
    enabled?: (workspaceId: string) => Promise<boolean>,
  ) {
    const event = await this.provider.handleWebhook(body, authorization).catch(() => {
      throw new UnauthorizedError();
    });
    const name = event.room?.name ?? event.egressInfo?.roomName;
    if (!name || !/^[a-f0-9-]{36}$/i.test(name)) return;
    const [s] = await this.db.select().from(roomSessions).where(eq(roomSessions.id, name));
    if (!s) return;
    if (enabled && !(await enabled(s.workspaceId))) throw new NotFoundError();
    const [receipt] = await this.db
      .select()
      .from(roomWebhookReceipts)
      .where(eq(roomWebhookReceipts.eventId, event.id));
    if (receipt) return;
    {
      const attendance = await this.db
        .select()
        .from(roomAttendance)
        .where(and(eq(roomAttendance.sessionId, s.id), isNull(roomAttendance.leftAt)));
      const person = attendance.find((a) => a.userId === event.participant?.identity);
      if (event.event === 'participant_joined' && person && !s.endedAt)
        await this.db
          .update(roomAttendance)
          .set({ joinedAt: new Date(Number(event.createdAt) * 1000) })
          .where(eq(roomAttendance.id, person.id));
      if (
        event.event === 'participant_left' &&
        person?.joinedAt &&
        Number(event.createdAt) * 1000 >= person.joinedAt.getTime()
      )
        await this.db
          .update(roomAttendance)
          .set({ leftAt: new Date(Number(event.createdAt) * 1000) })
          .where(eq(roomAttendance.id, person.id));
      if (
        event.event === 'track_published' &&
        event.track?.type === TrackType.AUDIO &&
        event.track.source === TrackSource.MICROPHONE &&
        person?.consentAcknowledgedAt &&
        !s.endedAt
      ) {
        const [meeting] = await this.db
          .select()
          .from(meetings)
          .where(and(eq(meetings.id, s.meetingId), isNull(meetings.deletedAt)));
        if (meeting?.recordingEnabled) await this.capture(s, event.track.sid, person.id);
      }
      if (event.event === 'room_finished' && !s.endedAt) await this.finish(s, 'empty_timeout');
      if (event.event === 'egress_ended' && event.egressInfo) {
        const [item] = await this.db
          .select()
          .from(roomExports)
          .where(
            and(
              eq(roomExports.sessionId, s.id),
              eq(roomExports.egressId, event.egressInfo.egressId),
            ),
          );
        if (item) await this.reconcile(item, s);
      }
    }
    await this.db
      .insert(roomWebhookReceipts)
      .values({
        eventId: event.id,
        sessionId: s.id,
        meetingId: s.meetingId,
        workspaceId: s.workspaceId,
      })
      .onConflictDoNothing();
    await this.changed(s.meetingId);
  }
  async sweep() {
    // A crash or provider outage can occur after the database marks a session ended.
    // Retry provider shutdown independently of the active-session timeout scan.
    const liveNames = (await this.provider.listRooms()).filter((name) =>
      /^[a-f0-9-]{36}$/i.test(name),
    );
    if (liveNames.length) {
      const ended = await this.db
        .select()
        .from(roomSessions)
        .where(and(isNotNull(roomSessions.endedAt), inArray(roomSessions.id, liveNames)));
      for (const s of ended) await this.provider.endRoom(s.id);
    }
    const sessions = await this.db.select().from(roomSessions).where(isNull(roomSessions.endedAt));
    for (const s of sessions) {
      const [meeting] = await this.db.select().from(meetings).where(eq(meetings.id, s.meetingId));
      if (meeting?.deletedAt) {
        await this.finish(s, 'error');
        continue;
      }
      const age = Date.now() - s.startedAt.getTime();
      if (age >= this.cfg.ROOM_MAX_MINUTES * 60000) await this.finish(s, 'max_duration');
      else if (
        age >= this.cfg.ROOM_EMPTY_TIMEOUT_SECONDS * 1000 &&
        !(await this.provider.roomExists(s.id))
      )
        await this.finish(s, 'empty_timeout');
    }
    const pending = await this.db
      .select({ item: roomExports, s: roomSessions })
      .from(roomExports)
      .innerJoin(roomSessions, eq(roomSessions.id, roomExports.sessionId))
      .where(
        and(isNotNull(roomSessions.endedAt), inArray(roomExports.state, ['active', 'pending'])),
      );
    for (const { item, s } of pending) await this.reconcile(item, s);
  }

  async stopForDeletion(meetingId: string) {
    const sessions = await this.db
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.meetingId, meetingId));
    for (const session of sessions) {
      if (!session.endedAt) await this.finish(session, 'error');
      else if (await this.provider.roomExists(session.id)) await this.provider.endRoom(session.id);
    }
    const pending = await this.db
      .select()
      .from(roomExports)
      .where(and(eq(roomExports.meetingId, meetingId), eq(roomExports.state, 'active')));
    for (const item of pending) {
      if (!item.egressId) continue;
      if ((await this.provider.recordingState(item.egressId)) === 'active') {
        await this.provider.stopRecording(item.egressId);
        throw new ConflictError('RECORDING_STOPPING', 'Recording is stopping');
      }
    }
  }
}

function fixtureAudio() {
  const bytes = 32000 * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF');
  wav.writeUInt32LE(bytes + 36, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  return wav;
}
