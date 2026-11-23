import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, timestamptz } from './columns';
import { meetings } from './meetings';
import { processingRuns } from './processing';
import { transcripts, transcriptSegments, transcriptSpeakers } from './transcription';
import { people } from './workspaces';

export interface DocumentSummary {
  paragraph: string;
  bullets: string[];
}

export const meetingDocuments = pgTable(
  'meeting_documents',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    meetingId: uuid('meeting_id').notNull(),
    transcriptId: uuid('transcript_id').notNull(),
    processingRunId: uuid('processing_run_id').notNull(),
    status: text('status').$type<'pending' | 'completed' | 'failed'>().notNull().default('pending'),
    isCurrent: boolean('is_current').notNull().default(false),
    summary: jsonb('summary').$type<DocumentSummary>(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    budgetTokens: integer('budget_tokens').notNull().default(0),
    checkpoints: jsonb('checkpoints').$type<unknown[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    unique('meeting_documents_run_key').on(t.processingRunId),
    unique('meeting_documents_scope_key').on(t.id, t.transcriptId, t.workspaceId),
    unique('meeting_documents_workspace_key').on(t.id, t.workspaceId),
    uniqueIndex('meeting_documents_current_key')
      .on(t.meetingId)
      .where(sql`${t.isCurrent}`),
    index('meeting_documents_history_idx').on(t.meetingId, t.workspaceId, t.createdAt.desc()),
    foreignKey({
      name: 'meeting_documents_meeting_fk',
      columns: [t.meetingId, t.workspaceId],
      foreignColumns: [meetings.id, meetings.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meeting_documents_run_fk',
      columns: [t.processingRunId, t.meetingId, t.workspaceId],
      foreignColumns: [processingRuns.id, processingRuns.meetingId, processingRuns.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meeting_documents_transcript_fk',
      columns: [t.transcriptId, t.meetingId, t.workspaceId],
      foreignColumns: [transcripts.id, transcripts.meetingId, transcripts.workspaceId],
    }).onDelete('cascade'),
    check(
      'meeting_documents_status_check',
      sql`${t.status} IN ('pending', 'completed', 'failed') AND (NOT ${t.isCurrent} OR ${t.status} = 'completed') AND (${t.status} <> 'completed' OR ${t.summary} IS NOT NULL)`,
    ),
  ],
);

const itemColumns = () => ({
  id: id(),
  documentId: uuid('document_id').notNull(),
  transcriptId: uuid('transcript_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  idx: integer('idx').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  editedByUser: boolean('edited_by_user').notNull().default(false),
  source: text('source').$type<'ai' | 'manual'>().notNull().default('ai'),
  deletedAt: timestamptz('deleted_at'),
});

export const decisions = pgTable(
  'decisions',
  {
    ...itemColumns(),
    rationale: text('rationale'),
    status: text('status')
      .$type<'proposed' | 'confirmed' | 'rejected'>()
      .notNull()
      .default('proposed'),
  },
  (t) => [
    unique('decisions_scope_key').on(t.id, t.documentId, t.workspaceId),
    unique('decisions_order_key').on(t.documentId, t.idx),
    foreignKey({
      name: 'decisions_document_fk',
      columns: [t.documentId, t.transcriptId, t.workspaceId],
      foreignColumns: [
        meetingDocuments.id,
        meetingDocuments.transcriptId,
        meetingDocuments.workspaceId,
      ],
    }).onDelete('cascade'),
    check(
      'decisions_status_check',
      sql`${t.status} IN ('proposed', 'confirmed', 'rejected') AND ${t.source} IN ('ai', 'manual')`,
    ),
  ],
);

export const actionItems = pgTable(
  'action_items',
  {
    ...itemColumns(),
    ownerSpeakerId: uuid('owner_speaker_id'),
    ownerPersonId: uuid('owner_person_id'),
    dueDate: date('due_date'),
    status: text('status').$type<'open' | 'done' | 'rejected'>().notNull().default('open'),
  },
  (t) => [
    unique('action_items_scope_key').on(t.id, t.documentId, t.workspaceId),
    unique('action_items_order_key').on(t.documentId, t.idx),
    foreignKey({
      name: 'action_items_document_fk',
      columns: [t.documentId, t.transcriptId, t.workspaceId],
      foreignColumns: [
        meetingDocuments.id,
        meetingDocuments.transcriptId,
        meetingDocuments.workspaceId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'action_items_speaker_fk',
      columns: [t.ownerSpeakerId, t.transcriptId, t.workspaceId],
      foreignColumns: [
        transcriptSpeakers.id,
        transcriptSpeakers.transcriptId,
        transcriptSpeakers.workspaceId,
      ],
    }).onDelete('set null'),
    foreignKey({
      name: 'action_items_person_fk',
      columns: [t.ownerPersonId, t.workspaceId],
      foreignColumns: [people.id, people.workspaceId],
    }).onDelete('set null'),
    index('action_items_speaker_idx').on(t.ownerSpeakerId, t.transcriptId, t.workspaceId),
    index('action_items_person_idx').on(t.ownerPersonId, t.workspaceId),
    check(
      'action_items_status_check',
      sql`${t.status} IN ('open', 'done', 'rejected') AND ${t.source} IN ('ai', 'manual')`,
    ),
  ],
);

export const evidence = pgTable(
  'evidence',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    documentId: uuid('document_id').notNull(),
    transcriptId: uuid('transcript_id').notNull(),
    itemType: text('item_type').$type<'decision' | 'action_item'>().notNull(),
    itemId: uuid('item_id').notNull(),
    segmentId: uuid('segment_id').notNull(),
    decisionId: uuid('decision_id').generatedAlwaysAs(
      sql`CASE WHEN item_type = 'decision' THEN item_id END`,
    ),
    actionItemId: uuid('action_item_id').generatedAlwaysAs(
      sql`CASE WHEN item_type = 'action_item' THEN item_id END`,
    ),
  },
  (t) => [
    unique('evidence_item_segment_key').on(t.documentId, t.itemType, t.itemId, t.segmentId),
    index('evidence_decision_idx').on(t.decisionId, t.documentId, t.workspaceId),
    index('evidence_action_item_idx').on(t.actionItemId, t.documentId, t.workspaceId),
    index('evidence_segment_idx').on(t.segmentId, t.transcriptId, t.workspaceId),
    foreignKey({
      name: 'evidence_document_fk',
      columns: [t.documentId, t.transcriptId, t.workspaceId],
      foreignColumns: [
        meetingDocuments.id,
        meetingDocuments.transcriptId,
        meetingDocuments.workspaceId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'evidence_decision_fk',
      columns: [t.decisionId, t.documentId, t.workspaceId],
      foreignColumns: [decisions.id, decisions.documentId, decisions.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'evidence_action_item_fk',
      columns: [t.actionItemId, t.documentId, t.workspaceId],
      foreignColumns: [actionItems.id, actionItems.documentId, actionItems.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'evidence_segment_fk',
      columns: [t.segmentId, t.transcriptId, t.workspaceId],
      foreignColumns: [
        transcriptSegments.id,
        transcriptSegments.transcriptId,
        transcriptSegments.workspaceId,
      ],
    }).onDelete('cascade'),
    check('evidence_item_type_check', sql`${t.itemType} IN ('decision', 'action_item')`),
  ],
);
