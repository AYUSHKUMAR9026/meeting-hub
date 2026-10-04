/**
 * The worker process, composed (ADR 0004): maintenance jobs, the processing step workers, the
 * outbox dispatcher and the processing sweeper. worker.ts runs it; integration tests run it too.
 */
import { buildProcessing } from './deps';
import { type MaintenanceRuntime, startMaintenance } from './jobs/maintenance';
import { type ProcessingWorkers, startProcessingWorkers } from './jobs/processing';
import { DEFAULT_QUEUE_PREFIX, QUEUE_NAMES, type StalledJobSettings } from './jobs/queues';
import { type BullStepQueue, createStepQueue } from './jobs/step-queue';
import type { Config } from './lib/config';
import { createDatabase, type DbClient } from './lib/db';
import type { Logger } from './lib/logger';
import { createRedis, type Redis } from './lib/redis';
import { createS3Client } from './lib/s3';
import { AuditService } from './modules/audit';
import { ObjectStorage, sweepStaleJobDirs } from './modules/media';
import { createMeetingMaintenance, type MeetingMaintenance } from './modules/meetings';
import {
  createFeatureFlagService,
  type FeatureFlagService,
  OutboxDispatcher,
} from './modules/platform';
import { type Processing, TIMEOUT_GRACE_MS } from './modules/processing';

export interface WorkerRuntimeOptions {
  /** BullMQ key prefix (tests use a unique one). */
  queuePrefix?: string;
  /** Start the outbox poll loop and the maintenance schedules (off in tests that drive them). */
  loops?: boolean;
  workerSettings?: Partial<StalledJobSettings>;
  driver?: { cancelPollMs?: number };
}

export interface WorkerRuntime {
  db: DbClient;
  redis: Redis;
  storage: ObjectStorage;
  flags: FeatureFlagService;
  processing: Processing;
  dispatcher: OutboxDispatcher;
  stepQueue: BullStepQueue;
  meetings: MeetingMaintenance;
  workers: ProcessingWorkers;
  maintenance: MaintenanceRuntime | null;
  /** Stops everything. `force` abandons running steps (as if the process died). */
  close(force?: boolean): Promise<void>;
}

export async function startWorkerRuntime(
  config: Config,
  logger: Logger,
  options: WorkerRuntimeOptions = {},
): Promise<WorkerRuntime> {
  const prefix = options.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
  const db = createDatabase(config, 'meeting-hub-worker');
  const redis = createRedis(config.REDIS_URL, 'meeting-hub-worker');
  redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));
  const s3 = createS3Client(config);
  // The worker never presigns, so the same client serves as signer.
  const storage = new ObjectStorage(s3, s3, config.S3_BUCKET);
  const flags = createFeatureFlagService({ config, db: db.db, logger });
  const audit = new AuditService(db.db, logger.child({ module: 'audit' }));
  const stepQueue = createStepQueue({
    redisUrl: config.REDIS_URL,
    prefix,
    onError: (err) => logger.warn({ err }, 'step queue error'),
  });
  const processing = buildProcessing(
    config,
    { db, redis, storage, audit, logger, stepQueue },
    options.driver ? { driver: options.driver } : {},
  );
  const meetings = createMeetingMaintenance({
    db: db.db,
    storage,
    audit,
    logger,
    runs: processing.runs,
    staleAfterHours: config.UPLOAD_STALE_AFTER_HOURS,
  });
  const dispatcher = new OutboxDispatcher({
    db: db.db,
    flags,
    logger: logger.child({ module: 'outbox' }),
    handlers: processing.runs.outboxHandlers(),
  });

  await redis.connect();

  // A killed worker never ran its `finally`: remove job directories older than any step can run.
  const longestStep = Math.max(...[...processing.registry.values()].map((s) => s.timeoutMs));
  const removed = await sweepStaleJobDirs(config.MEDIA_TMP_DIR, longestStep + TIMEOUT_GRACE_MS);
  if (removed) logger.warn({ removed }, 'removed stale media job directories');

  const workers = startProcessingWorkers({
    redisUrl: config.REDIS_URL,
    prefix,
    logger,
    driver: processing.driver,
    registry: processing.registry,
    concurrency: { [QUEUE_NAMES.media]: config.MEDIA_CONCURRENCY },
    ...(options.workerSettings ? { workerSettings: options.workerSettings } : {}),
  });

  const loops = options.loops ?? true;
  const maintenance = loops
    ? await startMaintenance({
        redisUrl: config.REDIS_URL,
        prefix,
        redis,
        logger,
        flags,
        meetings,
        sweeper: processing.sweeper,
        sweepIntervalMs: config.PROCESSING_SWEEP_INTERVAL_MS,
        concurrency: config.WORKER_CONCURRENCY,
        heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
      })
    : null;
  const outbox = loops ? dispatcher.start(config.OUTBOX_POLL_INTERVAL_MS) : null;
  if (loops) {
    // Repair anything left over from before this start (lost enqueues, a wiped Redis).
    void processing.sweeper
      .sweep()
      .catch((err: unknown) => logger.error({ err }, 'startup processing sweep failed'));
  }

  return {
    db,
    redis,
    storage,
    flags,
    processing,
    dispatcher,
    stepQueue,
    meetings,
    workers,
    maintenance,
    close: async (force = false) => {
      await outbox?.stop();
      await workers.close(force);
      await maintenance?.close();
      await stepQueue.close();
      s3.destroy();
      await Promise.allSettled([redis.quit(), db.close()]);
    },
  };
}
