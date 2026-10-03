import { withTimeout } from '../lib/time';
import type { MeetingDeletionJob, MeetingDeletionScheduler } from '../modules/meetings';
import { MEETING_DELETE_JOB } from './processors/meetings';
import type { LazyQueue } from './queues';

/**
 * The API's way to schedule a meeting purge on the maintenance queue. BullMQ connections retry
 * forever while Redis is down, so the enqueue is bounded; a lost enqueue is recovered by the hourly
 * `meeting.purge-deleted` sweep (ADR 0003).
 */
export function createMeetingDeletionScheduler(
  queue: LazyQueue,
  timeoutMs = 5_000,
): MeetingDeletionScheduler {
  return {
    async scheduleDeletion(job: MeetingDeletionJob) {
      await withTimeout(
        queue.get().add(MEETING_DELETE_JOB, job),
        timeoutMs,
        'enqueue meeting.delete',
      );
    },
  };
}
