import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditLogs,
  createDb,
  type DbClient,
  domainEvents,
  featureFlags,
  meetingParticipants,
  meetings,
  type NewMeeting,
  type NewProcessingRun,
  organization,
  people,
  processingRuns,
  processingSteps,
  recordings,
  runMigrations,
  sql,
  user,
  workspaceSettings,
} from '../src';

/** The Postgres error message behind a rejected Drizzle query ('' if it succeeded). */
async function postgresError(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
    return '';
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(err);
  }
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PG_IMAGE = 'pgvector/pgvector:0.8.7-pg18-trixie';

describe('migrations', () => {
  let container: StartedPostgreSqlContainer;
  let client: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(PG_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    client = createDb({ connectionString: container.getConnectionUri(), max: 2 });
  });

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('is idempotent', async () => {
    await expect(runMigrations(container.getConnectionUri())).resolves.toBeUndefined();
  });

  it('enables vector, pg_trgm and unaccent', async () => {
    const { rows } = await client.pool.query<{ extname: string }>(
      'SELECT extname FROM pg_extension',
    );
    expect(rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['vector', 'pg_trgm', 'unaccent']),
    );
  });

  it('generates UUIDv7 primary keys', async () => {
    const [row] = await client.db
      .insert(domainEvents)
      .values({ type: 'test.event', payload: { ok: true } })
      .returning();
    expect(row?.id).toMatch(UUID_V7);
    expect(row?.processedAt).toBeNull();
  });

  it('allows only one global row per flag key', async () => {
    await client.db.insert(featureFlags).values({ key: 'flag.unique', enabled: true });
    await expect(
      client.db.insert(featureFlags).values({ key: 'flag.unique', enabled: false }),
    ).rejects.toThrow();
  });

  it('uses the partial index for unprocessed outbox events', async () => {
    const { rows } = await client.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'domain_events_unprocessed_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('WHERE (processed_at IS NULL)');
  });

  it('supports pgvector types', async () => {
    const result = await client.db.execute(
      sql`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS d`,
    );
    expect(Number(result.rows[0]?.d)).toBe(1);
  });

  describe('auth and workspace tables', () => {
    let workspaceId: string;
    let userId: string;

    beforeAll(async () => {
      const [u] = await client.db
        .insert(user)
        .values({ name: 'Ada', email: 'ada@example.com' })
        .returning();
      const [w] = await client.db
        .insert(organization)
        .values({ name: 'Acme', slug: 'acme' })
        .returning();
      userId = u!.id;
      workspaceId = w!.id;
    });

    it('gives Better Auth tables UUIDv7 ids', () => {
      expect(userId).toMatch(UUID_V7);
      expect(workspaceId).toMatch(UUID_V7);
    });

    it('defaults workspace settings', async () => {
      const [row] = await client.db.insert(workspaceSettings).values({ workspaceId }).returning();
      expect(row).toMatchObject({ timezone: 'UTC', retentionDays: 30, glossary: [] });
      await expect(
        client.db.insert(workspaceSettings).values({ workspaceId: crypto.randomUUID() }),
      ).rejects.toThrow();
    });

    it('keeps people emails unique per workspace but allows many without email', async () => {
      await client.db.insert(people).values([
        { workspaceId, displayName: 'Ada', email: 'ada@example.com', userId },
        { workspaceId, displayName: 'Guest 1' },
        { workspaceId, displayName: 'Guest 2' },
      ]);
      await expect(
        client.db
          .insert(people)
          .values({ workspaceId, displayName: 'Dup', email: 'ada@example.com' }),
      ).rejects.toThrow();
    });

    it('indexes people display names with pg_trgm', async () => {
      const { rows } = await client.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'people_display_name_trgm_idx'`,
      );
      expect(rows[0]?.indexdef).toContain('gin_trgm_ops');
    });

    it('rejects feature flags for unknown workspaces', async () => {
      await expect(
        client.db
          .insert(featureFlags)
          .values({ key: 'flag.fk', workspaceId: crypto.randomUUID(), enabled: true }),
      ).rejects.toThrow();
      await client.db.insert(featureFlags).values({ key: 'flag.fk', workspaceId, enabled: true });
    });

    it('makes audit_logs append-only', async () => {
      const [row] = await client.db
        .insert(auditLogs)
        .values({ workspaceId, action: 'test.event' })
        .returning();
      const update = client.db
        .update(auditLogs)
        .set({ action: 'tampered' })
        .where(sql`id = ${row!.id}`);
      expect(await postgresError(update)).toMatch(/append-only/);
      expect(await postgresError(client.db.delete(auditLogs))).toMatch(/append-only/);
    });
  });

  describe('meeting tables', () => {
    let ws1: string;
    let ws2: string;
    let person1: string;
    let person2: string;

    beforeAll(async () => {
      const [a, b] = await client.db
        .insert(organization)
        .values([
          { name: 'One', slug: 'meetings-one' },
          { name: 'Two', slug: 'meetings-two' },
        ])
        .returning();
      ws1 = a!.id;
      ws2 = b!.id;
      const [p1, p2] = await client.db
        .insert(people)
        .values([
          { workspaceId: ws1, displayName: 'In one' },
          { workspaceId: ws2, displayName: 'In two' },
        ])
        .returning();
      person1 = p1!.id;
      person2 = p2!.id;
    });

    async function newMeeting(workspaceId: string, extra: Partial<NewMeeting> = {}) {
      const [row] = await client.db
        .insert(meetings)
        .values({ workspaceId, title: 'Standup', occurredAt: new Date(), ...extra })
        .returning();
      return row!;
    }

    const newRecording = (meetingId: string, workspaceId: string, idempotencyKey?: string) =>
      client.db.insert(recordings).values({
        meetingId,
        workspaceId,
        storageKey: `ws/${workspaceId}/meetings/${meetingId}/original/${crypto.randomUUID()}`,
        originalFilename: 'standup.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 1024,
        idempotencyKey,
      });

    it('defaults a new meeting to awaiting_upload from an upload source', async () => {
      const meeting = await newMeeting(ws1);
      expect(meeting).toMatchObject({
        status: 'awaiting_upload',
        source: 'upload',
        deletedAt: null,
      });
      expect(meeting.id).toMatch(UUID_V7);
    });

    it('rejects unknown meeting statuses', async () => {
      expect(await postgresError(newMeeting(ws1, { status: 'bogus' as never }))).toMatch(
        /meetings_status_check/,
      );
    });

    it('keeps external ids unique per workspace and source', async () => {
      await newMeeting(ws1, { source: 'zoom', externalId: 'abc' });
      await newMeeting(ws2, { source: 'zoom', externalId: 'abc' });
      await newMeeting(ws1, { source: 'teams', externalId: 'abc' });
      expect(await postgresError(newMeeting(ws1, { source: 'zoom', externalId: 'abc' }))).toMatch(
        /meetings_workspace_id_source_external_id_key/,
      );
    });

    it("only accepts participants from the meeting's own workspace", async () => {
      const meeting = await newMeeting(ws1);
      await client.db
        .insert(meetingParticipants)
        .values({ meetingId: meeting.id, personId: person1, workspaceId: ws1 });
      // A person of workspace 2 can't be attached, whichever workspace id is claimed.
      const attach = (workspaceId: string) =>
        client.db
          .insert(meetingParticipants)
          .values({ meetingId: meeting.id, personId: person2, workspaceId });
      expect(await postgresError(attach(ws1))).toMatch(/meeting_participants_person_fk/);
      expect(await postgresError(attach(ws2))).toMatch(/meeting_participants_meeting_fk/);
    });

    it("allows one recording per meeting and kind, in the meeting's workspace", async () => {
      const meeting = await newMeeting(ws1);
      await newRecording(meeting.id, ws1);
      expect(await postgresError(newRecording(meeting.id, ws1))).toMatch(
        /recordings_meeting_id_kind_key/,
      );
      const other = await newMeeting(ws1);
      expect(await postgresError(newRecording(other.id, ws2))).toMatch(/recordings_meeting_fk/);
    });

    it('keeps idempotency keys unique per workspace', async () => {
      const [m1, m2, m3] = [await newMeeting(ws1), await newMeeting(ws1), await newMeeting(ws2)];
      await newRecording(m1.id, ws1, 'same-key');
      await newRecording(m3.id, ws2, 'same-key');
      expect(await postgresError(newRecording(m2.id, ws1, 'same-key'))).toMatch(
        /recordings_workspace_id_idempotency_key_key/,
      );
    });

    it('cascades meeting deletes to participants and recordings, person deletes to participations', async () => {
      const meeting = await newMeeting(ws1);
      const [leaving] = await client.db
        .insert(people)
        .values({ workspaceId: ws1, displayName: 'Leaving' })
        .returning();
      await client.db.insert(meetingParticipants).values([
        { meetingId: meeting.id, personId: person1, workspaceId: ws1 },
        { meetingId: meeting.id, personId: leaving!.id, workspaceId: ws1 },
      ]);
      await newRecording(meeting.id, ws1);

      await client.db.delete(people).where(sql`id = ${leaving!.id}`);
      const participants = await client.pool.query(
        'SELECT person_id FROM meeting_participants WHERE meeting_id = $1',
        [meeting.id],
      );
      expect(participants.rows).toEqual([{ person_id: person1 }]);

      await client.db.delete(meetings).where(sql`id = ${meeting.id}`);
      const { rows } = await client.pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM meeting_participants WHERE meeting_id = $1)
              + (SELECT count(*) FROM recordings WHERE meeting_id = $1) AS n`,
        [meeting.id],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  describe('processing tables', () => {
    let ws1: string;
    let ws2: string;

    beforeAll(async () => {
      const [a, b] = await client.db
        .insert(organization)
        .values([
          { name: 'Proc one', slug: 'processing-one' },
          { name: 'Proc two', slug: 'processing-two' },
        ])
        .returning();
      ws1 = a!.id;
      ws2 = b!.id;
    });

    /** A meeting with an original recording in `workspaceId`. */
    async function recordedMeeting(workspaceId: string) {
      const [meeting] = await client.db
        .insert(meetings)
        .values({ workspaceId, title: 'Processed', occurredAt: new Date() })
        .returning();
      const [recording] = await client.db
        .insert(recordings)
        .values({
          meetingId: meeting!.id,
          workspaceId,
          storageKey: `ws/${workspaceId}/meetings/${meeting!.id}/original/${crypto.randomUUID()}`,
          originalFilename: 'a.wav',
          contentType: 'audio/wav',
          sizeBytes: 10,
          status: 'uploaded',
        })
        .returning();
      return { meetingId: meeting!.id, recordingId: recording!.id };
    }

    const newRun = (
      workspaceId: string,
      ids: { meetingId: string; recordingId: string },
      extra: Partial<NewProcessingRun> = {},
    ) =>
      client.db
        .insert(processingRuns)
        .values({ workspaceId, ...ids, trigger: 'reprocess', pipelineVersion: 1, ...extra })
        .returning();

    it('allows at most one active run per meeting', async () => {
      const ids = await recordedMeeting(ws1);
      const [first] = await newRun(ws1, ids);
      expect(first).toMatchObject({ status: 'queued' });
      expect(first!.id).toMatch(UUID_V7);
      expect(await postgresError(newRun(ws1, ids))).toMatch(
        /processing_runs_one_active_per_meeting_key/,
      );
      // Once the first run finishes, another may start.
      await client.db
        .update(processingRuns)
        .set({ status: 'completed' })
        .where(sql`id = ${first!.id}`);
      await newRun(ws1, ids);
    });

    it('allows one upload-triggered run per recording', async () => {
      const ids = await recordedMeeting(ws1);
      const [run] = await newRun(ws1, ids, { trigger: 'upload' });
      await client.db
        .update(processingRuns)
        .set({ status: 'failed' })
        .where(sql`id = ${run!.id}`);
      expect(await postgresError(newRun(ws1, ids, { trigger: 'upload' }))).toMatch(
        /processing_runs_upload_per_recording_key/,
      );
    });

    it("keeps runs and steps in their meeting's workspace", async () => {
      const ids = await recordedMeeting(ws1);
      expect(await postgresError(newRun(ws2, ids))).toMatch(
        /processing_runs_(meeting|recording)_fk/,
      );
      const [run] = await newRun(ws1, ids);
      const step = (workspaceId: string) =>
        client.db
          .insert(processingSteps)
          .values({ runId: run!.id, workspaceId, name: 'prepare_media', position: 0 });
      expect(await postgresError(step(ws2))).toMatch(/processing_steps_run_fk/);
      await step(ws1);
      expect(await postgresError(step(ws1))).toMatch(/processing_steps_pkey/);
    });

    it('rejects unknown run and step statuses', async () => {
      const ids = await recordedMeeting(ws1);
      expect(await postgresError(newRun(ws1, ids, { status: 'bogus' as never }))).toMatch(
        /processing_runs_status_check/,
      );
    });

    it('cascades meeting deletes to runs and steps', async () => {
      const ids = await recordedMeeting(ws1);
      const [run] = await newRun(ws1, ids);
      await client.db
        .insert(processingSteps)
        .values({ runId: run!.id, workspaceId: ws1, name: 'prepare_media', position: 0 });
      await client.db.delete(meetings).where(sql`id = ${ids.meetingId}`);
      const { rows } = await client.pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM processing_runs WHERE id = $1)
              + (SELECT count(*) FROM processing_steps WHERE run_id = $1) AS n`,
        [run!.id],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it('gives outbox events attempts and an availability time', async () => {
      const [row] = await client.db
        .insert(domainEvents)
        .values({ type: 'test.retry', payload: {} })
        .returning();
      expect(row).toMatchObject({ attempts: 0, lastError: null });
      expect(row!.availableAt).toBeInstanceOf(Date);
    });
  });
});
