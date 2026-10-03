'use client';

import Link from 'next/link';

import { useWorkspace } from '@/components/app/workspace-context';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Placeholder dashboard until meetings arrive (Phase 3). */
export default function WorkspaceDashboard() {
  const workspace = useWorkspace();
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
          <CardTitle>No meetings yet</CardTitle>
          <CardDescription>
            Recordings, transcripts and the decision ledger will appear here. In the meantime,{' '}
            <Link
              href={`/w/${workspace.slug}/settings/members`}
              className="text-foreground underline underline-offset-4"
            >
              invite your team
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
