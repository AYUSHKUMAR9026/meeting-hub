import type { JobState } from 'bullmq';

import {
  type StepDefinition,
  type StepJob,
  stepJobId,
  type StepQueue,
} from '../modules/processing';
import { isQueueName, type LazyQueue, lazyQueue } from './queues';

/** States in which a job will still run (or is running): nothing to add. */
const LIVE: readonly (JobState | 'unknown')[] = [
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
];

export interface BullStepQueue extends StepQueue {
  close(): Promise<void>;
}

/**
 * BullMQ side of the pipeline (ADR 0004): one job per run step, id `{runId}.{step}`, payload
 * `{ runId, step }`, the step's attempts and a jittered exponential backoff. `ensure` is
 * idempotent: it leaves a live job alone and replaces a finished one (BullMQ ignores `add` for an
 * id that still exists, even completed).
 */
export function createStepQueue(options: {
  redisUrl: string;
  prefix?: string;
  onError: (err: Error) => void;
}): BullStepQueue {
  const queues = new Map<string, LazyQueue>();
  const queueFor = (name: string) => {
    if (!isQueueName(name)) throw new Error(`step queue "${name}" is not in QUEUE_NAMES`);
    let queue = queues.get(name);
    if (!queue) {
      queue = lazyQueue(name, options.redisUrl, options.onError, options.prefix);
      queues.set(name, queue);
    }
    return queue.get();
  };

  return {
    async ensure(job: StepJob, step: StepDefinition) {
      const queue = queueFor(step.queue);
      const jobId = stepJobId(job.runId, job.step);
      const existing = await queue.getJob(jobId);
      if (existing) {
        if (LIVE.includes(await existing.getState())) return 'existing';
        await existing.remove();
      }
      await queue.add(
        job.step,
        { runId: job.runId, step: job.step },
        {
          jobId,
          attempts: step.maxAttempts,
          backoff: { type: 'exponential', delay: step.backoffMs, jitter: 0.5 },
        },
      );
      return 'enqueued';
    },
    close: async () => {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}
