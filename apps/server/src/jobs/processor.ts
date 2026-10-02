import { type Job, UnrecoverableError } from 'bullmq';

import { PermanentError } from '../lib/errors';

export type Processor<T = unknown, R = unknown> = (job: Job<T, R>) => Promise<R>;

/**
 * Translates our error model into BullMQ semantics:
 * - PermanentError → UnrecoverableError (fail now, no retries)
 * - anything else (incl. RetryableError) → rethrown, retried per the job's backoff
 */
export function withErrorPolicy<T, R>(processor: Processor<T, R>): Processor<T, R> {
  return async (job) => {
    try {
      return await processor(job);
    } catch (err) {
      if (err instanceof PermanentError) {
        throw new UnrecoverableError(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  };
}
