import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbClient, domainEvents, featureFlags, runMigrations, sql } from '../src';

const PG_IMAGE = 'pgvector/pgvector:0.8.7-pg18-trixie';

describe('migrations', () => {
  let container: StartedPostgreSqlContainer;
  let client: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(PG_IMAGE).start();
    await runMigrations(container.getConnectionUri());
    client = createDb({ connectionString: container.getConnectionUri(), max: 2 });
  });

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('is idempotent', async () => {
    await expect(runMigrations(container.getConnectionUri())).resolves.toBeUndefined();
  });

  it('enables vector, pg_trgm and unaccent', async () => {
    const { rows } = await client.pool.query<{ extname: string }>('SELECT extname FROM pg_extension');
    expect(rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['vector', 'pg_trgm', 'unaccent']),
    );
  });

  it('generates UUIDv7 primary keys', async () => {
    const [row] = await client.db
      .insert(domainEvents)
      .values({ type: 'test.event', payload: { ok: true } })
      .returning();
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row?.processedAt).toBeNull();
  });

  it('allows only one global row per flag key', async () => {
    await client.db.insert(featureFlags).values({ key: 'flag.unique', enabled: true });
    await expect(
      client.db.insert(featureFlags).values({ key: 'flag.unique', enabled: false }),
    ).rejects.toThrow();
  });

  it('uses the partial index for unprocessed outbox events', async () => {
    const { rows } = await client.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'domain_events_unprocessed_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('WHERE (processed_at IS NULL)');
  });

  it('supports pgvector types', async () => {
    const result = await client.db.execute(sql`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS d`);
    expect(Number(result.rows[0]?.d)).toBe(1);
  });
});
