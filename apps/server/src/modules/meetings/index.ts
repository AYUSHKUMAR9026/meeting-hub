// Public API of the meetings module: meetings, their participants and recording uploads.
import type { Database } from '../../lib/db';
import type { Logger } from '../../lib/logger';
import type { AuditService } from '../audit';
import type { ObjectStorage } from '../media';
import { MeetingMaintenance } from './meeting-maintenance';
import { MeetingRepository } from './meeting-repository';
import {
  type MeetingDeletionScheduler,
  MeetingService,
  type RunCanceller,
} from './meeting-service';
import { type UploadLimits, UploadService } from './upload-service';

export { MeetingMaintenance, type PurgeResult } from './meeting-maintenance';
export type { Meeting, MeetingInput, Participant, Recording } from './meeting-repository';
export {
  type MeetingDeletionJob,
  type MeetingDeletionScheduler,
  MeetingService,
  type RunCanceller,
} from './meeting-service';
export {
  type CompletedUpload,
  RECORDING_UPLOADED_EVENT,
  type StartUploadInput,
  type UploadLimits,
  type UploadSession,
  UploadService,
} from './upload-service';

export function createMeetingServices(deps: {
  db: Database;
  storage: ObjectStorage;
  audit: AuditService;
  logger: Logger;
  deletions: MeetingDeletionScheduler;
  runs: RunCanceller;
  limits: UploadLimits;
}): { meetings: MeetingService; uploads: UploadService } {
  const repo = new MeetingRepository(deps.db);
  const logger = deps.logger.child({ module: 'meetings' });
  return {
    meetings: new MeetingService({
      repo,
      audit: deps.audit,
      deletions: deps.deletions,
      runs: deps.runs,
      logger,
    }),
    uploads: new UploadService({
      repo,
      storage: deps.storage,
      audit: deps.audit,
      logger,
      limits: deps.limits,
    }),
  };
}

export function createMeetingMaintenance(deps: {
  db: Database;
  storage: ObjectStorage;
  audit: AuditService;
  logger: Logger;
  runs: RunCanceller;
  staleAfterHours: number;
}): MeetingMaintenance {
  return new MeetingMaintenance({
    repo: new MeetingRepository(deps.db),
    storage: deps.storage,
    audit: deps.audit,
    logger: deps.logger.child({ module: 'meetings.maintenance' }),
    runs: deps.runs,
    staleAfterHours: deps.staleAfterHours,
  });
}
