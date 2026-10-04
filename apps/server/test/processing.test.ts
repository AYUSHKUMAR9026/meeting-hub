import { STEP_NAMES as CONTRACT_STEP_NAMES } from '@meeting-hub/contracts';
import { describe, expect, it } from 'vitest';

import { PermanentError, RetryableError } from '../src/lib/errors';
import { MediaToolMissingError, ObjectTooLargeError } from '../src/modules/media';
import { outboxBackoffMs } from '../src/modules/platform';
import {
  classifyStepError,
  computeRunProgress,
  createStepRegistry,
  nextStep,
  normalizedFileName,
  PIPELINES,
  ProgressThrottle,
  STEP_NAMES,
  type StepDefinition,
  stepJobId,
  StepTimeoutError,
} from '../src/modules/processing';

const step = (overrides: Partial<StepDefinition> = {}): StepDefinition => ({
  name: 'prepare_media',
  queue: 'media',
  runStatus: 'preparing_media',
  maxAttempts: 3,
  backoffMs: 1_000,
  timeoutMs: 60_000,
  weight: 1,
  isAlreadyDone: () => Promise.resolve(false),
  execute: () => Promise.reject(new Error('not used')),
  ...overrides,
});

describe('step registry', () => {
  it('accepts the steps every pipeline version uses', () => {
    const registry = createStepRegistry([step()]);
    expect([...registry.keys()]).toEqual(['prepare_media']);
  });

  it('rejects duplicate steps, bad settings and pipelines with unknown steps', () => {
    expect(() => createStepRegistry([step(), step()])).toThrow(/twice/);
    expect(() => createStepRegistry([step({ weight: 0 })])).toThrow(/weight/);
    expect(() => createStepRegistry([step({ maxAttempts: 0 })])).toThrow(/maxAttempts/);
    expect(() => createStepRegistry([step({ timeoutMs: 0 })])).toThrow(/timeout/);
    expect(() => createStepRegistry([])).toThrow(/unknown step "prepare_media"/);
  });

  it('pipeline v1 is exactly prepare_media', () => {
    expect(PIPELINES[1]).toEqual(['prepare_media']);
    expect(nextStep(1, 'prepare_media')).toBeNull();
    expect(() => nextStep(1, 'transcribe')).toThrow();
    expect(() => nextStep(99, 'prepare_media')).toThrow(/unknown pipeline/);
  });

  it('matches the step names published in the API contract', () => {
    expect([...CONTRACT_STEP_NAMES]).toEqual(STEP_NAMES);
  });

  it('builds deterministic BullMQ job ids without a bare colon', () => {
    const runId = '0199a000-0000-7000-8000-000000000003';
    expect(stepJobId(runId, 'prepare_media')).toBe(`${runId}.prepare_media`);
    expect(stepJobId(runId, 'prepare_media')).not.toContain(':');
  });
});

describe('run progress', () => {
  it('sums finished weights plus the running step’s estimate', () => {
    expect(
      computeRunProgress([
        { status: 'succeeded', weight: 1 },
        { status: 'running', weight: 2, progress: 0.5 },
        { status: 'pending', weight: 1 },
      ]),
    ).toBeCloseTo(0.5);
  });

  it('counts skipped steps as done, failed and pending ones as not', () => {
    expect(
      computeRunProgress([
        { status: 'skipped', weight: 1 },
        { status: 'failed', weight: 1 },
        { status: 'pending', weight: 2 },
      ]),
    ).toBeCloseTo(0.25);
  });

  it('clamps nonsense estimates and handles empty runs', () => {
    expect(computeRunProgress([{ status: 'running', weight: 1, progress: 7 }])).toBe(1);
    expect(computeRunProgress([{ status: 'running', weight: 1, progress: Number.NaN }])).toBe(0);
    expect(computeRunProgress([])).toBe(0);
  });

  it('throttles progress writes by time or by a big enough jump', () => {
    let now = 0;
    const throttle = new ProgressThrottle(2_000, 0.05, () => now);
    expect(throttle.shouldWrite(0)).toBe(true);
    now = 500;
    expect(throttle.shouldWrite(0.01)).toBe(false);
    expect(throttle.shouldWrite(0.06)).toBe(true);
    now = 2_600;
    expect(throttle.shouldWrite(0.07)).toBe(true);
  });
});

describe('step error classification', () => {
  it('fails at once on PermanentError, keeping the user message and internal detail apart', () => {
    const failure = classifyStepError(
      new PermanentError('NO_AUDIO_STREAM', 'The video has no audio track.', {
        details: { internal: 'format mov, no audio stream' },
      }),
    );
    expect(failure).toEqual({
      code: 'NO_AUDIO_STREAM',
      message: 'The video has no audio track.',
      detail: 'format mov, no audio stream',
      permanent: true,
    });
  });

  it('retries RetryableError, missing tools and unexpected errors with a generic message', () => {
    for (const err of [
      new RetryableError('S3_UNAVAILABLE', 'storage down'),
      new MediaToolMissingError(new Error('spawn ffmpeg ENOENT') as never),
      new TypeError('boom'),
    ]) {
      const failure = classifyStepError(err);
      expect(failure.permanent).toBe(false);
      expect(failure.message).toMatch(/will be retried/);
      expect(failure.detail).toBeTruthy();
    }
    expect(classifyStepError(new TypeError('boom')).code).toBe('STEP_FAILED');
  });

  it('treats timeouts and oversized inputs as permanent', () => {
    expect(classifyStepError(new StepTimeoutError(1_000))).toMatchObject({
      code: 'STEP_TIMED_OUT',
      permanent: true,
    });
    expect(classifyStepError(new ObjectTooLargeError(10))).toMatchObject({
      code: 'MEDIA_TOO_LARGE',
      permanent: true,
    });
  });

  it('truncates long internal details', () => {
    const failure = classifyStepError(new Error('x'.repeat(10_000)));
    expect(failure.detail!.length).toBeLessThanOrEqual(2_001);
  });
});

describe('outbox backoff', () => {
  it('doubles from 2 s and caps at an hour', () => {
    expect(outboxBackoffMs(1)).toBe(2_000);
    expect(outboxBackoffMs(2)).toBe(4_000);
    expect(outboxBackoffMs(50)).toBe(3_600_000);
  });
});

describe('normalized file name', () => {
  it('swaps the extension for display', () => {
    expect(normalizedFileName('Weekly sync.mov')).toBe('Weekly sync.m4a');
    expect(normalizedFileName('call.final.mp3')).toBe('call.final.m4a');
    expect(normalizedFileName('noext')).toBe('noext.m4a');
  });
});
