import type { Job } from 'bullmq';

import type { Logger } from '../../lib/logger';
import type { Redis } from '../../lib/redis';
import type { FeatureFlagService } from '../../modules/platform';

export const HEARTBEAT_JOB = 'heartbeat';
export const HEARTBEAT_LAST_KEY = 'meeting-hub:maintenance:heartbeat:last';

export interface HeartbeatResult {
  skipped: boolean;
  completedAt: string;
}

export interface HeartbeatDeps {
  logger: Logger;
  redis: Redis;
  flags: FeatureFlagService;
}

/** Proves the worker pipeline end to end: picks up a job, checks a flag, records completion. */
export function createHeartbeatProcessor(deps: HeartbeatDeps) {
  return async (job: Job): Promise<HeartbeatResult> => {
    const completedAt = new Date().toISOString();
    if (!(await deps.flags.isEnabled('platform.heartbeat'))) {
      deps.logger.info({ jobId: job.id }, 'heartbeat skipped (flag platform.heartbeat is off)');
      return { skipped: true, completedAt };
    }
    await deps.redis.set(
      HEARTBEAT_LAST_KEY,
      JSON.stringify({ jobId: job.id, completedAt }),
      'EX',
      7 * 24 * 3600,
    );
    deps.logger.info({ jobId: job.id, completedAt }, 'heartbeat completed');
    return { skipped: false, completedAt };
  };
}
