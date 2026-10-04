/**
 * The processing pipeline end to end (ADR 0004) with real Postgres, Redis, S3 (Garage) and the real
 * ffmpeg: uploads go through the API like a browser, the worker runtime processes them.
 *
 * Isolation from other test files: this file's API and worker use their own BullMQ prefix, and
 * the worker's dispatcher only handles workspaces that have a `pipeline.media` flag row (it has no
 * env override), so other files' outbox events are left alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  and,
  auditLogs,
  domainEvents,
  eq,
  meetings,
  processingRuns,
  processingSteps,
  recordings,
  sql,
} from '@meeting-hub/db';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createStepQueue } from '../src/jobs/step-queue';
import { listJobDirs, meetingPrefix, MAX_PEAK_POINTS } from '../src/modules/media';
import { getStep } from '../src/modules/processing';
import { startWorkerRuntime, type WorkerRuntime } from '../src/worker-runtime';
import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
  testConfig,
  testEnv,
} from './support/harness';
import {
  type Fixture,
  type FixtureName,
  generateFixtures,
  probeAudio,
  writeDisguisedPlaylist,
} from './support/media-fixtures';
import {
  enablePipeline,
  finished,
  getProcessing,
  killHard,
  spawnWorkerProcess,
  uploadFixture,
  waitForProcessing,
} from './support/processing';

const PREFIX = `proc-${randomUUID().slice(0, 8)}`;
/** Just over the default 3-hour limit. */
const TOO_LONG_SECONDS = 3 * 3600 + 5;

let t: TestApp;
let worker: WorkerRuntime;
let fixtures: Record<FixtureName, Fixture>;
let fixturesDir: string;
let mediaTmp: string;
let workerEnv: Record<string, string>;
let owner: Session;
let viewer: Session;
let outsider: Session;
/** Pipeline on. */
let ws: string;

const db = () => t.deps.db.db;

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const recordingsOf = async (meetingId: string) =>
  db().select().from(recordings).where(eq(recordings.meetingId, meetingId));

const runsOf = (meetingId: string) =>
  db().select().from(processingRuns).where(eq(processingRuns.meetingId, meetingId));

const keysUnder = (prefix: string) => t.deps.storage.listKeys(prefix);

/** Objects processing produced for a meeting (normalized audio and peaks). */
const outputKeys = async (meetingId: string) => {
  const prefix = meetingPrefix(ws, meetingId);
  return [...(await keysUnder(`${prefix}normalized/`)), ...(await keysUnder(`${prefix}peaks/`))];
};

/** A workspace whose pipeline flag is off (uploads stay unprocessed until it is turned on). */
async function heldWorkspace(name: string) {
  return (await createWorkspace(t, owner, name)).id;
}

beforeAll(async () => {
  fixturesDir = mkdtempSync(join(tmpdir(), 'mh-fixtures-'));
  mediaTmp = mkdtempSync(join(tmpdir(), 'mh-media-'));
  fixtures = generateFixtures(fixturesDir, TOO_LONG_SECONDS);

  t = await createTestApp({ SSE_HEARTBEAT_MS: '300' }, { queuePrefix: PREFIX });
  workerEnv = testEnv({
    MEDIA_TMP_DIR: mediaTmp,
    // No pipeline.media override: only workspaces with a flag row are processed.
    FEATURE_FLAGS_OVERRIDE: 'platform.heartbeat=false',
    OUTBOX_POLL_INTERVAL_MS: '200',
    PROCESSING_SWEEP_INTERVAL_MS: '3600000',
    MEDIA_CONCURRENCY: '2',
  });
  worker = await startWorkerRuntime(testConfig(workerEnv), pino({ level: 'warn' }), {
    queuePrefix: PREFIX,
    driver: { cancelPollMs: 200 },
  });

  owner = await createUser(t, 'proc-owner');
  ws = (await createWorkspace(t, owner, 'Processing')).id;
  viewer = await createUser(t, 'proc-viewer');
  await addMember(t, ws, owner, viewer, 'viewer');
  outsider = await createUser(t, 'proc-outsider');
  await createWorkspace(t, outsider, 'Elsewhere');
  await enablePipeline(t, ws);
}, 600_000);

