'use client';
import Link from 'next/link';
import { useWorkspace } from '@/components/app/workspace-context';
import { Badge } from '@/components/ui/badge';
import type { Meeting } from '@/lib/api/client';
import { formatInZone } from '@/lib/time-zone';
import { MeetingStatusBadge } from './meeting-status-badge';

/** Shared meeting cards on the project dashboard and Meetings page. */
export function MeetingTable({ meetings }: { meetings: Meeting[] }) {
  const workspace = useWorkspace();
  return (
    <ul className="grid gap-4 md:grid-cols-2" aria-label="Meetings">
      {meetings.map((m) => (
        <li
          key={m.id}
          data-testid={`meeting-row-${m.id}`}
          className="grid gap-3 rounded-xl border bg-card p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              <Link href={`/w/${workspace.slug}/m/${m.id}`} className="hover:underline">
                {m.title}
              </Link>
            </h2>
            {m.roomStatus === 'live' ? (
              <Badge>Live</Badge>
            ) : m.roomStatus === 'scheduled' ? (
              <Badge variant="secondary">Scheduled</Badge>
            ) : (
              <MeetingStatusBadge status={m.pdfState === 'ready' ? 'ready' : m.status} />
            )}
          </div>
          <time dateTime={m.occurredAt} className="text-sm text-muted-foreground">
            {formatInZone(m.occurredAt, workspace.settings.timezone)}
          </time>
          <p className="text-sm">
            {m.participants.length
              ? m.participants.map((p) => p.displayName).join(', ')
              : 'No participants listed'}
          </p>
          <div className="flex gap-4 text-sm">
            {m.roomStatus === 'live' && (
              <Link className="font-medium underline" href={`/w/${workspace.slug}/m/${m.id}/room`}>
                Join meeting
              </Link>
            )}
            {m.pdfState === 'ready' && (
              <Link className="font-medium underline" href={`/w/${workspace.slug}/m/${m.id}`}>
                View PDF
              </Link>
            )}
            {m.pdfState === 'failed' && (
              <Link className="underline" href={`/w/${workspace.slug}/m/${m.id}`}>
                PDF failed. Retry
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
