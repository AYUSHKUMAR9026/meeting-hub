import type { Logger } from '../../lib/logger';
import type { AuditService } from '../audit';
import { meetingPrefix, type ObjectStorage } from '../media';
import type { MeetingRepository } from './meeting-repository';

const BATCH = 100;

export interface PurgeResult {
  purged: boolean;
  deletedObjects: number;
  abortedUploads: number;
}

/**
 * Background clean-up for meetings and uploads, called by the maintenance jobs. Every operation is
 * idempotent: a retried or duplicated job finds less (or nothing) to do.
 */
export class MeetingMaintenance {
  constructor(
    private readonly deps: {
      repo: MeetingRepository;
      storage: ObjectStorage;
      audit: AuditService;
      logger: Logger;
      staleAfterHours: number;
    },
  ) {}

  /**
   * Aborts multipart uploads started more than `staleAfterHours` ago and marks their recordings
   * failed (the meeting goes back to awaiting_upload). Each one is re-checked under the row lock, so
   * an upload that completes meanwhile is left alone.
   */
  async abortStaleUploads(now: Date = new Date()): Promise<{ aborted: number }> {
    const { repo, storage, audit, logger } = this.deps;
    const cutoff = new Date(now.getTime() - this.deps.staleAfterHours * 3_600_000);
    let aborted = 0;
    for (;;) {
      const stale = await repo.findStaleUploads(cutoff, BATCH);
      let progressed = 0;
      for (const candidate of stale) {
        const done = await repo.withLockedUpload(
          candidate.workspaceId,
          candidate.meetingId,
          candidate.id,
          async (recording, tx) => {
            if (recording?.status !== 'uploading') return false;
            if (recording.s3UploadId) {
              await storage.abortMultipartUpload(recording.storageKey, recording.s3UploadId);
            }
            await tx.markFailed(recording);
            return true;
          },
        );
        if (!done) continue;
        progressed += 1;
        await audit.record({
          action: 'upload.failed',
          workspaceId: candidate.workspaceId,
          target: { type: 'meeting', id: candidate.meetingId },
          metadata: { recordingId: candidate.id, reason: 'stale' },
        });
      }
      aborted += progressed;
      // Stop when the batch wasn't full, or nothing in it could be handled (avoids spinning).
      if (stale.length < BATCH || progressed === 0) break;
    }
    if (aborted) logger.info({ aborted }, 'aborted stale uploads');
    return { aborted };
  }

  /**
   * Deletes a soft-deleted meeting for good: aborts in-flight uploads, deletes every object under
   * its storage prefix (in batches of 1,000), deletes its rows, and audits the purge.
   */
  async purgeMeeting(meetingId: string, requestedBy: string | null): Promise<PurgeResult> {
    const { repo, storage, audit, logger } = this.deps;
    const meeting = await repo.findDeleted(meetingId);
    if (!meeting) return { purged: false, deletedObjects: 0, abortedUploads: 0 };

    let abortedUploads = 0;
    for (const recording of meeting.recordings) {
      if (recording.status === 'uploading' && recording.s3UploadId) {
        await storage.abortMultipartUpload(recording.storageKey, recording.s3UploadId);
        abortedUploads += 1;
      }
    }
    const deletedObjects = await storage.deletePrefix(
      meetingPrefix(meeting.workspaceId, meeting.id),
    );
    const purged = await repo.purge(meeting.id);
    if (purged) {
      await audit.record({
        action: 'meeting.purged',
        workspaceId: meeting.workspaceId,
        actorUserId: requestedBy,
        target: { type: 'meeting', id: meeting.id },
        metadata: { deletedObjects, abortedUploads },
      });
    }
    logger.info({ meetingId, deletedObjects, abortedUploads }, 'meeting purged');
    return { purged, deletedObjects, abortedUploads };
  }

  /** Soft-deleted meetings older than `graceMs` that are still around (their purge was lost). */
  findUnpurged(now: Date, graceMs: number): Promise<{ meetingId: string; workspaceId: string }[]> {
    return this.deps.repo.findUnpurged(new Date(now.getTime() - graceMs), BATCH);
  }
}
