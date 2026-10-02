import { Redis } from 'ioredis';

/** General-purpose client (readiness checks, small KV). BullMQ manages its own connections. */
export function createRedis(url: string, connectionName: string): Redis {
  return new Redis(url, {
    connectionName,
    lazyConnect: true,
    // Fail fast instead of queueing commands while disconnected.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
}

/** Connection options for BullMQ queues and workers (blocking commands need maxRetriesPerRequest: null). */
export function bullConnection(url: string) {
  return { url, maxRetriesPerRequest: null };
}

export type { Redis };
