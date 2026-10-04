import { type Job, Worker } from 'bullmq';
import { z } from 'zod';

import { PermanentError, RetryableError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { bullConnection } from '../lib/redis';
import type { PipelineDriver, StepRegistry } from '../modules/processing';
import { withErrorPolicy } from './processor';
import {
  DEFAULT_QUEUE_PREFIX,
  isQueueName,
  stalledJobSettings,
  type StalledJobSettings,
} from './queues';

const stepJobData = z.object({ runId: z.uuid(), step: z.string().min(1).max(100) });

export interface ProcessingWorkersDeps {
  redisUrl: string;
  prefix?: string;
  logger: Logger;
  driver: PipelineDriver;
  registry: StepRegistry;
  /** Concurrency per queue (e.g. media → MEDIA_CONCURRENCY). */
  concurrency: Record<string, number>;
  workerSettings?: Partial<StalledJobSettings>;
}

export interface ProcessingWorkers {
  workers: Worker[];
  /** Waits for active jobs to finish. `force` abandons them (they stall and are retried). */
  close(force?: boolean): Promise<void>;
}

/** One BullMQ worker per queue used by the step registry; each job runs one step via the driver. */
export function startProcessingWorkers(deps: ProcessingWorkersDeps): ProcessingWorkers {
  const queueNames = [...new Set([...deps.registry.values()].map((s) => s.queue))];
  const workers = queueNames.map((name) => {
    if (!isQueueName(name)) throw new Error(`step queue "${name}" is not in QUEUE_NAMES`);
    const logger = deps.logger.child({ queue: name });
    const processor = withErrorPolicy(async (job: Job) => {
      const parsed = stepJobData.safeParse(job.data);
      if (!parsed.success)
        throw new PermanentError('INVALID_JOB_DATA', 'step job needs runId and step');
      const result = await deps.driver.processJob(parsed.data);
      if (result === 'retry') {
        // The driver recorded the failure; this makes BullMQ retry with the step's backoff.
        throw new RetryableError('STEP_RETRY', `step ${parsed.data.step} will be retried`);
      }
      return { result };
    });
    const worker = new Worker(name, processor, {
      connection: bullConnection(deps.redisUrl),
      prefix: deps.prefix ?? DEFAULT_QUEUE_PREFIX,
      concurrency: deps.concurrency[name] ?? 1,
      ...stalledJobSettings,
      ...deps.workerSettings,
    });
    worker.on('failed', (job, err) => {
      const data = stepJobData.safeParse(job?.data);
      logger.warn(
        {
          err: { message: err.message },
          ...(data.success ? { run_id: data.data.runId, step: data.data.step } : {}),
          attempts: job?.attemptsMade,
        },
        'step job failed',
      );
    });
    worker.on('stalled', (jobId) => logger.warn({ jobId }, 'step job stalled; it will be retried'));
    worker.on('error', (err) => logger.error({ err }, 'worker error'));
    logger.info({ concurrency: deps.concurrency[name] ?? 1 }, 'processing worker started');
    return worker;
  });
  return {
    workers,
    close: async (force = false) => {
      await Promise.all(workers.map((w) => w.close(force)));
    },
  };
}
