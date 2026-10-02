import { startMaintenance } from './jobs/maintenance';
import { loadConfigOrExit } from './lib/config';
import { createDatabase } from './lib/db';
import { createLogger } from './lib/logger';
import { createRedis } from './lib/redis';
import { registerShutdown } from './lib/shutdown';
import { createFeatureFlagService } from './modules/platform';

const config = loadConfigOrExit();
const logger = createLogger(config, { process: 'worker' });

const db = createDatabase(config, 'meeting-hub-worker');
const redis = createRedis(config.REDIS_URL, 'meeting-hub-worker');
redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));
const flags = createFeatureFlagService({ config, db: db.db, logger });

await redis.connect();

const maintenance = await startMaintenance({
  redisUrl: config.REDIS_URL,
  redis,
  logger,
  flags,
  concurrency: config.WORKER_CONCURRENCY,
  heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
});

registerShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  await maintenance.close();
  await Promise.allSettled([redis.quit(), db.close()]);
});
