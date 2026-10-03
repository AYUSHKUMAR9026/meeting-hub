'use client';

import Link from 'next/link';

import { useWorkspace } from '@/components/app/workspace-context';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Meeting } from '@/lib/api/client';
import { formatInZone } from '@/lib/time-zone';

import { MeetingStatusBadge } from './meeting-status-badge';

/** Meetings with title, time (in the workspace's zone), participants and status. */
export function MeetingTable({ meetings }: { meetings: Meeting[] }) {
  const workspace = useWorkspace();
  const tz = workspace.settings.timezone;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>When</TableHead>
          <TableHead>Participants</TableHead>
          <TableHead className="text-right">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {meetings.map((m) => (
          <TableRow key={m.id} data-testid={`meeting-row-${m.id}`}>
            <TableCell className="font-medium">
              <Link href={`/w/${workspace.slug}/m/${m.id}`} className="hover:underline">
                {m.title}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatInZone(m.occurredAt, tz)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {m.participants.length
                ? m.participants
                    .slice(0, 3)
                    .map((p) => p.displayName)
                    .join(', ') +
                  (m.participants.length > 3 ? ` +${m.participants.length - 3}` : '')
                : '—'}
            </TableCell>
            <TableCell className="text-right">
              <MeetingStatusBadge status={m.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
