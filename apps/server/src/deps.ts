import type { S3Client } from '@aws-sdk/client-s3';

import type { Config } from './lib/config';
import { createDatabase, type DbClient } from './lib/db';
import type { Logger } from './lib/logger';
import { createRedis, type Redis } from './lib/redis';
import { createS3Client } from './lib/s3';
import { createFeatureFlagService, type FeatureFlagService } from './modules/platform';

/** Everything the API needs, created once at startup and injected (keeps tests swappable). */
export interface ApiDeps {
  config: Config;
  logger: Logger;
  db: DbClient;
  redis: Redis;
  s3: S3Client;
  flags: FeatureFlagService;
}

export function createApiDeps(config: Config, logger: Logger): ApiDeps {
  const db = createDatabase(config, 'meeting-hub-api');
  const redis = createRedis(config.REDIS_URL, 'meeting-hub-api');
  redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));
  const s3 = createS3Client(config);
  const flags = createFeatureFlagService({ config, db: db.db, logger });
  return { config, logger, db, redis, s3, flags };
}

export async function closeApiDeps(deps: ApiDeps): Promise<void> {
  deps.s3.destroy();
  await Promise.allSettled([deps.db.close(), deps.redis.quit()]);
}
