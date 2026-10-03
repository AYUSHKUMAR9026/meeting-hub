import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organization, user } from './auth';
import { createdAt, id, updatedAt } from './columns';

/** One row per workspace with settings Better Auth doesn't model. */
export const workspaceSettings = pgTable(
  'workspace_settings',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull().default('UTC'),
    retentionDays: integer('retention_days').notNull().default(30),
    glossary: text('glossary')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('workspace_settings_retention_days_check', sql`${t.retentionDays} > 0`)],
);

/**
 * Directory of humans who appear in a workspace's meetings, whether or not they are users.
 * Emails are stored lower-cased by the app.
 */
export const people = pgTable(
  'people',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    email: text('email'),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Target of meeting_participants' composite foreign key (same-workspace guarantee).
    unique('people_id_workspace_id_key').on(t.id, t.workspaceId),
    uniqueIndex('people_workspace_id_email_key')
      .on(t.workspaceId, t.email)
      .where(sql`${t.email} IS NOT NULL`),
    uniqueIndex('people_workspace_id_user_id_key')
      .on(t.workspaceId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    index('people_display_name_trgm_idx').using('gin', sql`${t.displayName} gin_trgm_ops`),
  ],
);

/**
 * Append-only audit trail. The app never updates or deletes rows (a trigger enforces it).
 * No foreign keys on purpose: entries must outlive the users and workspaces they mention.
 * Never store passwords, tokens or meeting content in `metadata`.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    workspaceId: uuid('workspace_id'),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_workspace_id_created_at_idx').on(t.workspaceId, t.createdAt.desc())],
);

export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
