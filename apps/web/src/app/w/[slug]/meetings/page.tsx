'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { FormError, NativeSelect } from '@/components/app/form-field';
import { useWorkspace } from '@/components/app/workspace-context';
import { MeetingTable } from '@/components/meetings/meeting-table';
import { useMeetingPermissions } from '@/components/meetings/use-meeting-permissions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, type Meeting, type MeetingStatus, problemMessage } from '@/lib/api/client';
import { nextDay, startOfDayInZone } from '@/lib/time-zone';

const statusOptions: { value: '' | MeetingStatus; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'awaiting_upload', label: 'Awaiting upload' },
  { value: 'uploading', label: 'Uploading' },
  { value: 'uploaded', label: 'Uploaded' },
];

export default function MeetingsPage() {
  const workspace = useWorkspace();
  const { canCreate } = useMeetingPermissions(null);
  const tz = workspace.settings.timezone;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<'' | MeetingStatus>('');
  const [extra, setExtra] = useState<{ key: string; meetings: Meeting[]; cursor: string | null }>();
  const [loadingMore, setLoadingMore] = useState(false);

  // Day filters are calendar days in the workspace's time zone; `to` includes the whole day.
  const query = {
    limit: 25,
    ...(status ? { status } : {}),
    ...(from ? { from: startOfDayInZone(from, tz).toISOString() } : {}),
    ...(to ? { to: startOfDayInZone(nextDay(to), tz).toISOString() } : {}),
  };
  const key = `meetings:${workspace.id}:${JSON.stringify(query)}`;
  const first = useApiQuery(key, () =>
    api.GET('/v1/workspaces/{wid}/meetings', {
      params: { path: { wid: workspace.id }, query },
    }),
  );

  const filtered = Boolean(from || to || status);
  const more = extra?.key === key ? extra : undefined;
  const meetings =
    first.state.status === 'ok' ? [...first.state.data.meetings, ...(more?.meetings ?? [])] : [];
  const nextCursor =
    first.state.status === 'ok' ? (more ? more.cursor : first.state.data.nextCursor) : null;

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    const { data } = await api.GET('/v1/workspaces/{wid}/meetings', {
      params: { path: { wid: workspace.id }, query: { ...query, cursor: nextCursor } },
    });
    setLoadingMore(false);
    if (data) {
      setExtra({
        key,
        meetings: [...(more?.meetings ?? []), ...data.meetings],
        cursor: data.nextCursor,
      });
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Meetings</h1>
        {canCreate && (
          <Button nativeButton={false} render={<Link href={`/w/${workspace.slug}/meetings/new`} />}>
            <PlusIcon /> New meeting
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="sr-only">Meeting list</CardTitle>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">Status</Label>
              <NativeSelect
                id="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as '' | MeetingStatus)}
              >
                {statusOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFrom('');
                  setTo('');
                  setStatus('');
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
          <CardDescription>Times are shown in {tz}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {first.state.status === 'loading' && (
            <div className="grid gap-2" aria-busy="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {first.state.status === 'error' && (
            <FormError message={problemMessage(first.state.error, 'Could not load meetings.')} />
          )}
          {first.state.status === 'ok' && meetings.length === 0 && (
            <div className="grid justify-items-center gap-3 py-8 text-center">
              <p className="font-medium">
                {filtered ? 'No meetings match these filters.' : 'No meetings yet'}
              </p>
              {!filtered && (
                <p className="max-w-sm text-sm text-muted-foreground">
                  Create a meeting and upload its recording. Transcripts and the decision ledger
                  will build on it.
                </p>
              )}
              {!filtered && canCreate && (
                <Button
                  nativeButton={false}
                  render={<Link href={`/w/${workspace.slug}/meetings/new`} />}
                >
                  <PlusIcon /> New meeting
                </Button>
              )}
            </div>
          )}
          {meetings.length > 0 && <MeetingTable meetings={meetings} />}
          {nextCursor && (
            <Button
              variant="outline"
              className="justify-self-center"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
