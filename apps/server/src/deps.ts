import type { S3Client } from '@aws-sdk/client-s3';

import type { Config } from './lib/config';
import { createDatabase, type DbClient } from './lib/db';
import type { Logger } from './lib/logger';
import { type Mailer, SmtpMailer } from './lib/mailer';
import { createRedis, type Redis } from './lib/redis';
import { createS3Client } from './lib/s3';
import { AuditService } from './modules/audit';
import { type Auth, createAuth } from './modules/auth';
import { createPeopleService, type PeopleService } from './modules/people';
import { createFeatureFlagService, type FeatureFlagService } from './modules/platform';
import { createWorkspaceService, type WorkspaceService } from './modules/workspaces';

/** Everything the API needs, created once at startup and injected (keeps tests swappable). */
export interface ApiDeps {
  config: Config;
  logger: Logger;
  db: DbClient;
  redis: Redis;
  s3: S3Client;
  flags: FeatureFlagService;
  mailer: Mailer;
  audit: AuditService;
  auth: Auth;
  people: PeopleService;
  workspaces: WorkspaceService;
}

/** Infrastructure clients a test may replace (e.g. a stub S3 or an in-memory mailer). */
export type InfraOverrides = Partial<Pick<ApiDeps, 'db' | 'redis' | 's3' | 'mailer'>>;

export function createApiDeps(
  config: Config,
  logger: Logger,
  overrides: InfraOverrides = {},
): ApiDeps {
  const db = overrides.db ?? createDatabase(config, 'meeting-hub-api');
  const redis = overrides.redis ?? createRedis(config.REDIS_URL, 'meeting-hub-api');
  if (!overrides.redis) redis.on('error', (err) => logger.warn({ err }, 'redis connection error'));
  const s3 = overrides.s3 ?? createS3Client(config);
  const mailer = overrides.mailer ?? new SmtpMailer(config);

  const flags = createFeatureFlagService({ config, db: db.db, logger });
  const audit = new AuditService(db.db, logger.child({ module: 'audit' }));
  const auth = createAuth({ config, db: db.db, redis, mailer, audit, logger });
  const people = createPeopleService({ db: db.db, audit });
  const workspaces = createWorkspaceService({ db: db.db, auth, people, audit, flags });
  return { config, logger, db, redis, s3, flags, mailer, audit, auth, people, workspaces };
}

export async function closeApiDeps(deps: ApiDeps): Promise<void> {
  deps.s3.destroy();
  deps.mailer.close();
  // quit() waits for a server reply, so only use it on a live connection.
  const redisClosed =
    deps.redis.status === 'ready' ? deps.redis.quit() : Promise.resolve(deps.redis.disconnect());
  await Promise.allSettled([deps.db.close(), redisClosed]);
}
