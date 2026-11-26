import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  featureFlags,
  meetings,
  recordings,
  transcripts,
  transcriptSegments,
  workspaceSettings,
} from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { temporaryMeetingPrefix } from '../src/modules/media';
import {
  call,
  createTestApp,
  createUser,
  createWorkspace,
  testConfig,
  type Session,
  type TestApp,
} from './support/harness';
import { FakeProvider } from '../src/modules/transcription';
import { ProviderRetryError } from '../src/lib/ai-quota';
import { startWorkerRuntime } from '../src/worker-runtime';
import { uploadRecording } from './support/meetings';
import { waitForProcessing } from './support/processing';
import { reviewFixture } from './support/review-fixture';

let t: TestApp;
let owner: Session;
let workspaceId: string;
const actor = () => ({ workspaceId, userId: owner.userId, role: 'owner' as const });
beforeAll(async () => {
  t = await createTestApp({
    FEATURE_FLAGS_OVERRIDE:
      'rooms.enabled=true,transcription.per_track_speakers=true,workspaces.invitations=true,people.directory=true,meetings.upload=true,pipeline.media=true,transcription.enabled=true,analysis.enabled=true,exports.enabled=true,review.enabled=true',
  });
  owner = await createUser(t, 'result-owner');
  workspaceId = (await createWorkspace(t, owner, 'Saved results')).id;
});
afterAll(async () => {
  await t.close();
});

async function fixture() {
  const f = await reviewFixture(t, workspaceId, owner.userId);
  await t.deps.db.db
    .update(meetings)
    .set({ resultPolicy: 'temporary', pdfDirtyAt: new Date(0) })
    .where(eq(meetings.id, f.meetingId));
  const key = temporaryMeetingPrefix(workspaceId, f.meetingId) + 'original/test';
  await t.deps.storage.uploadBuffer(key, Buffer.from('temporary audio'), {
    contentType: 'audio/wav',
  });
  await t.deps.db.db
    .update(recordings)
    .set({ storageKey: key })
    .where(eq(recordings.meetingId, f.meetingId));
  return f;
}

