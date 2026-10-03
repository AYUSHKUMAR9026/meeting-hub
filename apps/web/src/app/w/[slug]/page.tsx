'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';

import { FormError } from '@/components/app/form-field';
import { useWorkspace } from '@/components/app/workspace-context';
import { MeetingTable } from '@/components/meetings/meeting-table';
import { useMeetingPermissions } from '@/components/meetings/use-meeting-permissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage } from '@/lib/api/client';

export default function WorkspaceDashboard() {
  const workspace = useWorkspace();
  const { canCreate } = useMeetingPermissions(null);
  const recent = useApiQuery(`recent-meetings:${workspace.id}`, () =>
    api.GET('/v1/workspaces/{wid}/meetings', {
      params: { path: { wid: workspace.id }, query: { limit: 5 } },
    }),
  );
  const newMeetingHref = `/w/${workspace.slug}/meetings/new`;

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{workspace.name}</h1>
        <Badge variant="secondary" data-testid="my-role">
          {workspace.role}
        </Badge>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Recent meetings</CardTitle>
            {recent.state.status === 'ok' && recent.state.data.meetings.length > 0 && (
              <Link
                href={`/w/${workspace.slug}/meetings`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                All meetings →
              </Link>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {recent.state.status === 'loading' && <Skeleton className="h-16 w-full" />}
          {recent.state.status === 'error' && (
            <FormError message={problemMessage(recent.state.error, 'Could not load meetings.')} />
          )}
          {recent.state.status === 'ok' &&
            (recent.state.data.meetings.length ? (
              <MeetingTable meetings={recent.state.data.meetings} />
            ) : (
              <div className="grid gap-3">
                <CardDescription>
                  No meetings yet. Upload a recording to get started, and{' '}
                  <Link
                    href={`/w/${workspace.slug}/settings/members`}
                    className="text-foreground underline underline-offset-4"
                  >
                    invite your team
                  </Link>
                  .
                </CardDescription>
                {canCreate && (
                  <Button
                    className="justify-self-start"
                    nativeButton={false}
                    render={<Link href={newMeetingHref} />}
                  >
                    <PlusIcon /> New meeting
                  </Button>
                )}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
