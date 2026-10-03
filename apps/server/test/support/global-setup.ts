/**
 * Starts one Postgres and one Redis container for the whole integration run and migrates the
 * database once. Test files share them and isolate themselves with unique data (emails, slugs).
 */
import { runMigrations } from '@meeting-hub/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

export const PG_IMAGE = 'pgvector/pgvector:0.8.7-pg18-trixie';
export const REDIS_IMAGE = 'redis:8.8.3-alpine';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

let pg: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(project: TestProject) {
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer(PG_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  await runMigrations(pg.getConnectionUri());
  project.provide('databaseUrl', pg.getConnectionUri());
  project.provide('redisUrl', redis.getConnectionUrl());
}

export async function teardown() {
  await Promise.all([pg?.stop(), redis?.stop()]);
}
