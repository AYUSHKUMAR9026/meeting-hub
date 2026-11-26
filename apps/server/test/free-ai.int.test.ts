import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingDocumentResponse, TranscriptPage } from '@meeting-hub/contracts';
import {
  and,
  eq,
  meetings,
  recordings,
  roomSessions,
  roomAttendance,
  people,
  workspaceSettings,
  featureFlags,
  processingRuns,
  processingSteps,
  transcripts,
  transcriptSpeakers,
  transcriptionCheckpoints,
  auditLogs,
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
import { roomRecordingKey } from '../src/modules/media';
import { RedisQuotaLimiter } from '../src/lib/ai-quota';

function wav(seconds: number, amplitude = 0.25) {
  const samples = seconds * 16000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(amplitude * 32767 * Math.sin((i * 2 * Math.PI * 440) / 16000)),
      44 + i * 2,
    );
  return bytes;
}
const extraction = {
  summary: { paragraph: 'The agenda and next steps were agreed.', bullets: ['Review the agenda.'] },
  decisions: [
    { title: 'Review the agenda', description: 'Review it.', rationale: null, segment_idx: [0] },
  ],
  action_items: [
    {
      title: 'Share next steps',
      description: 'Share them.',
      owner_speaker: null,
      due_date: null,
      segment_idx: [0],
    },
  ],
};
interface Scenario {
  t: TestApp;
  worker: WorkerRuntime;
  owner: Session;
  guest: Session;
  workspaceId: string;
  meetingId: string;
  calls: { stt: number; gemini: number; groqLlm: number };
  ready(): Promise<void>;
}
async function scenario(
  options: {
    env?: Record<string, string>;
    enabled?: boolean;
    sttStatus?: number;
    quotaSecond?: boolean;
    geminiQuota?: boolean;
    invalidOnce?: boolean;
    silentGuest?: boolean;
  },
  work: (s: Scenario) => Promise<void>,
) {
  const prefix = 'free-ai-' + randomUUID();
  const calls = { stt: 0, gemini: 0, groqLlm: 0 };
  const actualFetch = globalThis.fetch;
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://api.groq.com/openai/v1/audio/transcriptions') {
      calls.stt++;
      expect(init?.headers).toHaveProperty('authorization');
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect(form.get('response_format')).toBe('verbose_json');
      const file = form.get('file') as File;
      expect(file.size).toBeLessThan(25000000);
      if (options.quotaSecond && calls.stt === 2)
        return Response.json(
          { error: { message: 'Audio seconds per day exceeded' } },
          { status: 429 },
        );
      if (options.sttStatus && (options.sttStatus !== 503 || calls.stt === 1))
        return Response.json(
          { error: { message: 'private media URL and content' } },
          { status: options.sttStatus, headers: { 'retry-after': '1' } },
        );
      return Response.json({
        language: 'en',
        words: [
          {
            word: calls.stt === 1 ? 'Review the agenda' : 'Share next steps',
            start: 0.2,
            end: 1.0,
          },
        ],
      });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      calls.gemini++;
      if (options.geminiQuota)
        return Response.json(
          { error: { message: 'GenerateRequestsPerDay quota exhausted' } },
          { status: 429, headers: { 'retry-after': '3600' } },
        );
      return Response.json({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  text:
                    options.invalidOnce && calls.gemini === 1
                      ? 'not-json'
                      : JSON.stringify(extraction),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100 },
      });
    }
    if (url === 'https://api.groq.com/openai/v1/chat/completions') {
      calls.groqLlm++;
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extraction) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      });
    }
    return actualFetch(input, init);
  });
  const env = {
    ROOM_PROVIDER: 'fake',
    TRANSCRIPTION_PROVIDER: 'groq',
    LLM_PROVIDER: 'gemini',
    GROQ_API_KEY: 'groq-fixture-' + randomUUID(),
    GEMINI_API_KEY: 'gemini-fixture-' + randomUUID(),
    GEMINI_RPM: '100',
    GEMINI_RPD: '1000',
    FEATURE_FLAGS_OVERRIDE:
      'workspaces.invitations=true,people.directory=true,meetings.upload=true,pipeline.media=true,transcription.enabled=true,analysis.enabled=true,transcription.per_track_speakers=true',
    ...options.env,
  };
  let t: TestApp | undefined;
  let worker: WorkerRuntime | undefined;
  let meetingId = '';
  try {
    t = await createTestApp(env, { queuePrefix: prefix });
    const db = t.deps.db.db;
    const owner = await createUser(t, 'FreeHost');
    const workspaceId = (await createWorkspace(t, owner, 'Free AI')).id;
    const guest = await createUser(t, 'FreeGuest');
    await addMember(t, workspaceId, owner, guest, 'member');
    await db
      .update(workspaceSettings)
      .set({ externalAiEnabled: options.enabled ?? true })
      .where(eq(workspaceSettings.workspaceId, workspaceId));
    for (const key of [
      'pipeline.media',
      'transcription.enabled',
      'analysis.enabled',
      'transcription.per_track_speakers',
    ])
      await db.insert(featureFlags).values({ workspaceId, key, enabled: true });
    const [meeting] = await db
      .insert(meetings)
      .values({
        resultPolicy: 'legacy',
        workspaceId,
        createdBy: owner.userId,
        title: 'Track processing',
        occurredAt: new Date(),
        source: 'live',
        roomStatus: 'ended',
        status: 'uploaded',
      })
      .returning();
    meetingId = meeting!.id;
    const [session] = await db
      .insert(roomSessions)
      .values({
        workspaceId,
        meetingId,
        startedBy: owner.userId,
        endedAt: new Date(),
        endReason: 'host_ended',
      })
      .returning();
    for (const [index, person] of [owner, guest].entries()) {
      const [linked] = await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.workspaceId, workspaceId), eq(people.userId, person.userId)));
      const [attendance] = await db
        .insert(roomAttendance)
        .values({
          workspaceId,
          meetingId,
          sessionId: session!.id,
          userId: person.userId,
          personId: linked!.id,
          consentAcknowledgedAt: new Date(),
          joinedAt: new Date(),
          leftAt: new Date(),
        })
        .returning();
      const storageKey = roomRecordingKey(workspaceId, meetingId, 'participant_track');
      const audio = wav(4, index === 1 && options.silentGuest ? 0 : 0.25);
      await t.deps.storage.uploadBuffer(storageKey, audio, { contentType: 'audio/wav' });
      await db.insert(recordings).values({
        workspaceId,
        meetingId,
        kind: 'participant_track',
        attendanceId: attendance!.id,
        startOffsetMs: index * 4000,
        storageKey,
        originalFilename: 'track.wav',
        contentType: 'audio/wav',
        sizeBytes: audio.length,
        status: 'uploaded',
      });
    }
    const storageKey = roomRecordingKey(workspaceId, meetingId, 'mixed_audio');
    const audio = wav(8);
    await t.deps.storage.uploadBuffer(storageKey, audio, { contentType: 'audio/wav' });
    const [mixed] = await db
      .insert(recordings)
      .values({
        workspaceId,
        meetingId,
        kind: 'mixed_audio',
        storageKey,
        originalFilename: 'mixed.wav',
        contentType: 'audio/wav',
        sizeBytes: audio.length,
        status: 'uploaded',
      })
      .returning();
    worker = await startWorkerRuntime(
      testConfig({ ...env, FEATURE_FLAGS_OVERRIDE: '' }),
      t.deps.logger,
      { queuePrefix: prefix, loops: false },
    );
    void mixed;
    await worker.processing.runs.requestReprocess(
      { workspaceId, userId: owner.userId, role: 'owner' },
      meetingId,
      undefined,
      {},
    );
    await work({
      t,
      worker,
      owner,
      guest,
      workspaceId,
      meetingId,
      calls,
      ready: async () => {
        await expect
          .poll(
            async () => {
              const [m] = await db
                .select({ status: meetings.status })
                .from(meetings)
                .where(eq(meetings.id, meetingId));
              return m?.status;
            },
            { timeout: 120000 },
          )
          .toBe('ready');
      },
    });
  } finally {
    if (worker && meetingId)
      await worker.processing.runs.cancelForMeeting(meetingId, 'meeting_deleted');
    await worker?.close();
    await t?.close();
    mock.mockRestore();
  }
}

