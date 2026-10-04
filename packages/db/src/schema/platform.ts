import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { organization } from './auth';
import { createdAt, id, timestamptz, updatedAt } from './columns';

/**
 * Feature flags. `workspace_id = NULL` is the global default; a row with a
 * workspace id overrides it for that workspace.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: id(),
    key: text('key').notNull(),
    workspaceId: uuid('workspace_id').references(() => organization.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    rules: jsonb('rules').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // NULLS NOT DISTINCT so there can only be one global (workspace_id IS NULL) row per key.
  (t) => [unique('feature_flags_key_workspace_id_key').on(t.key, t.workspaceId).nullsNotDistinct()],
);

/**
 * Transactional outbox: written in the same transaction as the state change it describes, and
 * marked processed in the same transaction as the dispatcher's effect (ADR 0004). A failed handler
 * bumps `attempts` and pushes `available_at` out (backoff).
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: id(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    processedAt: timestamptz('processed_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
  },
  (t) => [
    index('domain_events_unprocessed_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

export type FeatureFlagRow = typeof featureFlags.$inferSelect;
export type DomainEventRow = typeof domainEvents.$inferSelect;
export type NewDomainEvent = typeof domainEvents.$inferInsert;
