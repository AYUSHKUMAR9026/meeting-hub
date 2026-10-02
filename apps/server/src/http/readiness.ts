import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DependencyCheck, DependencyName, ReadyResponse } from '@meeting-hub/contracts';

import type { DbClient } from '../lib/db';
import type { Redis } from '../lib/redis';
import { withTimeout } from '../lib/time';

export interface ReadinessDeps {
  pool: DbClient['pool'];
  redis: Redis;
  s3: S3Client;
  bucket: string;
  timeoutMs?: number;
}

async function check(name: DependencyName, fn: () => Promise<unknown>, timeoutMs: number) {
  const started = performance.now();
  try {
    await withTimeout(fn(), timeoutMs, name);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) } as DependencyCheck;
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message || err.name : String(err),
    } as DependencyCheck;
  }
}

/** Probes every hard dependency in parallel. Ready only if all of them are up. */
export async function checkReadiness(deps: ReadinessDeps): Promise<ReadyResponse> {
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const [postgres, redis, s3] = await Promise.all([
    check('postgres', () => deps.pool.query('SELECT 1'), timeoutMs),
    check(
      'redis',
      async () => {
        if (deps.redis.status === 'wait') await deps.redis.connect();
        return deps.redis.ping();
      },
      timeoutMs,
    ),
    check(
      's3',
      () =>
        deps.s3.send(new HeadBucketCommand({ Bucket: deps.bucket }), {
          abortSignal: AbortSignal.timeout(timeoutMs),
        }),
      timeoutMs,
    ),
  ]);
  const checks = { postgres, redis, s3 };
  const allUp = Object.values(checks).every((c) => c.status === 'up');
  return { status: allUp ? 'ready' : 'not_ready', checks };
}