afterAll(async () => {
  await worker?.close();
  await t?.close();
  rmSync(fixturesDir, { recursive: true, force: true });
  rmSync(mediaTmp, { recursive: true, force: true });
});

describe('prepare_media happy path', () => {
  it.each(['videoMp4', 'audioM4a', 'audioWav'] as const)(
    '%s → normalized mono 16 kHz audio, peaks, duration and checksum',
    async (name) => {
      const fixture = fixtures[name];
      const meetingId = await uploadFixture(t, owner, ws, fixture);
      const body = await waitForProcessing(t, owner, meetingId, finished);

      expect(body.meetingStatus).toBe('ready');
      expect(body.run).toMatchObject({ status: 'completed', trigger: 'upload', progress: 1 });
      expect(body.run!.steps).toEqual([
        expect.objectContaining({ name: 'prepare_media', status: 'succeeded', attempts: 1 }),
      ]);
      const runId = body.run!.id;

      const rows = await recordingsOf(meetingId);
      const original = rows.find((r) => r.kind === 'original')!;
      const normalized = rows.find((r) => r.kind === 'normalized')!;
      expect(original.sha256).toBe(sha256(fixture.path));
      expect(original.durationMs).toBeGreaterThan(fixture.seconds! * 1000 - 150);
      expect(original.durationMs).toBeLessThan(fixture.seconds! * 1000 + 150);
      expect(original.codec).toBeTruthy();
      expect(normalized).toMatchObject({
        status: 'uploaded',
        contentType: 'audio/mp4',
        codec: 'aac',
        sampleRate: 16_000,
        channels: 1,
        storageKey: `${meetingPrefix(ws, meetingId)}normalized/${runId}`,
        peaksStorageKey: `${meetingPrefix(ws, meetingId)}peaks/${runId}`,
      });
      expect(normalized.sha256).toMatch(/^[0-9a-f]{64}$/);
      const [meeting] = await db().select().from(meetings).where(eq(meetings.id, meetingId));
      expect(meeting!.durationMs).toBe(original.durationMs);

      // Any member can fetch the processed audio and peaks with the signed URLs.
      const media = await call(t, viewer, {
        method: 'GET',
        url: `/v1/meetings/${meetingId}/media`,
      });
      expect(media.statusCode, media.body).toBe(200);
      const { audio, peaks } = media.json<{ audio: { url: string }; peaks: { url: string } }>();
      const audioRes = await fetch(audio.url);
      expect(audioRes.status).toBe(200);
      expect(audioRes.headers.get('content-type')).toBe('audio/mp4');
      const downloaded = join(fixturesDir, `${runId}.m4a`);
      writeFileSync(downloaded, Buffer.from(await audioRes.arrayBuffer()));
      const probed = probeAudio(downloaded);
      expect(probed).toMatchObject({ codec: 'aac', sampleRate: 16_000, channels: 1 });
      expect(Math.abs(probed.durationSeconds - fixture.seconds!)).toBeLessThan(0.2);

      const peaksJson = (await (await fetch(peaks.url)).json()) as {
        bits: number;
        length: number;
        data: number[];
      };
      expect(peaksJson.bits).toBe(8);
      expect(peaksJson.length).toBeGreaterThan(0);
      expect(peaksJson.length).toBeLessThanOrEqual(MAX_PEAK_POINTS);
      expect(peaksJson.data).toHaveLength(peaksJson.length * 2);

      expect(await listJobDirs(mediaTmp)).toEqual([]);
    },
  );
});