describe('free providers with real storage, media, database and queues', () => {
  it(
    'publishes attendance-linked named speakers on the absolute timeline and cited analysis',
    () =>
      scenario({}, async (s) => {
        await s.ready();
        expect(s.calls).toEqual({ stt: 2, gemini: 1, groqLlm: 0 });
        const response = await call(s.t, s.owner, {
          method: 'GET',
          url: `/v1/meetings/${s.meetingId}/transcript`,
        });
        const page = response.json<TranscriptPage>();
        expect(page.speakers.map((p) => p.displayName).sort()).toEqual(['FreeGuest', 'FreeHost']);
        expect(page.transcript?.speakerSource).toBe('attendance');
        expect(page.segments.map((p) => p.startMs)).toEqual([200, 4200]);
        const roster = await s.t.deps.db.db
          .select()
          .from(transcriptSpeakers)
          .where(eq(transcriptSpeakers.transcriptId, page.transcript!.id));
        expect(roster.every((p) => p.userId && p.personId)).toBe(true);
        const doc = await call(s.t, s.owner, {
          method: 'GET',
          url: `/v1/meetings/${s.meetingId}/document`,
        });
        expect(doc.json<MeetingDocumentResponse>().document?.decisions[0]?.citations).toHaveLength(
          1,
        );
        const outsider = await createUser(s.t, 'AI-outsider');
        const denied = await call(s.t, outsider, {
          method: 'GET',
          url: `/v1/meetings/${s.meetingId}/transcript`,
        });
        expect(denied.statusCode).toBe(404);
        expect(JSON.stringify(s.t.logLines)).not.toMatch(
          /groq-fixture|gemini-fixture|private media URL|Review the agenda|Share next steps/,
        );
      }),
    150000,
  );
  it(
    'falls back to one mixed request before exceeding the speech quota',
    () =>
      scenario({ env: { TRANSCRIPTION_QUOTA_SECONDS_PER_HOUR: '14' } }, async (s) => {
        await s.ready();
        expect(s.calls.stt).toBe(1);
        const [row] = await s.t.deps.db.db
          .select()
          .from(transcripts)
          .where(eq(transcripts.meetingId, s.meetingId));
        expect(row).toMatchObject({
          speakerSource: 'generic',
          fallbackReason: 'free_quota_speaker_fallback',
        });
      }),
    150000,
  );
  it(
    'skips silent participant tracks',
    () =>
      scenario({ silentGuest: true }, async (s) => {
        await s.ready();
        expect(s.calls.stt).toBe(1);
      }),
    150000,
  );
  it(
    'blocks every external call while disabled and keeps normalized audio playable',
    () =>
      scenario({ enabled: false }, async (s) => {
        await expect
          .poll(
            async () => {
              const [r] = await s.t.deps.db.db
                .select()
                .from(processingRuns)
                .where(eq(processingRuns.meetingId, s.meetingId));
              return r?.errorCode;
            },
            { timeout: 60000 },
          )
          .toBe('EXTERNAL_AI_DISABLED');
        expect(s.calls).toEqual({ stt: 0, gemini: 0, groqLlm: 0 });
        const media = await call(s.t, s.owner, {
          method: 'GET',
          url: `/v1/meetings/${s.meetingId}/media`,
        });
        expect(media.statusCode).toBe(200);
      }),
    90000,
  );
  it(
    'allows only owner/admin toggles and audits the change',
    () =>
      scenario({ enabled: false }, async (s) => {
        const url = `/v1/workspaces/${s.workspaceId}`;
        const denied = await call(s.t, s.guest, {
          method: 'PATCH',
          url,
          payload: { settings: { externalAiEnabled: true } },
        });
        expect(denied.statusCode).toBe(403);
        const changed = await call(s.t, s.owner, {
          method: 'PATCH',
          url,
          payload: { settings: { externalAiEnabled: true } },
        });
        expect(changed.statusCode).toBe(200);
        const audit = await s.t.deps.db.db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.workspaceId, s.workspaceId),
              eq(auditLogs.action, 'workspace.external_ai_toggled'),
            ),
          );
        expect(audit).toHaveLength(1);
        expect(audit[0]!.metadata).toEqual({ enabled: true });
      }),
    90000,
  );
  it(
    'persists quota waits and reuses completed chunks after resume',
    () =>
      scenario({ quotaSecond: true }, async (s) => {
        const db = s.t.deps.db.db;
        await expect
          .poll(
            async () => {
              const [row] = await db
                .select()
                .from(processingSteps)
                .where(
                  and(
                    eq(processingSteps.workspaceId, s.workspaceId),
                    eq(processingSteps.name, 'transcribe'),
                  ),
                );
              return row?.errorCode;
            },
            { timeout: 60000 },
          )
          .toBe('FREE_QUOTA_WAIT');
        const [step] = await db
          .select()
          .from(processingSteps)
          .where(
            and(
              eq(processingSteps.workspaceId, s.workspaceId),
              eq(processingSteps.name, 'transcribe'),
            ),
          );
        expect(Number(step!.metadata.retryAt)).toBeGreaterThan(Date.now() + 3600000);
        expect(s.calls.stt).toBe(2);
        const checkpoints = await db
          .select()
          .from(transcriptionCheckpoints)
          .where(eq(transcriptionCheckpoints.runId, step!.runId));
        expect(checkpoints.length).toBeGreaterThanOrEqual(2);
        const early = await s.worker.processing.driver.processJob({
          runId: step!.runId,
          step: 'transcribe',
        });
        expect(early).toHaveProperty('delayMs');
        expect(s.calls.stt).toBe(2);
        await db
          .update(processingSteps)
          .set({ metadata: { ...step!.metadata, retryAt: 0 } })
          .where(
            and(eq(processingSteps.runId, step!.runId), eq(processingSteps.name, 'transcribe')),
          );
        await s.worker.processing.driver.processJob({ runId: step!.runId, step: 'transcribe' });
        await s.ready();
        expect(s.calls.stt).toBe(3);
      }),
    150000,
  );
  it(
    'honors a retryable 503 and completes after recovery',
    () =>
      scenario({ sttStatus: 503 }, async (s) => {
        await s.ready();
        expect(s.calls.stt).toBe(3);
      }),
    150000,
  );
  it.each([401, 413])(
    'fails HTTP %s permanently with sanitized errors',
    (status) =>
      scenario({ sttStatus: status }, async (s) => {
        await expect
          .poll(
            async () => {
              const [r] = await s.t.deps.db.db
                .select()
                .from(processingRuns)
                .where(eq(processingRuns.meetingId, s.meetingId));
              return r?.status;
            },
            { timeout: 60000 },
          )
          .toBe('failed');
        expect(s.calls.stt).toBe(1);
        expect(JSON.stringify(s.t.logLines)).not.toContain('private media URL');
      }),
    90000,
  );
  it(
    'uses the free alternative when Gemini quota is exhausted',
    () =>
      scenario({ geminiQuota: true, env: { LLM_FALLBACK_PROVIDER: 'groq' } }, async (s) => {
        await s.ready();
        expect(s.calls.gemini).toBe(1);
        expect(s.calls.groqLlm).toBe(1);
      }),
    150000,
  );
  it(
    'marks corrected structured extraction as low confidence',
    () =>
      scenario({ invalidOnce: true }, async (s) => {
        await s.ready();
        const doc = await call(s.t, s.owner, {
          method: 'GET',
          url: `/v1/meetings/${s.meetingId}/document`,
        });
        const document = doc.json<MeetingDocumentResponse>().document!;
        expect(document.lowConfidence).toBe(true);
        expect(document.decisions[0]!.lowConfidence).toBe(true);
        expect(s.calls.gemini).toBe(2);
      }),
    150000,
  );
  it(
    'blocks analysis after external AI consent is revoked',
    () =>
      scenario({}, async (s) => {
        await s.ready();
        await s.t.deps.db.db
          .update(workspaceSettings)
          .set({ externalAiEnabled: false })
          .where(eq(workspaceSettings.workspaceId, s.workspaceId));
        const retried = await s.worker.processing.runs.requestReprocess(
          { workspaceId: s.workspaceId, userId: s.owner.userId, role: 'owner' },
          s.meetingId,
          'analyze',
          {},
        );
        await expect
          .poll(
            async () => {
              const [run] = await s.t.deps.db.db
                .select()
                .from(processingRuns)
                .where(eq(processingRuns.id, retried.run!.id));
              return run?.errorCode;
            },
            { timeout: 60000 },
          )
          .toBe('EXTERNAL_AI_DISABLED');
        expect(s.calls).toEqual({ stt: 2, gemini: 1, groqLlm: 0 });
      }),
    150000,
  );
  it(
    'nulls deleted directory links without dropping tenant scope or speaker names',
    () =>
      scenario({}, async (s) => {
        await s.ready();
        const db = s.t.deps.db.db;
        const [speaker] = await db
          .select()
          .from(transcriptSpeakers)
          .where(
            and(
              eq(transcriptSpeakers.workspaceId, s.workspaceId),
              eq(transcriptSpeakers.userId, s.guest.userId),
            ),
          );
        await db
          .delete(people)
          .where(and(eq(people.id, speaker!.personId!), eq(people.workspaceId, s.workspaceId)));
        const [remaining] = await db
          .select()
          .from(transcriptSpeakers)
          .where(eq(transcriptSpeakers.id, speaker!.id));
        expect(remaining).toMatchObject({
          workspaceId: s.workspaceId,
          personId: null,
          userId: s.guest.userId,
          displayName: 'FreeGuest',
        });
      }),
    150000,
  );
  it('serializes shared reservations across concurrent workers and checks every bucket atomically', async () => {
    const t = await createTestApp();
    try {
      const limiter = new RedisQuotaLimiter(
        t.deps.redis,
        'reservation-' + randomUUID(),
        'shared-key',
      );
      const bucket = { name: 'minute', capacity: 1, windowMs: 10000, cost: 1 };
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => limiter.reserve([bucket])),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(
        limiter.reserve([bucket, { name: 'uncharged', capacity: 1, windowMs: 10000, cost: 1 }]),
      ).rejects.toMatchObject({ code: 'FREE_QUOTA_WAIT' });
      await expect(
        limiter.reserve([{ name: 'uncharged', capacity: 1, windowMs: 10000, cost: 1 }]),
      ).resolves.toBeUndefined();
    } finally {
      await t.close();
    }
  });
});
