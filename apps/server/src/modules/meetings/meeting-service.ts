import { AppError, NotFoundError } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import type { AuditService, RequestOrigin } from '../audit';
import { assertCanModifyMeeting, authorize, type WorkspaceActor } from '../auth';
import {
  type Meeting,
  type MeetingInput,
  type MeetingListOptions,
  type MeetingRepository,
  UnknownParticipantsError,
} from './meeting-repository';

/** Enqueues the background purge of a soft-deleted meeting (implemented with BullMQ in deps.ts). */
export interface MeetingDeletionScheduler {
  scheduleDeletion(job: MeetingDeletionJob): Promise<void>;
}

/**
 * Cancels a meeting's in-flight processing run (implemented by the processing module and injected,
 * so meetings doesn't depend on it). Must be idempotent: deletion and purge both call it.
 */
export interface RunCanceller {
  cancelForMeeting(meetingId: string, reason: 'meeting_deleted' | 'upload_failed'): Promise<void>;
}

export interface MeetingDeletionJob {
  meetingId: string;
  workspaceId: string;
  /** Who asked for the deletion; null when the sweep re-enqueues a lost purge. */
  requestedBy: string | null;
}

export const meetingNotFound = () => new NotFoundError('Meeting not found');

function unknownParticipants(err: UnknownParticipantsError) {
  return new AppError(
    'UNKNOWN_PARTICIPANTS',
    `These participants are not in this workspace's people directory: ${err.ids.join(', ')}`,
    { status: 400 },
  );
}

/**
 * Meeting use cases. Routes enforce the role check first (http/access.ts); the service checks again
 * and applies the creator rule for edits.
 */
export class MeetingService {
  constructor(
    private readonly deps: {
      repo: MeetingRepository;
      audit: AuditService;
      deletions: MeetingDeletionScheduler;
      runs: RunCanceller;
      logger: Logger;
    },
  ) {}

  workspaceIdForMember(meetingId: string, userId: string): Promise<string | null> {
    return this.deps.repo.workspaceIdForMember(meetingId, userId);
  }

  async create(
    actor: WorkspaceActor,
    input: MeetingInput,
    origin: RequestOrigin,
  ): Promise<Meeting> {
    authorize(actor, 'meeting.create');
    let id: string;
    try {
      id = await this.deps.repo.create(actor.workspaceId, actor.userId, input);
    } catch (err) {
      if (err instanceof UnknownParticipantsError) throw unknownParticipants(err);
      throw err;
    }
    await this.deps.audit.record({
      action: 'meeting.created',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id },
      metadata: { participantCount: input.participantIds.length },
      origin,
    });
    return this.get(actor, id);
  }

  list(actor: WorkspaceActor, options: MeetingListOptions) {
    authorize(actor, 'meeting.read');
    return this.deps.repo.list(actor.workspaceId, options);
  }

  async get(actor: WorkspaceActor, id: string): Promise<Meeting> {
    authorize(actor, 'meeting.read');
    const meeting = await this.deps.repo.get(actor.workspaceId, id);
    if (!meeting) throw meetingNotFound();
    return meeting;
  }

  async update(
    actor: WorkspaceActor,
    id: string,
    patch: Partial<MeetingInput>,
    origin: RequestOrigin,
  ): Promise<Meeting> {
    const meeting = await this.get(actor, id);
    assertCanModifyMeeting(actor, 'meeting.update', meeting);
    try {
      if (!(await this.deps.repo.update(actor.workspaceId, id, patch))) throw meetingNotFound();
    } catch (err) {
      if (err instanceof UnknownParticipantsError) throw unknownParticipants(err);
      throw err;
    }
    await this.deps.audit.record({
      action: 'meeting.updated',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id },
      metadata: {
        fields: Object.keys(patch).filter((k) => patch[k as keyof MeetingInput] !== undefined),
      },
      origin,
    });
    return this.get(actor, id);
  }

  /**
   * Soft-deletes now (the meeting vanishes from every query) and schedules the purge of its storage
   * objects and rows. If scheduling fails, the hourly sweep picks the meeting up (ADR 0003).
   */
  async delete(actor: WorkspaceActor, id: string, origin: RequestOrigin): Promise<void> {
    authorize(actor, 'meeting.delete');
    if (!(await this.deps.repo.softDelete(actor.workspaceId, id))) throw meetingNotFound();
    await this.deps.audit.record({
      action: 'meeting.deleted',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id },
      origin,
    });
    try {
      // Stops a run in flight now; the purge job cancels again in case this fails.
      await this.deps.runs.cancelForMeeting(id, 'meeting_deleted');
    } catch (err) {
      this.deps.logger.error({ err, meetingId: id }, 'could not cancel processing; the purge will');
    }
    try {
      await this.deps.deletions.scheduleDeletion({
        meetingId: id,
        workspaceId: actor.workspaceId,
        requestedBy: actor.userId,
      });
    } catch (err) {
      this.deps.logger.error(
        { err, meetingId: id },
        'could not schedule meeting purge; the sweep will retry',
      );
    }
  }
}
