import type { S3Client } from '@aws-sdk/client-s3';

import { createMeetingDeletionScheduler } from './jobs/meeting-jobs';
import { DEFAULT_QUEUE_PREFIX, type LazyQueue, lazyQueue, QUEUE_NAMES } from './jobs/queues';
import { type BullStepQueue, createStepQueue } from './jobs/step-queue';
import { ProcessingEventHub } from './http/processing-events';
import type { Config } from './lib/config';
import { createDatabase, type DbClient } from './lib/db';
import type { Logger } from './lib/logger';
import { type Mailer, SmtpMailer } from './lib/mailer';
import { createRedis, type Redis } from './lib/redis';
import { createS3Client } from './lib/s3';
import { AuditService } from './modules/audit';
import { type Auth, createAuth } from './modules/auth';
import { ObjectStorage } from './modules/media';
import { createMeetingServices, type MeetingService, type UploadService } from './modules/meetings';
import { createPeopleService, type PeopleService } from './modules/people';
import { createProcessing, type Processing, RedisProgressPublisher } from './modules/processing';
import { createFeatureFlagService, type FeatureFlagService } from './modules/platform';
import { createWorkspaceService, type WorkspaceService } from './modules/workspaces';

/** Everything the API needs, created once at startup and injected (keeps tests swappable). */
export interface ApiDeps {
  config: Config;
  logger: Logger;
  db: DbClient;
  redis: Redis;
  s3: S3Client;
  /** Signs URLs for browsers, against S3_PUBLIC_ENDPOINT. */
  s3Signer: S3Client;
  storage: ObjectStorage;
  /** Producer for the maintenance queue (the worker consumes it). */
  maintenanceQueue: LazyQueue;
  flags: FeatureFlagService;
  mailer: Mailer;
  audit: AuditService;
  auth: Auth;
  people: PeopleService;
  workspaces: WorkspaceService;
  meetings: MeetingService;
  uploads: UploadService;
  /** Producer for processing step jobs (reprocess). */
  stepQueue: BullStepQueue;
  processing: Processing;
  /** Fans Redis "run changed" messages out to SSE streams. */
  processingEvents: ProcessingEventHub;
}

/** Infrastructure clients a test may replace (e.g. a stub S3 or an in-memory mailer). */
export type InfraOverrides = Partial<Pick<ApiDeps, 'db' | 'redis' | 's3' | 'mailer'>> & {
  /** BullMQ key prefix; tests isolate their queues with a unique one. */
  queuePrefix?: string;
};

/** The processing module, wired from config (shared by the API and the worker). */
export function buildProcessing(
  config: Config,
  infra: {
    db: DbClient;
    redis: Redis;
    storage: ObjectStorage;
    audit: AuditService;
    logger: Logger;
    stepQueue: BullStepQueue;
  },
  options: { driver?: { cancelPollMs?: number } } = {},
): Processing {
  return createProcessing({
    db: infra.db.db,
    storage: infra.storage,
    audit: infra.audit,
    logger: infra.logger,
    queue: infra.stepQueue,
    publisher: new RedisProgressPublisher(infra.redis, infra.logger),
    mediaQueue: QUEUE_NAMES.media,
    media: {
      ffmpegPath: config.FFMPEG_PATH,
      ffprobePath: config.FFPROBE_PATH,
      threads: config.FFMPEG_THREADS,
      maxDurationSeconds: config.MAX_DURATION_SECONDS,
      tmpDir: config.MEDIA_TMP_DIR,
      maxInputBytes: config.MAX_UPLOAD_BYTES,
    },
    mediaUrlTtlSeconds: config.MEDIA_URL_TTL_SECONDS,
    ...(options.driver ? { driver: options.driver } : {}),
  });
}

export function createApiDeps(
  config: Config,
  logger: Logger,
  overrides: InfraOverrides = {},
): ApiDeps {
  const db = overrides.db ?? createDatabase(config, 'meeting-hub-api');
  const redis = overrides.redis ?? createRedis(config.REDIS_URL, 'meeting-hub-api');
  if (!overrides.redis) redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));
  const s3 = overrides.s3 ?? createS3Client(config);
  const s3Signer = createS3Client(config, { forPresigning: true });
  const storage = new ObjectStorage(s3, s3Signer, config.S3_BUCKET);
  const prefix = overrides.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
  const maintenanceQueue = lazyQueue(
    QUEUE_NAMES.maintenance,
    config.REDIS_URL,
    (err) => logger.warn({ err }, 'maintenance queue error'),
    prefix,
  );
  const stepQueue = createStepQueue({
    redisUrl: config.REDIS_URL,
    prefix,
    onError: (err) => logger.warn({ err }, 'step queue error'),
  });
  const mailer = overrides.mailer ?? new SmtpMailer(config);

  const flags = createFeatureFlagService({ config, db: db.db, logger });
  const audit = new AuditService(db.db, logger.child({ module: 'audit' }));
  const auth = createAuth({ config, db: db.db, redis, mailer, audit, logger });
  const people = createPeopleService({ db: db.db, audit });
  const workspaces = createWorkspaceService({ db: db.db, auth, people, audit, flags });
  const processing = buildProcessing(config, { db, redis, storage, audit, logger, stepQueue });
  const { meetings, uploads } = createMeetingServices({
    db: db.db,
    storage,
    audit,
    logger,
    deletions: createMeetingDeletionScheduler(maintenanceQueue),
    runs: processing.runs,
    limits: {
      partSizeBytes: config.UPLOAD_PART_SIZE_BYTES,
      urlTtlSeconds: config.UPLOAD_URL_TTL_SECONDS,
      urlBatchSize: config.UPLOAD_URL_BATCH_SIZE,
      maxUploadBytes: config.MAX_UPLOAD_BYTES,
      downloadUrlTtlSeconds: config.DOWNLOAD_URL_TTL_SECONDS,
    },
  });
  return {
    config,
    logger,
    db,
    redis,
    s3,
    s3Signer,
    storage,
    maintenanceQueue,
    flags,
    mailer,
    audit,
    auth,
    people,
    workspaces,
    meetings,
    uploads,
    stepQueue,
    processing,
    processingEvents: new ProcessingEventHub(config.REDIS_URL, logger),
  };
}

export async function closeApiDeps(deps: ApiDeps): Promise<void> {
  deps.s3.destroy();
  deps.s3Signer.destroy();
  deps.mailer.close();
  // quit() waits for a server reply, so only use it on a live connection.
  const redisClosed =
    deps.redis.status === 'ready' ? deps.redis.quit() : Promise.resolve(deps.redis.disconnect());
  await Promise.allSettled([
    deps.processingEvents.close(),
    deps.db.close(),
    redisClosed,
    deps.maintenanceQueue.close(),
    deps.stepQueue.close(),
  ]);
}
