import { type Job, type Queue, Worker } from 'bullmq';

import type { Logger } from '../lib/logger';
import { bullConnection, type Redis } from '../lib/redis';
import type { FeatureFlagService } from '../modules/platform';
import { withErrorPolicy } from './processor';
import { createHeartbeatProcessor, HEARTBEAT_JOB } from './processors/heartbeat';
import { createQueue, QUEUE_NAMES, stalledJobSettings } from './queues';

export interface MaintenanceDeps {
  redisUrl: string;
  redis: Redis;
  logger: Logger;
  flags: FeatureFlagService;
  concurrency: number;
  heartbeatIntervalMs: number;
}

export interface MaintenanceRuntime {
  queue: Queue;
  worker: Worker;
  close: () => Promise<void>;
}

export async function startMaintenance(deps: MaintenanceDeps): Promise<MaintenanceRuntime> {
  const logger = deps.logger.child({ queue: QUEUE_NAMES.maintenance });
  const queue = createQueue(QUEUE_NAMES.maintenance, deps.redisUrl);

  const heartbeat = createHeartbeatProcessor({ logger, redis: deps.redis, flags: deps.flags });
  const processor = withErrorPolicy(async (job: Job) => {
    switch (job.name) {
      case HEARTBEAT_JOB:
        return heartbeat(job);
      default:
        throw new Error(`Unknown maintenance job "${job.name}"`);
    }
  });

  const worker = new Worker(QUEUE_NAMES.maintenance, processor, {
    connection: bullConnection(deps.redisUrl),
    concurrency: deps.concurrency,
    ...stalledJobSettings,
  });

  worker.on('failed', (job, err) =>
    logger.error(
      { err, jobId: job?.id, job: job?.name, attempts: job?.attemptsMade },
      'job failed',
    ),
  );
  worker.on('stalled', (jobId) => logger.warn({ jobId }, 'job stalled; it will be retried'));
  worker.on('error', (err) => logger.error({ err }, 'worker error'));

  // Repeating heartbeat (idempotent upsert, so restarts do not duplicate the schedule)
  // plus one immediately so a fresh `pnpm dev` shows a completed job right away.
  await queue.upsertJobScheduler(
    'maintenance-heartbeat',
    { every: deps.heartbeatIntervalMs },
    { name: HEARTBEAT_JOB },
  );
  await queue.add(HEARTBEAT_JOB, {}, { jobId: `heartbeat-boot-${Date.now()}` });

  logger.info({ concurrency: deps.concurrency }, 'maintenance worker started');

  return {
    queue,
    worker,
    // worker.close() waits for active jobs to finish before resolving.
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
