'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import { FormError, FormField, NativeSelect } from '@/components/app/form-field';
import { useCan, useCurrentUser, useWorkspace } from '@/components/app/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage } from '@/lib/api/client';
import type { components, paths } from '@/lib/api/schema';
import { formValue } from '@/lib/form';
import { formatDuration } from '@/lib/processing';

type TrackerKind = 'decision' | 'action';
type TrackerPage =
  components['schemas']['TrackedActionPage'] | components['schemas']['TrackedDecisionPage'];
type TrackerItem = TrackerPage['items'][number];
type ActionFilters = NonNullable<
  paths['/v1/workspaces/{wid}/action-items']['get']['parameters']['query']
>;
type DecisionFilters = NonNullable<
  paths['/v1/workspaces/{wid}/decisions']['get']['parameters']['query']
>;

export function WorkspaceTracker({ kind }: { kind: TrackerKind }) {
  const workspace = useWorkspace();
  const title = kind === 'action' ? 'Action items' : 'Decisions';
  return (
    <div className="grid gap-5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {workspace.features.includes('review.enabled') ? (
        <Tracker kind={kind} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Document review is unavailable in this workspace.
        </p>
      )}
    </div>
  );
}

function Tracker({ kind }: { kind: TrackerKind }) {
  const workspace = useWorkspace();
  const user = useCurrentUser();
  const can = useCan();
  const actions = kind === 'action';
  const [filters, setFilters] = useState<{ decision: DecisionFilters; action: ActionFilters }>({
    decision: {},
    action: {},
  });
  const [pages, setPages] = useState<number[]>([0]);
  const [busy, setBusy] = useState<string>();
  const [filterError, setFilterError] = useState('');
  const [meetingPages, setMeetingPages] = useState<(string | undefined)[]>([undefined]);
  const [meetingId, setMeetingId] = useState('');
  const [meetingName, setMeetingName] = useState('');
  const [ownerSearch, setOwnerSearch] = useState('');
  const [ownerQuery, setOwnerQuery] = useState('');
  const path = { wid: workspace.id };
  const meetingPage = meetingPages.at(-1);
  const meetings = useApiQuery(JSON.stringify([path.wid, 'tracker-meetings', meetingPage]), () =>
    api.GET('/v1/workspaces/{wid}/meetings', {
      params: { path, query: { cursor: meetingPage, limit: 50 } },
    }),
  );
  const people = useApiQuery<components['schemas']['PersonList']>(
    JSON.stringify([path.wid, 'tracker-people', ownerQuery]),
    () =>
      actions
        ? api.GET('/v1/workspaces/{wid}/people', {
            params: { path, query: { q: ownerQuery || undefined, limit: 50 } },
          })
        : Promise.resolve({ response: new Response() }),
  );
  const cursor = pages.at(-1);
  const result = useApiQuery<TrackerPage>(JSON.stringify([path.wid, kind, filters, cursor]), () =>
    actions
      ? api.GET('/v1/workspaces/{wid}/action-items', {
          params: { path, query: { ...filters.action, cursor } },
        })
      : api.GET('/v1/workspaces/{wid}/decisions', {
          params: { path, query: { ...filters.decision, cursor } },
        }),
  );

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const base = { meetingId: meetingId || undefined, q: formValue(form, 'q').trim() || undefined };
    const sortInput = formValue(form, 'sort');
    const sort = sortInput === 'oldest' || sortInput === 'title' ? sortInput : 'newest';
    const status = formValue(form, 'status');
    const dueFrom = formValue(form, 'dueFrom') || undefined;
    const dueTo = formValue(form, 'dueTo') || undefined;
    if (dueFrom && dueTo && dueFrom > dueTo) {
      setFilterError('The start of the due date range must come before the end.');
      return;
    }
    setFilterError('');
    setPages([0]);
    setFilters({
      decision: {
        ...base,
        sort,
        status:
          status === 'proposed' || status === 'confirmed' || status === 'rejected'
            ? status
            : undefined,
      },
      action: {
        ...base,
        sort: sortInput === 'due' ? 'due' : sort,
        status:
          status === 'open' || status === 'done' || status === 'rejected' ? status : undefined,
        ownerPersonId: formValue(form, 'ownerPersonId') || undefined,
        mine: form.has('mine') ? 'true' : undefined,
        dueFrom,
        dueTo,
      },
    });
  }

  async function change(item: TrackerItem, reject: boolean) {
    const params = { path: { id: item.meetingId, itemId: item.id } };
    setBusy(item.id);
    try {
      const response =
        'dueDate' in item
          ? await api.PATCH('/v1/meetings/{id}/action-items/{itemId}', {
              params,
              body: { status: reject ? 'rejected' : 'done' },
            })
          : await api.PATCH('/v1/meetings/{id}/decisions/{itemId}', {
              params,
              body: { status: reject ? 'rejected' : 'confirmed' },
            });
      if (response.response.ok) result.reload();
      else toast.error(problemMessage(response.error, 'Could not update the item.'));
    } catch {
      toast.error('Could not update the item.');
    } finally {
      setBusy(undefined);
    }
  }

  const availableMeetings = meetings.state.status === 'ok' ? meetings.state.data.meetings : [];
  const nextMeetingPage = meetings.state.status === 'ok' ? meetings.state.data.nextCursor : null;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: workspace.settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return (
    <div className="grid gap-5">
      <form className="grid gap-4 rounded-lg border p-4" onSubmit={apply}>
        <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField id="q" label="Search title or description" maxLength={160} />
          <div className="grid gap-1.5">
            <Label htmlFor="tracker-status">Status</Label>
            <NativeSelect id="tracker-status" name="status">
              <option value="">All statuses</option>
              {actions ? (
                <>
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                </>
              ) : (
                <>
                  <option value="proposed">Proposed</option>
                  <option value="confirmed">Confirmed</option>
                </>
              )}
              <option value="rejected">Rejected</option>
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tracker-meeting">Meeting</Label>
            <NativeSelect
              id="tracker-meeting"
              value={meetingId}
              onChange={(event) => {
                setMeetingId(event.target.value);
                setMeetingName(
                  availableMeetings.find((meeting) => meeting.id === event.target.value)?.title ??
                    '',
                );
              }}
            >
              <option value="">All meetings</option>
              {meetingId && !availableMeetings.some((meeting) => meeting.id === meetingId) && (
                <option value={meetingId}>{meetingName}</option>
              )}
              {availableMeetings.map((meeting) => (
                <option key={meeting.id} value={meeting.id}>
                  {meeting.title}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tracker-sort">Sort by</Label>
            <NativeSelect id="tracker-sort" name="sort" defaultValue={actions ? 'due' : 'newest'}>
              {actions && <option value="due">Due date</option>}
              <option value="newest">Newest meeting</option>
              <option value="oldest">Oldest meeting</option>
              <option value="title">Title</option>
            </NativeSelect>
          </div>
        </div>
        {(meetingPages.length > 1 || nextMeetingPage) && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={meetingPages.length === 1}
              onClick={() => setMeetingPages(meetingPages.slice(0, -1))}
            >
              Newer meeting options
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!nextMeetingPage}
              onClick={() => setMeetingPages([...meetingPages, nextMeetingPage ?? undefined])}
            >
              Older meeting options
            </Button>
          </div>
        )}
        {meetings.state.status === 'error' && (
          <FormError message="Could not load meeting filter options." />
        )}
        {actions && (
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-end gap-1">
              <FormField
                id="tracker-people-search"
                label="Find an owner"
                maxLength={100}
                value={ownerSearch}
                onChange={(event) => setOwnerSearch(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setOwnerQuery(ownerSearch.trim())}
              >
                Find
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tracker-owner">Owner</Label>
              <NativeSelect id="tracker-owner" name="ownerPersonId">
                <option value="">All owners</option>
                {people.state.status === 'ok' &&
                  people.state.data.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.displayName}
                    </option>
                  ))}
              </NativeSelect>
            </div>
            <FormField id="dueFrom" label="Due on or after" type="date" />
            <FormField id="dueTo" label="Due on or before" type="date" />
            <Label>
              <input type="checkbox" name="mine" /> My action items
            </Label>
          </div>
        )}
        {actions && people.state.status === 'error' && (
          <FormError message="Could not load owner options." />
        )}
        {filterError && <FormError message={filterError} />}
        <Button className="justify-self-start" type="submit" size="sm">
          Apply filters
        </Button>
      </form>
      {result.state.status === 'loading' && <Skeleton className="h-28" />}
      {result.state.status === 'error' && (
        <FormError message={problemMessage(result.state.error, 'Could not load the tracker.')} />
      )}
      {result.state.status === 'ok' && (
        <>
          {result.state.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">No items match these filters.</p>
          )}
          <ul className="grid gap-3">
            {result.state.data.items.map((item) => {
              const href = '/w/' + workspace.slug + '/m/' + item.meetingId;
              const citation = item.citation;
              const canEdit =
                can('meeting.update') && (can('meeting.update_any') || item.createdBy === user.id);
              const due = 'dueDate' in item && item.dueDate;
              const daysLeft = due
                ? Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000)
                : null;
              return (
                <li key={item.id} className="grid gap-2 rounded-lg border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{item.title}</h2>
                    <Badge variant="outline" className="capitalize">
                      {item.status}
                    </Badge>
                    {item.status === 'open' && daysLeft !== null && daysLeft <= 7 && (
                      <Badge variant={daysLeft < 0 ? 'destructive' : 'secondary'}>
                        {daysLeft < 0 ? 'Overdue' : daysLeft === 0 ? 'Due today' : 'Due soon'}
                      </Badge>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{item.description}</p>
                  {'ownerName' in item && (
                    <p className="text-sm text-muted-foreground">
                      {[
                        item.ownerName ?? 'Unassigned',
                        item.dueDate ? 'Due ' + item.dueDate : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <Link href={href} className="underline underline-offset-4">
                      {item.meetingTitle}
                    </Link>
                    {citation && (
                      <Link
                        href={
                          href +
                          '?' +
                          new URLSearchParams({
                            transcript: item.transcriptId,
                            segment: citation.segmentId,
                            t: String(citation.startMs),
                          }).toString()
                        }
                        className="underline underline-offset-4"
                      >
                        Evidence at {formatDuration(citation.startMs)}
                      </Link>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex flex-wrap gap-2">
                      {item.status !== 'done' && item.status !== 'confirmed' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busy)}
                          onClick={() => void change(item, false)}
                        >
                          {actions ? 'Mark done' : 'Confirm'}
                        </Button>
                      )}
                      {item.status !== 'rejected' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={Boolean(busy)}
                          onClick={() => void change(item, true)}
                        >
                          Reject
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pages.length === 1}
              onClick={() => setPages(pages.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={result.state.data.nextCursor === null}
              onClick={() => {
                if (result.state.status === 'ok' && result.state.data.nextCursor !== null)
                  setPages([...pages, result.state.data.nextCursor]);
              }}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