describe('PDF result and retention', () => {
  it('verifies a saved PDF, purges all audio and transcript text, preserves citations and supports edits', async () => {
    const f = await fixture();
    await t.deps.results.settle(workspaceId, f.meetingId);
    const result = await t.deps.results.view(actor(), f.meetingId);
    expect(result.state).toBe('ready');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.meetingDateTime).toContain('22 November 2026');
    expect(await t.deps.storage.listKeys(temporaryMeetingPrefix(workspaceId, f.meetingId))).toEqual(
      [],
    );
    const rows = await t.deps.db.db
      .select()
      .from(recordings)
      .where(eq(recordings.meetingId, f.meetingId));
    expect(
      rows.every((r) => r.purgedAt && r.storageKey === '' && r.purgeReason === 'transcribed'),
    ).toBe(true);
    expect(
      await t.deps.db.db
        .select()
        .from(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, f.transcriptId)),
    ).toEqual([]);
    expect(
      await t.deps.db.db.select().from(transcripts).where(eq(transcripts.meetingId, f.meetingId)),
    ).toEqual([]);
    const pdf = await call(t, owner, { method: 'GET', url: `/v1/meetings/${f.meetingId}/pdf` });
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await t.deps.documents.read(actor(), f.meetingId);
    expect(doc.document?.decisions[0]?.citations[0]).toMatchObject({
      startMs: 1234,
      speaker: 'Alex & Co.',
    });
    const edited = await call(t, owner, {
      method: 'PATCH',
      url: `/v1/meetings/${f.meetingId}/decisions/${f.decisionId}`,
      payload: { status: 'confirmed' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    await t.deps.results.settle(workspaceId, f.meetingId, new Date(Date.now() + 6000));
    expect((await t.deps.results.view(actor(), f.meetingId)).files).toHaveLength(2);
    const old = await call(t, owner, {
      method: 'GET',
      url: `/v1/meetings/${f.meetingId}/pdf?fileId=${result.files[0]!.id}`,
    });
    expect(old.statusCode).toBe(200);
    for (const path of ['media', 'recording', 'transcript', 'transcript/export?format=txt']) {
      const r = await call(t, owner, { method: 'GET', url: `/v1/meetings/${f.meetingId}/${path}` });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('keeps transcript text when PDF storage fails; retry purges only after success', async () => {
    const f = await fixture();
    const failure = vi
      .spyOn(t.deps.storage, 'uploadBuffer')
      .mockRejectedValueOnce(new Error('private text must not escape'));
    await t.deps.results.settle(workspaceId, f.meetingId);
    failure.mockRestore();
    expect((await t.deps.results.view(actor(), f.meetingId)).state).toBe('failed');
    expect(
      await t.deps.db.db
        .select()
        .from(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, f.transcriptId)),
    ).toHaveLength(1);
    await t.deps.results.retry(actor(), f.meetingId);
    await t.deps.results.settle(workspaceId, f.meetingId);
    expect((await t.deps.results.view(actor(), f.meetingId)).state).toBe('ready');
    expect(JSON.stringify(t.logLines)).not.toContain('private text must not escape');
  });

  it('retains transcripts in keep_transcript mode while always purging audio', async () => {
    await t.deps.db.db
      .update(workspaceSettings)
      .set({ contentRetention: 'keep_transcript' })
      .where(eq(workspaceSettings.workspaceId, workspaceId));
    const f = await fixture();
    await t.deps.results.settle(workspaceId, f.meetingId);
    expect((await t.deps.results.view(actor(), f.meetingId)).transcriptPurged).toBe(false);
    expect(
      await t.deps.db.db
        .select()
        .from(transcriptSegments)
        .where(eq(transcriptSegments.transcriptId, f.transcriptId)),
    ).toHaveLength(1);
    expect(await t.deps.storage.listKeys(temporaryMeetingPrefix(workspaceId, f.meetingId))).toEqual(
      [],
    );
    await t.deps.db.db
      .update(workspaceSettings)
      .set({ contentRetention: 'pdf_only' })
      .where(eq(workspaceSettings.workspaceId, workspaceId));
  });

  it('requires owner preview and exact confirmation, and isolates workspaces', async () => {
    const other = await createWorkspace(t, owner, 'Other saved results');
    const f = await reviewFixture(t, other.id, owner.userId);
    const preview = await t.deps.results.purge(actor(), { kind: 'recordings', dryRun: true });
    await expect(
      t.deps.results.purge(actor(), { kind: 'recordings', dryRun: false, confirmation: 'yes' }),
    ).rejects.toMatchObject({ code: 'PURGE_CONFIRMATION_REQUIRED' });
    await expect(
      t.deps.results.purge({ ...actor(), role: 'admin' }, { kind: 'recordings', dryRun: true }),
    ).rejects.toMatchObject({ status: 403 });
    await t.deps.results.purge(actor(), {
      kind: 'recordings',
      dryRun: false,
      confirmation: 'PURGE RECORDINGS',
      expectedCount: preview.count,
      expectedBytes: preview.bytes,
    });
    const [untouched] = await t.deps.db.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.workspaceId, other.id), eq(recordings.meetingId, f.meetingId)));
    expect(untouched?.purgedAt).toBeNull();
    const cross = await call(t, owner, {
      method: 'GET',
      url: `/v1/meetings/${f.meetingId}/pdf?fileId=00000000-0000-4000-8000-000000000000`,
    });
    expect(cross.statusCode).toBe(404);
  });

  it('keeps temporary input on a deferred run, then expires it at the hard TTL', async () => {
    const created = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/meetings`,
      payload: { title: 'Deferred audio', occurredAt: new Date().toISOString() },
    });
    const id = created.json<{ id: string }>().id;
    const key = temporaryMeetingPrefix(workspaceId, id) + 'original/deferred';
    await t.deps.storage.uploadBuffer(key, Buffer.from('deferred input'), {
      contentType: 'audio/wav',
    });
    await t.deps.db.db.insert(recordings).values({
      workspaceId,
      meetingId: id,
      storageKey: key,
      originalFilename: 'input.wav',
      contentType: 'audio/wav',
      sizeBytes: 14,
      status: 'uploaded',
    });
    await t.deps.results.settle(workspaceId, id);
    expect(await t.deps.storage.headObject(key)).not.toBeNull();
    await t.deps.results.settle(workspaceId, id, new Date(Date.now() + 49 * 3600000));
    expect(await t.deps.storage.headObject(key)).toBeNull();
    const [recording] = await t.deps.db.db
      .select()
      .from(recordings)
      .where(eq(recordings.meetingId, id));
    expect(recording?.purgeReason).toBe('expired');
  });

  it('reports readiness flag and external-AI reasons without exposing secrets', async () => {
    const disabled = await createTestApp({
      FEATURE_FLAGS_OVERRIDE:
        'rooms.enabled=false,transcription.enabled=true,analysis.enabled=true',
      TRANSCRIPTION_PROVIDER: 'groq',
      GROQ_API_KEY: 'readiness-secret',
    });
    try {
      const r = await call(disabled, owner, {
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/readiness`,
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(
        r.json<{ features: { name: string; state: string; reason: string }[] }>().features,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Rooms',
            state: 'off',
            reason: 'Feature flag rooms.enabled is off.',
          }),
          expect.objectContaining({
            name: 'Transcription',
            state: 'misconfigured',
            reason: 'Allow external AI processing is off.',
          }),
        ]),
      );
      expect(r.body).not.toContain('readiness-secret');
    } finally {
      await disabled.close();
    }
  });
});

