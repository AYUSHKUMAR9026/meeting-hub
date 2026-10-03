'use client';

import { useCan, useCurrentUser, useWorkspace } from '@/components/app/workspace-context';
import type { Meeting } from '@/lib/api/client';

/**
 * What the current user may do with a meeting, for hiding controls only (the API enforces all of
 * it). Mirrors the server's rule: members edit and upload to their own meetings, admins to any.
 */
export function useMeetingPermissions(meeting: Pick<Meeting, 'createdBy'> | null) {
  const can = useCan();
  const user = useCurrentUser();
  const workspace = useWorkspace();
  const own = meeting?.createdBy === user.id;
  const anyMeeting = can('meeting.update_any');
  return {
    canCreate: can('meeting.create'),
    canEdit: can('meeting.update') && (anyMeeting || own),
    canUpload:
      workspace.features.includes('meetings.upload') &&
      can('recording.upload') &&
      (anyMeeting || own),
    canDelete: can('meeting.delete'),
    canDownload: can('recording.download'),
    uploadsEnabled: workspace.features.includes('meetings.upload'),
  };
}
