import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DbClient {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
}

export function createDb({ connectionString, max = 10, applicationName }: CreateDbOptions): DbClient {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
