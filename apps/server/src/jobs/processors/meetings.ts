import type { Job } from 'bullmq';
import { z } from 'zod';

import { PermanentError } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import type { MeetingMaintenance, PurgeResult } from '../../modules/meetings';

export const MEETING_DELETE_JOB = 'meeting.delete';
export const ABORT_STALE_UPLOADS_JOB = 'media.abort-stale-uploads';
export const PURGE_DELETED_SWEEP_JOB = 'meeting.purge-deleted';

/** How long a soft-deleted meeting may linger before the sweep re-enqueues its purge. */
export const PURGE_GRACE_MS = 15 * 60_000;

const meetingDeleteData = z.object({
  meetingId: z.uuid(),
  workspaceId: z.uuid(),
  requestedBy: z.uuid().nullable(),
});
export type MeetingDeleteData = z.infer<typeof meetingDeleteData>;

export interface MeetingJobDeps {
  maintenance: MeetingMaintenance;
  logger: Logger;
  /** Enqueues a meeting.delete job (the sweep uses it to recover lost purges). */
  enqueueDelete: (data: MeetingDeleteData) => Promise<unknown>;
}

/** Purges one soft-deleted meeting: storage objects, then rows, then an audit entry. */
export function createMeetingDeleteProcessor(deps: MeetingJobDeps) {
  return async (job: Job): Promise<PurgeResult> => {
    const parsed = meetingDeleteData.safeParse(job.data);
    if (!parsed.success)
      throw new PermanentError('INVALID_JOB_DATA', 'meeting.delete needs a meetingId');
    return deps.maintenance.purgeMeeting(parsed.data.meetingId, parsed.data.requestedBy);
  };
}

/** Hourly: aborts multipart uploads that were abandoned and marks their recordings failed. */
export function createAbortStaleUploadsProcessor(deps: MeetingJobDeps) {
  return async (_job: Job): Promise<{ aborted: number }> => deps.maintenance.abortStaleUploads();
}

/** Hourly: re-enqueues purges for soft-deleted meetings still present after the grace period. */
export function createPurgeDeletedSweepProcessor(deps: MeetingJobDeps) {
  return async (_job: Job): Promise<{ requeued: number }> => {
    const ids = await deps.maintenance.findUnpurged(new Date(), PURGE_GRACE_MS);
    for (const { meetingId, workspaceId } of ids) {
      await deps.enqueueDelete({ meetingId, workspaceId, requestedBy: null });
    }
    if (ids.length) deps.logger.warn({ count: ids.length }, 're-enqueued lost meeting purges');
    return { requeued: ids.length };
  };
}
