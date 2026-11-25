import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { organization, user } from './auth';
import { createdAt, id, timestamptz } from './columns';
import { meetings } from './meetings';
import { actionItems, decisions } from './analysis';

export const progressSnapshots = pgTable(
  'progress_snapshots',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date').notNull(),
    openCount: integer('open_count').notNull(),
    doneCount: integer('done_count').notNull(),
    overdueCount: integer('overdue_count').notNull(),
    proposedCount: integer('proposed_count').notNull(),
    rejectedCount: integer('rejected_count').notNull(),
    decisionsProposed: integer('decisions_proposed').notNull(),
    decisionsConfirmed: integer('decisions_confirmed').notNull(),
    meetingsCount: integer('meetings_count').notNull(),
    backfilled: boolean('backfilled').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('progress_snapshots_workspace_date_key').on(t.workspaceId, t.snapshotDate),
    check(
      'progress_snapshot_counts_check',
      sql`${t.openCount} >= 0 AND ${t.doneCount} >= 0 AND ${t.overdueCount} BETWEEN 0 AND ${t.openCount} AND ${t.proposedCount} >= 0 AND ${t.rejectedCount} >= 0 AND ${t.decisionsProposed} >= 0 AND ${t.decisionsConfirmed} >= 0 AND ${t.meetingsCount} >= 0`,
    ),
  ],
);

export const itemStatusEvents = pgTable(
  'item_status_events',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    itemType: text('item_type').$type<'decision' | 'action_item'>().notNull(),
    itemId: uuid('item_id').notNull(),
    decisionId: uuid('decision_id').generatedAlwaysAs(
      sql`CASE WHEN item_type = 'decision' THEN item_id END`,
    ),
    actionItemId: uuid('action_item_id').generatedAlwaysAs(
      sql`CASE WHEN item_type = 'action_item' THEN item_id END`,
    ),
    meetingId: uuid('meeting_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    changedBy: uuid('changed_by').references(() => user.id, { onDelete: 'set null' }),
    changedAt: timestamptz('changed_at').notNull().defaultNow(),
    backfilled: boolean('backfilled').notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: 'item_status_events_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'item_status_events_decision_fk',
      columns: [t.decisionId, t.workspaceId],
      foreignColumns: [decisions.id, decisions.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'item_status_events_action_fk',
      columns: [t.actionItemId, t.workspaceId],
      foreignColumns: [actionItems.id, actionItems.workspaceId],
    }).onDelete('cascade'),
    index('item_status_events_range_idx').on(t.workspaceId, t.changedAt),
    index('item_status_events_item_idx').on(t.workspaceId, t.itemType, t.itemId, t.changedAt),
    index('item_status_events_meeting_idx').on(t.meetingId, t.workspaceId),
    index('item_status_events_decision_idx').on(t.decisionId, t.workspaceId),
    index('item_status_events_action_idx').on(t.actionItemId, t.workspaceId),
    check(
      'item_status_events_status_check',
      sql`(${t.itemType} = 'decision' AND ${t.toStatus} IN ('proposed','confirmed','rejected') AND (${t.fromStatus} IS NULL OR ${t.fromStatus} IN ('proposed','confirmed','rejected'))) OR (${t.itemType} = 'action_item' AND ${t.toStatus} IN ('open','done','rejected') AND (${t.fromStatus} IS NULL OR ${t.fromStatus} IN ('open','done','rejected')))`,
    ),
  ],
);

/** Durable debounce: Redis loss cannot lose a requested refresh. */
export const progressRefreshRequests = pgTable(
  'progress_refresh_requests',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
  },
  (t) => [index('progress_refresh_requests_due_idx').on(t.availableAt)],
);
