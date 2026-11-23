import type {
  AddActionItem,
  AddDecision,
  MeetingDocumentResponse,
  PatchActionItem,
  PatchDecision,
} from '@meeting-hub/contracts';
import {
  actionItems,
  and,
  asc,
  decisions,
  desc,
  eq,
  evidence,
  inArray,
  isNull,
  meetingDocuments,
  meetings,
  people,
  sql,
  transcriptSegments,
  transcriptSpeakers,
} from '@meeting-hub/db';

import type { Database, Transaction } from '../../lib/db';
import { BadRequestError, ConflictError, NotFoundError, isAppError } from '../../lib/errors';
import type { AuditService, RequestOrigin } from '../audit';
import { assertCanModifyMeeting, authorize, type WorkspaceActor } from '../auth';

type Kind = 'decision' | 'action_item';
type Add =
  | { kind: 'decision'; operation: 'add'; data: AddDecision }
  | { kind: 'action_item'; operation: 'add'; data: AddActionItem };
type Patch =
  | { kind: 'decision'; operation: 'update'; id: string; data: PatchDecision }
  | { kind: 'action_item'; operation: 'update'; id: string; data: PatchActionItem };
type Delete = { kind: Kind; operation: 'delete'; id: string };
type Mutation = Add | Patch | Delete;

