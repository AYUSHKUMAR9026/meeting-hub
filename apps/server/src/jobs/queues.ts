import { type DefaultJobOptions, Queue } from 'bullmq';

import { bullConnection } from '../lib/redis';

export const QUEUE_NAMES = {
  maintenance: 'maintenance',
  /** Processing step prepare_media (ADR 0004). */
  media: 'media',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const isQueueName = (name: string): name is QueueName =>
  (Object.values(QUEUE_NAMES) as string[]).includes(name);

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

export type StalledJobSettings = typeof stalledJobSettings;

/** BullMQ's Redis key prefix. Tests use a unique one so parallel test files don't share queues. */
export const DEFAULT_QUEUE_PREFIX = 'bull';

export function createQueue(
  name: QueueName,
  redisUrl: string,
  prefix: string = DEFAULT_QUEUE_PREFIX,
): Queue {
  return new Queue(name, { connection: bullConnection(redisUrl), defaultJobOptions, prefix });
}

/** A producer queue that only connects to Redis when first used (building the app stays offline). */
export interface LazyQueue {
  get(): Queue;
  close(): Promise<void>;
}

export function lazyQueue(
  name: QueueName,
  redisUrl: string,
  onError: (err: Error) => void,
  prefix: string = DEFAULT_QUEUE_PREFIX,
): LazyQueue {
  let queue: Queue | undefined;
  return {
    get() {
      if (!queue) {
        queue = createQueue(name, redisUrl, prefix);
        queue.on('error', onError);
      }
      return queue;
    },
    close: async () => queue?.close(),
  };
}
