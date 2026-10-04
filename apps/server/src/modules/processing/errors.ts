import { type AppError, PermanentError, RetryableError } from '../../lib/errors';
import { MediaToolMissingError, ObjectTooLargeError } from '../media';

/** The run was cancelled or its meeting deleted while a step was running. */
export class RunCancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelledError';
  }
}

/** A step attempt ran past its timeout and was stopped. */
export class StepTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`step timed out after ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
  }
}

export interface StepFailure {
  /** Stable UPPER_SNAKE code. */
  code: string;
  /** Safe to show to every member of the workspace. */
  message: string;
  /** Internal detail for owners/admins and logs. Never media content or signed URLs. */
  detail: string | null;
  /** True: fail the step now. False: retry with backoff while attempts remain. */
  permanent: boolean;
}

export const STEP_ERRORS = {
  timedOut: 'STEP_TIMED_OUT',
  attemptsExhausted: 'STEP_ATTEMPTS_EXHAUSTED',
  unexpected: 'STEP_FAILED',
  toolsUnavailable: 'MEDIA_TOOLS_UNAVAILABLE',
} as const;

const RETRY_MESSAGE = 'Something went wrong while processing the recording. It will be retried.';

const truncate = (s: string | null | undefined, max = 2_000) =>
  s ? (s.length > max ? `${s.slice(0, max)}…` : s) : null;

/** What `details.internal` holds on our own errors, if anything. */
function internalOf(err: AppError): string | null {
  const internal = err.details?.internal;
  if (typeof internal === 'string') return internal;
  const cause = err.cause instanceof Error ? err.cause.message : null;
  return cause;
}

/**
 * Maps anything a step threw onto the run/step error model (ADR 0004):
 * PermanentError fails the step at once with its user-safe message; RetryableError and unexpected
 * errors are retried; timeouts and oversize inputs are permanent.
 */
export function classifyStepError(err: unknown): StepFailure {
  if (err instanceof PermanentError) {
    return {
      code: err.code,
      message: err.message,
      detail: truncate(internalOf(err)),
      permanent: true,
    };
  }
  if (err instanceof StepTimeoutError) {
    return {
      code: STEP_ERRORS.timedOut,
      message: 'Processing took too long and was stopped.',
      detail: err.message,
      permanent: true,
    };
  }
  if (err instanceof ObjectTooLargeError) {
    return {
      code: 'MEDIA_TOO_LARGE',
      message: 'The recording is larger than the upload limit.',
      detail: err.message,
      permanent: true,
    };
  }
  if (err instanceof MediaToolMissingError) {
    return {
      code: STEP_ERRORS.toolsUnavailable,
      message: RETRY_MESSAGE,
      detail: truncate(err.message),
      permanent: false,
    };
  }
  if (err instanceof RetryableError) {
    return {
      code: err.code,
      message: RETRY_MESSAGE,
      detail: truncate(internalOf(err) ?? err.message),
      permanent: false,
    };
  }
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    code: STEP_ERRORS.unexpected,
    message: RETRY_MESSAGE,
    detail: truncate(message),
    permanent: false,
  };
}

/** The failure recorded when a retryable error happens on the last allowed attempt. */
export function exhausted(last: StepFailure, attempts: number): StepFailure {
  return {
    code: STEP_ERRORS.attemptsExhausted,
    message: 'Processing failed after several attempts.',
    detail: truncate(`after ${attempts} attempts, last error ${last.code}: ${last.detail ?? ''}`),
    permanent: true,
  };
}
