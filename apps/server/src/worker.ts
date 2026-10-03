import { startMaintenance } from './jobs/maintenance';
import { loadConfigOrExit } from './lib/config';
import { createDatabase } from './lib/db';
import { createLogger } from './lib/logger';
import { createRedis } from './lib/redis';
import { createS3Client } from './lib/s3';
import { registerShutdown } from './lib/shutdown';
import { AuditService } from './modules/audit';
import { ObjectStorage } from './modules/media';
import { createMeetingMaintenance } from './modules/meetings';
import { createFeatureFlagService } from './modules/platform';

const config = loadConfigOrExit();
const logger = createLogger(config, { process: 'worker' });

const db = createDatabase(config, 'meeting-hub-worker');
const redis = createRedis(config.REDIS_URL, 'meeting-hub-worker');
redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));
const s3 = createS3Client(config);
const flags = createFeatureFlagService({ config, db: db.db, logger });
const audit = new AuditService(db.db, logger.child({ module: 'audit' }));
const meetings = createMeetingMaintenance({
  db: db.db,
  // The worker never presigns, so the same client serves as signer.
  storage: new ObjectStorage(s3, s3, config.S3_BUCKET),
  audit,
  logger,
  staleAfterHours: config.UPLOAD_STALE_AFTER_HOURS,
});

await redis.connect();

const maintenance = await startMaintenance({
  redisUrl: config.REDIS_URL,
  redis,
  logger,
  flags,
  meetings,
  concurrency: config.WORKER_CONCURRENCY,
  heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
});

registerShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  await maintenance.close();
  s3.destroy();
  await Promise.allSettled([redis.quit(), db.close()]);
});