describe('invalid files', () => {
  /** Uploads through the API; `replaceWith` swaps the stored bytes before processing starts. */
  async function uploadHeld(fixture: Fixture, replaceWith?: Buffer) {
    const held = await heldWorkspace(`Held ${fixture.fileName}`);
    const meetingId = await uploadFixture(
      t,
      owner,
      held,
      replaceWith ? { ...fixture, path: fixtures.audioWav.path } : fixture,
    );
    if (replaceWith) {
      const [original] = (await recordingsOf(meetingId)).filter((r) => r.kind === 'original');
      await t.deps.s3.send(
        new PutObjectCommand({
          Bucket: t.deps.config.S3_BUCKET,
          Key: original!.storageKey,
          Body: replaceWith,
        }),
      );
    }
    await enablePipeline(t, held);
    return { meetingId, workspaceId: held };
  }

  it.each([
    ['empty', 'UNREADABLE_MEDIA'],
    ['truncatedMp4', 'UNREADABLE_MEDIA'],
    ['textAsMp3', 'UNREADABLE_MEDIA'],
    ['noAudioMp4', 'NO_AUDIO_STREAM'],
    ['tooShortWav', 'MEDIA_TOO_SHORT'],
    ['tooLongMp3', 'MEDIA_TOO_LONG'],
  ] as const)('%s fails with %s, cleanly', async (name, code) => {
    const fixture = fixtures[name];
    // The API refuses zero-byte uploads, so the empty case replaces a stored file's bytes.
    const { meetingId, workspaceId } =
      name === 'empty' ? await uploadHeld(fixture, Buffer.alloc(0)) : await uploadHeld(fixture);
    const body = await waitForProcessing(t, owner, meetingId, finished, 120_000);

    expect(body.meetingStatus).toBe('failed');
    expect(body.run).toMatchObject({ status: 'failed', errorCode: code });
    expect(body.run!.errorMessage).toEqual(expect.any(String));
    const [step] = body.run!.steps;
    expect(step).toMatchObject({ status: 'failed', errorCode: code, attempts: 1 });
    // The user-safe message never leaks paths or tool output; the owner sees the detail.
    expect(step!.errorMessage).not.toMatch(/ffmpeg|ffprobe|file:|[\\/]tmp|meeting-hub-job/i);
    expect(step!.errorDetail).toEqual(expect.any(String));
    expect(step!.errorDetail).not.toContain(mediaTmp);

    const asViewer = await addViewerAndGet(workspaceId, meetingId);
    expect(asViewer.run!.steps[0]).not.toHaveProperty('errorDetail');

    expect(await listJobDirs(mediaTmp)).toEqual([]);
    const prefix = meetingPrefix(workspaceId, meetingId);
    expect([
      ...(await keysUnder(`${prefix}normalized/`)),
      ...(await keysUnder(`${prefix}peaks/`)),
    ]).toEqual([]);
  });

  /** Adds `viewer` to the workspace (if needed) and reads the meeting's processing as them. */
  async function addViewerAndGet(workspaceId: string, meetingId: string) {
    const membership = await call(t, viewer, {
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}`,
    });
    if (membership.statusCode === 404) await addMember(t, workspaceId, owner, viewer, 'viewer');
    return getProcessing(t, viewer, meetingId);
  }

  it('never fetches anything for an HLS playlist disguised as audio', async () => {
    let hits = 0;
    const server: Server = createServer((_req, res) => {
      hits += 1;
      res.end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const playlist = writeDisguisedPlaylist(fixturesDir, `http://127.0.0.1:${port}`);
      const meetingId = await uploadFixture(t, owner, ws, playlist);
      const body = await waitForProcessing(t, owner, meetingId, finished);
      expect(body.run).toMatchObject({ status: 'failed', errorCode: 'UNREADABLE_MEDIA' });
      await new Promise((r) => setTimeout(r, 500));
      expect(hits).toBe(0);
      expect(await listJobDirs(mediaTmp)).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('idempotency and recovery', () => {
  it('handles the same recording.uploaded event twice with exactly one run', async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.audioWav);
    await waitForProcessing(t, owner, meetingId, finished);
    const [event] = await db()
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'recording.uploaded'),
          sql`${domainEvents.payload}->>'meetingId' = ${meetingId}`,
        ),
      );
    const [duplicate] = await db()
      .insert(domainEvents)
      .values({ type: event!.type, payload: event!.payload })
      .returning();
    await worker.dispatcher.pollOnce();
    await vi.waitFor(async () => {
      const [row] = await db()
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.id, duplicate!.id));
      expect(row!.processedAt).not.toBeNull();
    });
    expect(await runsOf(meetingId)).toHaveLength(1);
  });

  it('the sweeper enqueues a step whose enqueue was lost after the commit', async () => {
    const held = await heldWorkspace('Lost enqueue');
    const meetingId = await uploadFixture(t, owner, held, fixtures.audioM4a);
    const [original] = (await recordingsOf(meetingId)).filter((r) => r.kind === 'original');
    // The dispatcher's commit, without the enqueue that should follow it.
    await db().transaction((tx) =>
      worker.processing.repo.createRun(
        tx,
        {
          workspaceId: held,
          meetingId,
          recordingId: original!.id,
          trigger: 'upload',
          pipelineVersion: 1,
          requestedBy: null,
        },
        new Date(),
      ),
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await getProcessing(t, owner, meetingId)).run).toMatchObject({ status: 'queued' });

    const swept = await worker.processing.sweeper.sweep();
    expect(swept.enqueued).toBeGreaterThanOrEqual(1);
    const body = await waitForProcessing(t, owner, meetingId, finished);
    expect(body.run).toMatchObject({ status: 'completed' });
  });

  it('a worker killed mid-step is recovered after restart, with no duplicate rows or objects', async () => {
    const killPrefix = `${PREFIX}-kill`;
    const fast = { lockDuration: 3_000, stalledInterval: 1_000, maxStalledCount: 5 };
    const held = await heldWorkspace('Killed worker');
    const meetingId = await uploadFixture(t, owner, held, fixtures.longerMp3);
    const [original] = (await recordingsOf(meetingId)).filter((r) => r.kind === 'original');
    const created = await db().transaction((tx) =>
      worker.processing.repo.createRun(
        tx,
        {
          workspaceId: held,
          meetingId,
          recordingId: original!.id,
          trigger: 'upload',
          pipelineVersion: 1,
          requestedBy: null,
        },
        new Date(),
      ),
    );
    if (!('run' in created)) throw new Error('run not created');
    const runId = created.run.id;

    // Worker A, in its own process, takes the job; kill it while ffmpeg is working.
    const child = await spawnWorkerProcess(workerEnv, {
      queuePrefix: killPrefix,
      loops: false,
      workerSettings: fast,
    });
    const queue = createStepQueue({
      redisUrl: t.deps.config.REDIS_URL,
      prefix: killPrefix,
      onError: () => {},
    });
    try {
      await queue.ensure(
        { runId, step: 'prepare_media' },
        getStep(worker.processing.registry, 'prepare_media'),
      );
      await vi.waitFor(
        async () => {
          const [step] = await db()
            .select()
            .from(processingSteps)
            .where(eq(processingSteps.runId, runId));
          expect(step!.status).toBe('running');
          expect(step!.metadata.phase).toBe('transcoding');
        },
        { timeout: 60_000, interval: 100 },
      );
      await killHard(child);
      const [stuck] = await db()
        .select()
        .from(processingSteps)
        .where(eq(processingSteps.runId, runId));
      expect(stuck).toMatchObject({ status: 'running', attempts: 1 });
      // Give the orphaned ffmpeg a moment to notice its reader is gone.
      await new Promise((r) => setTimeout(r, 1_000));

      // Worker B starts on the same queue: it clears A's temp directory and takes over the job.
      const restarted = await startWorkerRuntime(testConfig(workerEnv), pino({ level: 'warn' }), {
        queuePrefix: killPrefix,
        loops: false,
        workerSettings: fast,
      });
      try {
        const body = await waitForProcessing(t, owner, meetingId, finished, 180_000);
        expect(body.run).toMatchObject({ id: runId, status: 'completed' });
        expect(body.run!.steps[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
      } finally {
        await restarted.close();
      }
    } finally {
      await killHard(child);
      await queue.close();
    }
    const rows = await recordingsOf(meetingId);
    expect(rows.filter((r) => r.kind === 'normalized')).toHaveLength(1);
    const prefix = meetingPrefix(held, meetingId);
    expect(await keysUnder(`${prefix}normalized/`)).toEqual([`${prefix}normalized/${runId}`]);
    expect(await keysUnder(`${prefix}peaks/`)).toEqual([`${prefix}peaks/${runId}`]);
    expect(await listJobDirs(mediaTmp)).toEqual([]);
  });
});

