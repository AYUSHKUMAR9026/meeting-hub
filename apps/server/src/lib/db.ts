import { createDb, type DbClient } from '@meeting-hub/db';

import type { Config } from './config';

export function createDatabase(config: Config, applicationName: string): DbClient {
  return createDb({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    applicationName,
  });
}

export type { Database, DbClient } from '@meeting-hub/db';

/** True for a Postgres unique_violation (23505), also when wrapped by Drizzle as `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? e.code : undefined);
  const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : undefined;
  return codeOf(err) === '23505' || codeOf(cause) === '23505';
}
