import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { user } from './auth';
import { createdAt, id, timestamptz } from './columns';
import { meetings } from './meetings';

export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    tokenHash: text('token_hash').notNull(),
    scope: text('scope').$type<'document' | 'document_and_transcript'>().notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    lastAccessedAt: timestamptz('last_accessed_at'),
    accessCount: integer('access_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('share_links_token_hash_key').on(t.tokenHash),
    index('share_links_meeting_idx').on(t.meetingId, t.workspaceId, t.createdAt.desc()),
    foreignKey({
      name: 'share_links_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    check('share_links_scope_check', sql`${t.scope} IN ('document', 'document_and_transcript')`),
    check(
      'share_links_expiry_check',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '2160 hours'`,
    ),
    check('share_links_hash_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('share_links_count_check', sql`${t.accessCount} >= 0`),
  ],
);