it('invitation acceptance links meeting participants, then fake live rooms and an upload both produce PDFs only', async () => {
  const project = await createWorkspace(t, owner, 'Complete flow');
  for (const key of [
    'pipeline.media',
    'transcription.enabled',
    'analysis.enabled',
    'transcription.per_track_speakers',
  ])
    await t.deps.db.db.insert(featureFlags).values({ workspaceId: project.id, key, enabled: true });
  const provider = new FakeProvider();
  const worker = await startWorkerRuntime(
    testConfig({ FEATURE_FLAGS_OVERRIDE: '' }),
    t.deps.logger,
    { provider, loops: false, queuePrefix: 'pdf-flow-' + randomUUID() },
  );
  try {
    const created = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${project.id}/meetings`,
      payload: { title: 'Live planning', mode: 'schedule', occurredAt: '2026-11-26T09:30:00Z' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const meetingId = created.json<{ id: string }>().id;
    const guest = await createUser(t, 'pdf-guest');
    const invite = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${project.id}/invitations`,
      payload: { email: guest.email, role: 'member', meetingIds: [meetingId] },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const details = await call(t, guest, {
      method: 'GET',
      url: `/v1/invitations/${invite.json<{ id: string }>().id}`,
    });
    expect(details.json<{ meetings: { title: string }[] }>().meetings[0]?.title).toBe(
      'Live planning',
    );
    const accepted = await call(t, guest, {
      method: 'POST',
      url: `/v1/invitations/${invite.json<{ id: string }>().id}/accept`,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const hostActor = { ...actor(), workspaceId: project.id };
    await t.deps.rooms.start(hostActor, meetingId, true);
    await t.deps.rooms.join(hostActor, meetingId, true);
    await t.deps.rooms.join(
      { workspaceId: project.id, userId: guest.userId, role: 'member' },
      meetingId,
      true,
    );
    const message = { clientId: 'test-chat', text: 'Agenda shared' };
    await t.deps.rooms.saveMessage(hostActor, meetingId, message);
    await t.deps.rooms.saveMessage(hostActor, meetingId, message);
    await t.deps.rooms.end(hostActor, meetingId);
    expect((await t.deps.rooms.messages(hostActor, meetingId)).messages).toHaveLength(1);
    const source = await t.deps.db.db
      .select()
      .from(recordings)
      .where(eq(recordings.meetingId, meetingId));
    expect(source.filter((r) => r.kind === 'mixed_audio')).toHaveLength(0);
    expect(source.filter((r) => r.kind === 'participant_track')).toHaveLength(2);
    await worker.dispatcher.pollOnce();
    await waitForProcessing(t, owner, meetingId, (r) => r.run?.status === 'completed');
    await t.deps.results.settle(project.id, meetingId, new Date(Date.now() + 6000));
    expect((await t.deps.results.view(hostActor, meetingId)).state).toBe('ready');
    expect(await t.deps.storage.listKeys(temporaryMeetingPrefix(project.id, meetingId))).toEqual(
      [],
    );
    const upload = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${project.id}/meetings`,
      payload: { title: 'Uploaded planning', occurredAt: new Date().toISOString() },
    });
    const uploadId = upload.json<{ id: string }>().id;
    const wav = Buffer.alloc(44 + 64000);
    wav.write('RIFF');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(64000, 40);
    vi.spyOn(provider, 'submit').mockRejectedValueOnce(new ProviderRetryError(5000, true));
    await uploadRecording(t, owner, uploadId, wav, {
      fileName: 'input.wav',
      contentType: 'audio/wav',
    });
    await worker.dispatcher.pollOnce();
    await waitForProcessing(t, owner, uploadId, (r) =>
      Boolean(
        r.run?.steps.some(
          (step) => step.name === 'transcribe' && step.status === 'waiting_external',
        ),
      ),
    );
    await t.deps.results.settle(project.id, uploadId);
    expect(
      (await t.deps.storage.listKeys(temporaryMeetingPrefix(project.id, uploadId))).length,
    ).toBeGreaterThan(0);
    await waitForProcessing(t, owner, uploadId, (r) => r.run?.status === 'completed');
    await t.deps.results.settle(project.id, uploadId, new Date(Date.now() + 6000));
    expect((await t.deps.results.view(hostActor, uploadId)).state).toBe('ready');
    expect(await t.deps.storage.listKeys(temporaryMeetingPrefix(project.id, uploadId))).toEqual([]);
  } finally {
    await worker.close();
  }
});
