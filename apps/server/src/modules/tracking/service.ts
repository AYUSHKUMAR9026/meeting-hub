import type { TrackedActionQuery, TrackedDecisionQuery } from '@meeting-hub/contracts';
import {
  actionItems,
  and,
  asc,
  decisions,
  eq,
  evidence,
  inArray,
  meetings,
  meetingDocuments,
  people,
  sql,
  transcriptSegments,
  transcriptSpeakers,
  workspaceSettings,
} from '@meeting-hub/db';

import type { Database } from '../../lib/db';
import { authorize, type WorkspaceActor } from '../auth';
import { actionFilters, pageCursor, trackerScope, trackerSort } from './queries';

type Items = typeof actionItems | typeof decisions;
function itemFields(table: Items) {
  return {
    id: table.id,
    title: table.title,
    description: table.description,
    transcriptId: table.transcriptId,
    meetingId: meetings.id,
    meetingTitle: meetings.title,
    meetingOccurredAt: meetings.occurredAt,
    createdBy: meetings.createdBy,
  };
}
const documentJoin = (table: Items) =>
  and(
    eq(table.documentId, meetingDocuments.id),
    eq(table.workspaceId, meetingDocuments.workspaceId),
  );
const meetingJoin = and(
  eq(meetingDocuments.meetingId, meetings.id),
  eq(meetingDocuments.workspaceId, meetings.workspaceId),
);

export class TrackerService {
  constructor(private readonly db: Database) {}

  async decisions(actor: WorkspaceActor, query: TrackedDecisionQuery) {
    authorize(actor, 'workspace.read');
    const rows = await this.db
      .select({ ...itemFields(decisions), status: decisions.status })
      .from(decisions)
      .innerJoin(meetingDocuments, documentJoin(decisions))
      .innerJoin(meetings, meetingJoin)
      .where(
        and(
          trackerScope(decisions, actor.workspaceId, query),
          query.status ? eq(decisions.status, query.status) : undefined,
        ),
      )
      .orderBy(...trackerSort(decisions, query.sort))
      .offset(query.cursor)
      .limit(query.limit + 1)
      .catch(() => {
        throw new Error('Could not read workspace decisions.');
      });
    return this.page(actor.workspaceId, 'decision', rows, query);
  }

  async actions(actor: WorkspaceActor, query: TrackedActionQuery) {
    authorize(actor, 'workspace.read');
    const [settings] = query.overdue
      ? await this.db
          .select({ timezone: workspaceSettings.timezone })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, actor.workspaceId))
          .limit(1)
      : [];
    const today = query.overdue
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: settings?.timezone ?? 'UTC',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date())
      : undefined;
    const [mine] = query.mine
      ? await this.db
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.workspaceId, actor.workspaceId), eq(people.userId, actor.userId)))
          .limit(1)
      : [];
    if (query.mine && !mine) return { items: [], nextCursor: null };
    const rows = await this.db
      .select({
        ...itemFields(actionItems),
        status: actionItems.status,
        dueDate: actionItems.dueDate,
        ownerPersonId: actionItems.ownerPersonId,
        ownerName: sql<
          string | null
        >`coalesce(${people.displayName}, ${transcriptSpeakers.displayName}, ${transcriptSpeakers.label})`,
      })
      .from(actionItems)
      .innerJoin(meetingDocuments, documentJoin(actionItems))
      .innerJoin(meetings, meetingJoin)
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
          trackerScope(actionItems, actor.workspaceId, query),
          actionFilters(query, mine?.id, today),
        ),
      )
      .orderBy(...trackerSort(actionItems, query.sort))
      .offset(query.cursor)
      .limit(query.limit + 1)
      .catch(() => {
        throw new Error('Could not read workspace action items.');
      });
    return this.page(actor.workspaceId, 'action_item', rows, query);
  }

  private async page<T extends { id: string; meetingOccurredAt: Date }>(
    workspaceId: string,
    type: 'decision' | 'action_item',
    rows: T[],
    query: { cursor: number; limit: number },
  ) {
    const items = rows.slice(0, query.limit);
    const ids = items.map(({ id }) => id);
    const links = ids.length
      ? await this.db
          .select({
            itemId: evidence.itemId,
            segmentId: evidence.segmentId,
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
            and(
              eq(evidence.workspaceId, workspaceId),
              eq(evidence.itemType, type),
              inArray(evidence.itemId, ids),
            ),
          )
          .orderBy(asc(transcriptSegments.idx))
      : [];
    const first = new Map<string, { segmentId: string; startMs: number }>();
    for (const { itemId, ...link } of links) if (!first.has(itemId)) first.set(itemId, link);
    return {
      items: items.map(({ meetingOccurredAt, ...item }) => ({
        ...item,
        meetingOccurredAt: meetingOccurredAt.toISOString(),
        citation: first.get(item.id) ?? null,
      })),
      nextCursor: pageCursor(rows.length, query.cursor, query.limit),
    };
  }
}
