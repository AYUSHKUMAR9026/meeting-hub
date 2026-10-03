/**
 * Relationship rule for meetings that the role × action matrix can't express: members may edit and
 * upload to the meetings they created; owners and admins (`meeting.update_any`) to any meeting.
 */
import { ForbiddenError } from '../../../lib/errors';
import type { WorkspaceActor } from './authorize';
import { type Action, roleCan } from './permissions';

export interface MeetingRef {
  createdBy: string | null;
}

/** Whether `actor` may perform `action` (an edit-type action) on this particular meeting. */
export function canModifyMeeting(
  actor: WorkspaceActor,
  action: Extract<Action, 'meeting.update' | 'recording.upload'>,
  meeting: MeetingRef,
): boolean {
  if (!roleCan(actor.role, action)) return false;
  return roleCan(actor.role, 'meeting.update_any') || meeting.createdBy === actor.userId;
}

/**
 * Throws 403 when the actor can't modify the meeting. The caller can already see the meeting
 * (it passed `meeting.read`), so this is a 403, not a 404.
 */
export function assertCanModifyMeeting(
  actor: WorkspaceActor,
  action: Extract<Action, 'meeting.update' | 'recording.upload'>,
  meeting: MeetingRef,
): void {
  if (!canModifyMeeting(actor, action, meeting)) {
    throw new ForbiddenError('Only the meeting’s creator or a workspace admin can do this', {
      code: 'NOT_MEETING_CREATOR',
    });
  }
}
