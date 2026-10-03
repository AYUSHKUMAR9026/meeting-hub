import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditLogs,
  createDb,
  type DbClient,
  domainEvents,
  featureFlags,
  organization,
  people,
  runMigrations,
  sql,
  user,
  workspaceSettings,
} from '../src';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    const { rows } = await client.pool.query<{ extname: string }>(
      'SELECT extname FROM pg_extension',
    );
    expect(rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['vector', 'pg_trgm', 'unaccent']),
    );
  });

  it('generates UUIDv7 primary keys', async () => {
    const [row] = await client.db
      .insert(domainEvents)
      .values({ type: 'test.event', payload: { ok: true } })
      .returning();
    expect(row?.id).toMatch(UUID_V7);
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
    const result = await client.db.execute(
      sql`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS d`,
    );
    expect(Number(result.rows[0]?.d)).toBe(1);
  });

  describe('auth and workspace tables', () => {
    let workspaceId: string;
    let userId: string;

    beforeAll(async () => {
      const [u] = await client.db
        .insert(user)
        .values({ name: 'Ada', email: 'ada@example.com' })
        .returning();
      const [w] = await client.db
        .insert(organization)
        .values({ name: 'Acme', slug: 'acme' })
        .returning();
      userId = u!.id;
      workspaceId = w!.id;
    });

    it('gives Better Auth tables UUIDv7 ids', () => {
      expect(userId).toMatch(UUID_V7);
      expect(workspaceId).toMatch(UUID_V7);
    });

    it('defaults workspace settings', async () => {
      const [row] = await client.db.insert(workspaceSettings).values({ workspaceId }).returning();
      expect(row).toMatchObject({ timezone: 'UTC', retentionDays: 30, glossary: [] });
      await expect(
        client.db.insert(workspaceSettings).values({ workspaceId: crypto.randomUUID() }),
      ).rejects.toThrow();
    });

    it('keeps people emails unique per workspace but allows many without email', async () => {
      await client.db.insert(people).values([
        { workspaceId, displayName: 'Ada', email: 'ada@example.com', userId },
        { workspaceId, displayName: 'Guest 1' },
        { workspaceId, displayName: 'Guest 2' },
      ]);
      await expect(
        client.db
          .insert(people)
          .values({ workspaceId, displayName: 'Dup', email: 'ada@example.com' }),
      ).rejects.toThrow();
    });

    it('indexes people display names with pg_trgm', async () => {
      const { rows } = await client.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'people_display_name_trgm_idx'`,
      );
      expect(rows[0]?.indexdef).toContain('gin_trgm_ops');
    });

    it('rejects feature flags for unknown workspaces', async () => {
      await expect(
        client.db
          .insert(featureFlags)
          .values({ key: 'flag.fk', workspaceId: crypto.randomUUID(), enabled: true }),
      ).rejects.toThrow();
      await client.db.insert(featureFlags).values({ key: 'flag.fk', workspaceId, enabled: true });
    });

    it('makes audit_logs append-only', async () => {
      const [row] = await client.db
        .insert(auditLogs)
        .values({ workspaceId, action: 'test.event' })
        .returning();
      await expect(
        client.db
          .update(auditLogs)
          .set({ action: 'tampered' })
          .where(sql`id = ${row!.id}`),
      ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
      await expect(client.db.delete(auditLogs)).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/append-only/) },
      });
    });
  });
});
