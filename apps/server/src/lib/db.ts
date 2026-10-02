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
