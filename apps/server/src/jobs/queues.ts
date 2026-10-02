import { type DefaultJobOptions, Queue } from 'bullmq';

import { bullConnection } from '../lib/redis';

export const QUEUE_NAMES = {
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Defaults for every job: 5 attempts with exponential backoff (1s, 2s, 4s, 8s),
 * bounded retention so Redis does not grow forever.
 */
export const defaultJobOptions: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5_000 },
};

/** Worker-side settings for detecting jobs whose worker died mid-flight. */
export const stalledJobSettings = {
  /** How long a job lock lasts before it must be renewed. */
  lockDuration: 60_000,
  /** How often to check for stalled jobs. */
  stalledInterval: 30_000,
  /** A job that stalls more than this many times is moved to failed. */
  maxStalledCount: 2,
};

export function createQueue(name: QueueName, redisUrl: string): Queue {
  return new Queue(name, { connection: bullConnection(redisUrl), defaultJobOptions });
}