describe('reprocessing', () => {
  it('replaces the normalized audio and deletes the old objects', async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.audioWav);
    const first = await waitForProcessing(t, owner, meetingId, finished);
    const firstRun = first.run!.id;

    const res = await call(t, owner, {
      method: 'POST',
      url: `/v1/meetings/${meetingId}/runs`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(202);
    const started = res.json<{ run: { id: string; trigger: string } }>().run;
    expect(started.trigger).toBe('reprocess');
    expect(started.id).not.toBe(firstRun);

    const done = await waitForProcessing(
      t,
      owner,
      meetingId,
      (b) => b.run?.id === started.id && finished(b),
    );
    expect(done).toMatchObject({ meetingStatus: 'ready', run: { status: 'completed' } });
    const normalized = (await recordingsOf(meetingId)).filter((r) => r.kind === 'normalized');
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.storageKey).toBe(
      `${meetingPrefix(ws, meetingId)}normalized/${started.id}`,
    );
    // The superseded objects go once the outbox event is handled.
    await vi.waitFor(
      async () =>
        expect((await outputKeys(meetingId)).sort()).toEqual(
          [
            `${meetingPrefix(ws, meetingId)}normalized/${started.id}`,
            `${meetingPrefix(ws, meetingId)}peaks/${started.id}`,
          ].sort(),
        ),
      { timeout: 15_000, interval: 200 },
    );
    const actions = (
      await db().select().from(auditLogs).where(eq(auditLogs.targetId, meetingId))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'processing.run_started',
        'processing.run_completed',
        'processing.reprocess_requested',
      ]),
    );
  });

  it('answers a second concurrent reprocess with 409', async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.audioM4a);
    await waitForProcessing(t, owner, meetingId, finished);
    const results = await Promise.all(
      [1, 2].map(() =>
        call(t, owner, { method: 'POST', url: `/v1/meetings/${meetingId}/runs`, payload: {} }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({
      code: 'RUN_ALREADY_ACTIVE',
    });
    await waitForProcessing(
      t,
      owner,
      meetingId,
      (b) => b.run?.trigger === 'reprocess' && finished(b),
    );
  });

  it('refuses members and viewers (403) and meetings without a recording (409)', async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.audioWav);
    await waitForProcessing(t, owner, meetingId, finished);
    const asViewer = await call(t, viewer, {
      method: 'POST',
      url: `/v1/meetings/${meetingId}/runs`,
      payload: {},
    });
    expect(asViewer.statusCode).toBe(403);
    const empty = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${ws}/meetings`,
      payload: { title: 'No recording', occurredAt: '2026-10-01T09:00:00Z' },
    });
    const noRecording = await call(t, owner, {
      method: 'POST',
      url: `/v1/meetings/${empty.json<{ id: string }>().id}/runs`,
      payload: {},
    });
    expect(noRecording.statusCode).toBe(409);
    expect(noRecording.headers['content-type']).toContain('application/problem+json');
    expect(noRecording.json()).toMatchObject({ code: 'RECORDING_NOT_UPLOADED' });
  });
});

describe('cancellation', () => {
  it('deleting a meeting mid-run cancels the run and cleans up storage', async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.longerMp3);
    await waitForProcessing(
      t,
      owner,
      meetingId,
      (b) => b.run?.steps[0]?.phase === 'transcoding',
      60_000,
    );
    const [run] = await runsOf(meetingId);

    const del = await call(t, owner, { method: 'DELETE', url: `/v1/meetings/${meetingId}` });
    expect(del.statusCode).toBe(202);
    const [cancelled] = await db()
      .select()
      .from(processingRuns)
      .where(eq(processingRuns.id, run!.id));
    expect(cancelled!.status).toBe('cancelled');

    // The purge removes the rows; the step notices, kills ffmpeg and removes what it wrote.
    await vi.waitFor(
      async () => {
        expect(await db().select().from(meetings).where(eq(meetings.id, meetingId))).toEqual([]);
        expect(await keysUnder(meetingPrefix(ws, meetingId))).toEqual([]);
        expect(await listJobDirs(mediaTmp)).toEqual([]);
      },
      { timeout: 60_000, interval: 250 },
    );
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await keysUnder(meetingPrefix(ws, meetingId))).toEqual([]);
    const actions = (
      await db().select().from(auditLogs).where(eq(auditLogs.targetId, meetingId))
    ).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['processing.run_cancelled', 'meeting.purged']));
  });
});

describe('pipeline.media flag', () => {
  it('leaves uploads unprocessed while off, then processes the backlog when turned on', async () => {
    const held = await heldWorkspace('Backlog');
    const meetingId = await uploadFixture(t, owner, held, fixtures.audioWav);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await getProcessing(t, owner, meetingId)).toMatchObject({
      meetingStatus: 'uploaded',
      run: null,
    });

    await enablePipeline(t, held);
    const body = await waitForProcessing(t, owner, meetingId, finished);
    expect(body).toMatchObject({ meetingStatus: 'ready', run: { status: 'completed' } });
  });
});

describe('live events (SSE)', () => {
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await t.app.listen({ host: '127.0.0.1', port: 0 });
  });

  /** Opens the event stream and collects events and comments as they arrive. */
  async function openStream(session: Session, meetingId: string) {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/meetings/${meetingId}/events`, {
      headers: { cookie: session.cookie },
      signal: controller.signal,
    });
    const events: { event: string; data: ProcessingEvent }[] = [];
    const comments: string[] = [];
    if (res.ok && res.body) {
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (block.startsWith(':')) comments.push(block);
              const event = /^event: (.+)$/m.exec(block)?.[1];
              const data = /^data: (.+)$/m.exec(block)?.[1];
              if (event && data) events.push({ event, data: JSON.parse(data) as ProcessingEvent });
            }
          }
        } catch {
          // Aborted by the test.
        }
      })();
    }
    return { res, events, comments, close: () => controller.abort() };
  }

  interface ProcessingEvent {
    meetingStatus: string;
    run: { id: string; status: string; steps: Record<string, unknown>[] } | null;
  }

  it('streams run.updated to viewers until the run completes, with heartbeats', async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.audioM4a);
    await waitForProcessing(t, owner, meetingId, finished);

    const stream = await openStream(viewer, meetingId);
    try {
      expect(stream.res.status).toBe(200);
      expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.res.headers.get('cache-control')).toBe('no-cache, no-transform');
      await vi.waitFor(() => expect(stream.events.length).toBeGreaterThan(0));
      expect(stream.events[0]!.event).toBe('run.updated');

      const res = await call(t, owner, {
        method: 'POST',
        url: `/v1/meetings/${meetingId}/runs`,
        payload: {},
      });
      const runId = res.json<{ run: { id: string } }>().run.id;
      await vi.waitFor(
        () => {
          const statuses = stream.events
            .filter((e) => e.data.run?.id === runId)
            .map((e) => e.data.run!.status);
          expect(statuses.at(-1)).toBe('completed');
          expect(statuses.some((s) => s !== 'completed')).toBe(true);
        },
        { timeout: 30_000, interval: 100 },
      );
      // Viewers never get internal error details.
      for (const e of stream.events) {
        for (const step of e.data.run?.steps ?? []) expect(step).not.toHaveProperty('errorDetail');
      }
      await vi.waitFor(() => expect(stream.comments).toContain(': heartbeat'), { timeout: 5_000 });
    } finally {
      stream.close();
    }
    await vi.waitFor(() => expect(t.deps.processingEvents.size).toBe(0));
  });

  it("is 404 for other workspaces' members and 401 when signed out", async () => {
    const meetingId = await uploadFixture(t, owner, ws, fixtures.audioWav);
    const stream = await openStream(outsider, meetingId);
    expect(stream.res.status).toBe(404);
    expect(stream.res.headers.get('content-type')).toContain('application/problem+json');
    const anonymous = await fetch(`${baseUrl}/v1/meetings/${meetingId}/events`);
    expect(anonymous.status).toBe(401);
    await waitForProcessing(t, owner, meetingId, finished);
  });
});
