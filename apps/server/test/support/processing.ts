/** Helpers for processing tests: upload fixtures, enable the pipeline, wait for runs, run workers. */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { featureFlags } from '@meeting-hub/db';
import { expect, vi } from 'vitest';

import type { Fixture } from './media-fixtures';
import { call, type Session, type TestApp } from './harness';
import { createMeeting, uploadRecording } from './meetings';

export interface ProcessingBody {
  meetingId: string;
  meetingStatus: string;
  run: {
    id: string;
    status: string;
    trigger: string;
    progress: number;
    currentStep: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    steps: {
      name: string;
      status: string;
      attempts: number;
      progress: number;
      phase: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      errorDetail?: string | null;
    }[];
  } | null;
}

/** Turns `pipeline.media` on for one workspace (the worker under test has no env override). */
export async function enablePipeline(t: TestApp, workspaceId: string, enabled = true) {
  await t.deps.db.db
    .insert(featureFlags)
    .values({ key: 'pipeline.media', workspaceId, enabled })
    .onConflictDoUpdate({
      target: [featureFlags.key, featureFlags.workspaceId],
      set: { enabled },
    });
}

/** Creates a meeting and uploads `fixture` through the API, exactly like the browser does. */
export async function uploadFixture(
  t: TestApp,
  session: Session,
  workspaceId: string,
  fixture: Fixture,
  title = fixture.fileName,
) {
  const meeting = await createMeeting(t, session, workspaceId, { title });
  const data = readFileSync(fixture.path);
  await uploadRecording(t, session, meeting.id, data, {
    fileName: fixture.fileName,
    contentType: fixture.contentType,
  });
  return meeting.id;
}

export async function getProcessing(t: TestApp, session: Session, meetingId: string) {
  const res = await call(t, session, {
    method: 'GET',
    url: `/v1/meetings/${meetingId}/processing`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ProcessingBody>();
}

/** Polls GET /processing until `done` holds for the body. */
export async function waitForProcessing(
  t: TestApp,
  session: Session,
  meetingId: string,
  done: (body: ProcessingBody) => boolean,
  timeout = 60_000,
): Promise<ProcessingBody> {
  let last: ProcessingBody | undefined;
  await vi.waitFor(
    async () => {
      last = await getProcessing(t, session, meetingId);
      expect(done(last), JSON.stringify(last)).toBe(true);
    },
    { timeout, interval: 150 },
  );
  return last!;
}

export const finished = (body: ProcessingBody) =>
  ['completed', 'failed', 'cancelled'].includes(body.run?.status ?? '');

/** A worker in a child process that a test can kill without letting it clean up. */
export async function spawnWorkerProcess(
  env: Record<string, string>,
  options: Record<string, unknown>,
): Promise<ChildProcess> {
  const entry = fileURLToPath(new URL('./worker-process.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      TEST_WORKER_ENV: JSON.stringify(env),
      TEST_WORKER_OPTIONS: JSON.stringify(options),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not start:\n${output}`)), 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('WORKER_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited with ${code}:\n${output}`));
    });
  });
  child.removeAllListeners('exit');
  return child;
}

/** Kills a child process without giving it a chance to clean up, and waits until it is gone. */
export function killHard(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}
