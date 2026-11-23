import {
  actionItems,
  and,
  asc,
  type decisions,
  desc,
  eq,
  gte,
  ilike,
  isNull,
  lte,
  meetings,
  meetingDocuments,
  or,
} from '@meeting-hub/db';
import type { TrackedActionQuery, TrackedDecisionQuery } from '@meeting-hub/contracts';

type Items = typeof actionItems | typeof decisions;
export const literalSearch = (value: string) => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';

export function trackerScope(
  table: Items,
  workspaceId: string,
  query: Pick<TrackedDecisionQuery, 'meetingId' | 'q'>,
) {
  const search = query.q ? literalSearch(query.q) : undefined;
  return and(
    eq(table.workspaceId, workspaceId),
    isNull(table.deletedAt),
    eq(meetingDocuments.isCurrent, true),
    isNull(meetings.deletedAt),
    query.meetingId ? eq(meetings.id, query.meetingId) : undefined,
    search ? or(ilike(table.title, search), ilike(table.description, search)) : undefined,
  );
}

export function actionFilters(query: TrackedActionQuery, myPersonId: string | undefined) {
  return and(
    query.status ? eq(actionItems.status, query.status) : undefined,
    query.ownerPersonId ? eq(actionItems.ownerPersonId, query.ownerPersonId) : undefined,
    myPersonId ? eq(actionItems.ownerPersonId, myPersonId) : undefined,
    query.dueFrom ? gte(actionItems.dueDate, query.dueFrom) : undefined,
    query.dueTo ? lte(actionItems.dueDate, query.dueTo) : undefined,
  );
}

export function trackerSort(table: Items, sort: TrackedActionQuery['sort']) {
  if (sort === 'title') return [asc(table.title), asc(table.id)];
  if (sort === 'oldest') return [asc(meetings.occurredAt), asc(table.id)];
  if (sort === 'due') return [asc(actionItems.dueDate), desc(meetings.occurredAt), asc(table.id)];
  return [desc(meetings.occurredAt), desc(table.id)];
}

export const pageCursor = (count: number, offset: number, limit: number) =>
  count > limit && offset + limit <= 100_000 ? offset + limit : null;