export class DocumentService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async read(
    actor: WorkspaceActor,
    meetingId: string,
    documentId?: string,
  ): Promise<MeetingDocumentResponse> {
    authorize(actor, 'meeting.read');
    const db = this.db;
    const scope = and(
      eq(meetingDocuments.workspaceId, actor.workspaceId),
      eq(meetingDocuments.meetingId, meetingId),
      eq(meetingDocuments.status, 'completed'),
    );
    const [revisions, [document]] = await Promise.all([
      db
        .select({
          id: meetingDocuments.id,
          createdAt: meetingDocuments.createdAt,
          isCurrent: meetingDocuments.isCurrent,
          hasHumanEdits: sql<boolean>`exists (select 1 from ${decisions} where document_id = meeting_documents.id and edited_by_user) or exists (select 1 from ${actionItems} where document_id = meeting_documents.id and edited_by_user)`,
        })
        .from(meetingDocuments)
        .where(scope)
        .orderBy(desc(meetingDocuments.createdAt), desc(meetingDocuments.id)),
      db
        .select({
          id: meetingDocuments.id,
          transcriptId: meetingDocuments.transcriptId,
          processingRunId: meetingDocuments.processingRunId,
          model: meetingDocuments.model,
          promptVersion: meetingDocuments.promptVersion,
          inputTokens: meetingDocuments.inputTokens,
          outputTokens: meetingDocuments.outputTokens,
          createdAt: meetingDocuments.createdAt,
          isCurrent: meetingDocuments.isCurrent,
          summary: meetingDocuments.summary,
        })
        .from(meetingDocuments)
        .where(
          and(
            scope,
            documentId ? eq(meetingDocuments.id, documentId) : eq(meetingDocuments.isCurrent, true),
          ),
        )
        .limit(1),
    ]);
    const history = revisions.map(({ createdAt, ...revision }) => ({
      ...revision,
      createdAt: createdAt.toISOString(),
    }));
    if (!document?.summary) {
      if (documentId) throw new NotFoundError('Meeting document not found');
      return { document: null, revisions: history };
    }
    const [decisionRows, actionRows, links] = await Promise.all([
      db
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.workspaceId, actor.workspaceId),
            eq(decisions.documentId, document.id),
            isNull(decisions.deletedAt),
          ),
        )
        .orderBy(asc(decisions.idx)),
      db
        .select({
          item: actionItems,
          ownerName: sql<
            string | null
          >`coalesce(${people.displayName}, ${transcriptSpeakers.displayName}, ${transcriptSpeakers.label})`,
        })
        .from(actionItems)
        .leftJoin(
          people,
          and(
            eq(people.id, actionItems.ownerPersonId),
            eq(people.workspaceId, actionItems.workspaceId),
          ),
        )
        .leftJoin(
          transcriptSpeakers,
          and(
            eq(transcriptSpeakers.id, actionItems.ownerSpeakerId),
            eq(transcriptSpeakers.workspaceId, actionItems.workspaceId),
          ),
        )
        .where(
          and(
            eq(actionItems.workspaceId, actor.workspaceId),
            eq(actionItems.documentId, document.id),
            isNull(actionItems.deletedAt),
          ),
        )
        .orderBy(asc(actionItems.idx)),
      db
        .select({
          itemId: evidence.itemId,
          segmentId: evidence.segmentId,
          idx: transcriptSegments.idx,
          startMs: transcriptSegments.startMs,
        })
        .from(evidence)
        .innerJoin(
          transcriptSegments,
          and(
            eq(transcriptSegments.id, evidence.segmentId),
            eq(transcriptSegments.transcriptId, evidence.transcriptId),
            eq(transcriptSegments.workspaceId, evidence.workspaceId),
          ),
        )
        .where(
          and(eq(evidence.workspaceId, actor.workspaceId), eq(evidence.documentId, document.id)),
        )
        .orderBy(asc(transcriptSegments.idx)),
    ]);
    const byItem = new Map<string, Omit<(typeof links)[number], 'itemId'>[]>();
    for (const { itemId, ...citation } of links) {
      const existing = byItem.get(itemId);
      if (existing) existing.push(citation);
      else byItem.set(itemId, [citation]);
    }
    return {
      document: {
        ...document,
        createdAt: document.createdAt.toISOString(),
        summary: document.summary,
        decisions: decisionRows.map((row) => ({
          id: row.id,
          idx: row.idx,
          title: row.title,
          description: row.description,
          rationale: row.rationale,
          status: row.status,
          editedByUser: row.editedByUser,
          source: row.source,
          citations: byItem.get(row.id) ?? [],
        })),
        actionItems: actionRows.map(({ item: row, ownerName }) => ({
          id: row.id,
          idx: row.idx,
          title: row.title,
          description: row.description,
          dueDate: row.dueDate,
          ownerSpeakerId: row.ownerSpeakerId,
          ownerPersonId: row.ownerPersonId,
          ownerName,
          status: row.status,
          editedByUser: row.editedByUser,
          source: row.source,
          citations: byItem.get(row.id) ?? [],
        })),
      },
      revisions: history,
    };
  }

  async mutate(
    actor: WorkspaceActor,
    meetingId: string,
    mutation: Mutation,
    origin: RequestOrigin,
  ) {
    const workspaceId = actor.workspaceId;
    const id = await this.db.transaction(async (tx) => {
      const [meeting] = await tx
        .select({ createdBy: meetings.createdBy })
        .from(meetings)
        .where(
          and(
            eq(meetings.id, meetingId),
            eq(meetings.workspaceId, workspaceId),
            isNull(meetings.deletedAt),
          ),
        );
      if (!meeting) throw new NotFoundError('Meeting not found');
      assertCanModifyMeeting(actor, 'meeting.update', meeting);

      const [document] = await tx
        .select({ id: meetingDocuments.id, transcriptId: meetingDocuments.transcriptId })
        .from(meetingDocuments)
        .where(
          and(
            eq(meetingDocuments.workspaceId, workspaceId),
            eq(meetingDocuments.meetingId, meetingId),
            eq(meetingDocuments.isCurrent, true),
          ),
        )
        .for('update');
      if (!document)
        throw new ConflictError('ANALYSIS_DOCUMENT_MISSING', 'Create a meeting summary first.');
      const scope = { documentId: document.id, transcriptId: document.transcriptId, workspaceId };
      const itemTable = mutation.kind === 'decision' ? decisions : actionItems;
      try {
        if (mutation.operation === 'add') {
          const [last] = await tx
            .select({ idx: itemTable.idx })
            .from(itemTable)
            .where(
              and(eq(itemTable.documentId, document.id), eq(itemTable.workspaceId, workspaceId)),
            )
            .orderBy(desc(itemTable.idx))
            .limit(1);
          const shared = {
            ...scope,
            idx: (last?.idx ?? -1) + 1,
            editedByUser: true,
            source: 'manual' as const,
          };
          const row =
            mutation.kind === 'decision'
              ? (
                  await tx
                    .insert(decisions)
                    .values({
                      ...shared,
                      title: mutation.data.title,
                      description: mutation.data.description,
                      rationale: mutation.data.rationale,
                    })
                    .returning({ id: decisions.id })
                )[0]!
              : (
                  await tx
                    .insert(actionItems)
                    .values({
                      ...shared,
                      title: mutation.data.title,
                      description: mutation.data.description,
                      dueDate: mutation.data.dueDate,
                    })
                    .returning({ id: actionItems.id })
                )[0]!;
          await this.replaceEvidence(
            tx,
            { ...scope, itemType: mutation.kind, itemId: row.id },
            mutation.data.segmentIds,
          );
          return row.id;
        }
        const match = and(
          eq(itemTable.id, mutation.id),
          eq(itemTable.documentId, document.id),
          eq(itemTable.workspaceId, workspaceId),
          isNull(itemTable.deletedAt),
        );
        let rows: { id: string }[];
        if (mutation.operation === 'delete') {
          rows = await tx
            .update(itemTable)
            .set({ deletedAt: new Date(), editedByUser: true })
            .where(match)
            .returning({ id: itemTable.id });
        } else if (mutation.kind === 'decision') {
          const { segmentIds, ...data } = mutation.data;
          rows = await tx
            .update(decisions)
            .set({ ...data, editedByUser: true })
            .where(match)
            .returning({ id: decisions.id });
          if (rows.length && segmentIds)
            await this.replaceEvidence(
              tx,
              { ...scope, itemType: mutation.kind, itemId: mutation.id },
              segmentIds,
            );
        } else {
          const { segmentIds, ...data } = mutation.data;
          rows = await tx
            .update(actionItems)
            .set({ ...data, editedByUser: true })
            .where(match)
            .returning({ id: actionItems.id });
          if (rows.length && segmentIds)
            await this.replaceEvidence(
              tx,
              { ...scope, itemType: mutation.kind, itemId: mutation.id },
              segmentIds,
            );
        }
        if (!rows.length) throw new NotFoundError('The item was not found in the current document');
        return mutation.id;
      } catch (error) {
        if (isAppError(error)) throw error;
        // eslint-disable-next-line preserve-caught-error -- Drizzle errors can include private item text.
        throw new Error('Could not save the meeting document item.');
      }
    });
    const action =
      mutation.operation === 'add'
        ? 'analysis.item_added'
        : mutation.operation === 'update'
          ? 'analysis.item_updated'
          : 'analysis.item_deleted';
    await this.audit.record({
      action,
      workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: {
        itemId: id,
        itemType: mutation.kind,
        fields: mutation.operation === 'delete' ? [] : Object.keys(mutation.data),
      },
      origin,
    });
    return { id };
  }

  private async replaceEvidence(
    tx: Transaction,
    scope: Pick<
      typeof evidence.$inferInsert,
      'workspaceId' | 'documentId' | 'transcriptId' | 'itemType' | 'itemId'
    >,
    ids: string[],
  ) {
    const segmentIds = [...new Set(ids)];
    const found = await tx
      .select({ id: transcriptSegments.id })
      .from(transcriptSegments)
      .where(
        and(
          eq(transcriptSegments.workspaceId, scope.workspaceId),
          eq(transcriptSegments.transcriptId, scope.transcriptId),
          inArray(transcriptSegments.id, segmentIds),
        ),
      );
    if (found.length !== segmentIds.length || !found.length)
      throw new BadRequestError(
        'Citations must refer to segments from this document’s transcript.',
      );
    await tx
      .delete(evidence)
      .where(
        and(
          eq(evidence.workspaceId, scope.workspaceId),
          eq(evidence.documentId, scope.documentId),
          eq(evidence.itemType, scope.itemType),
          eq(evidence.itemId, scope.itemId),
        ),
      );
    await tx.insert(evidence).values(segmentIds.map((segmentId) => ({ ...scope, segmentId })));
  }
}
