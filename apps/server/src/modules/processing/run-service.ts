import type { MeetingStatus, RunStatus, RunTrigger, StepStatus } from '@meeting-hub/db';
import { z } from 'zod';

import type { Database, Transaction } from '../../lib/db';
import { ConflictError, NotFoundError } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import { withTimeout } from '../../lib/time';
import type { AuditService, RequestOrigin } from '../audit';
import { authorize, roleCan, type WorkspaceActor } from '../auth';
import { NORMALIZED_AUDIO, type ObjectStorage } from '../media';
import type { AfterCommit, OutboxHandler } from '../platform';
import type { StepQueue } from './driver';
import {
  CURRENT_PIPELINE_VERSION,
  getStep,
  type StepName,
  type StepRegistry,
  stepsOf,
} from './pipeline';
import { computeRunProgress, type ProgressPublisher } from './progress';
import {
  OBJECTS_SUPERSEDED_EVENT,
  type ProcessingRepository,
  type RunRecord,
  type StepRecord,
} from './repository';

/** The outbox event (written by the meetings module) that starts a run. */
export const RECORDING_UPLOADED = 'recording.uploaded';

export interface StepView {
  name: string;
  status: StepStatus;
  attempts: number;
  /** This step's own progress, 0..1. */
  progress: number;
  phase: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Owners and admins only; absent for everyone else. */
  errorDetail?: string | null;
}

export interface RunView {
  id: string;
  status: RunStatus;
  trigger: RunTrigger;
  pipelineVersion: number;
  currentStep: string | null;
  /** Overall progress, 0..1. */
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  steps: StepView[];
}

export interface ProcessingView {
  meetingStatus: MeetingStatus;
  run: RunView | null;
}

export interface MediaView {
  audio: {
    url: string;
    contentType: string;
    sizeBytes: number;
    durationMs: number | null;
    codec: string | null;
    sampleRate: number | null;
    channels: number | null;
  };
  peaks: { url: string } | null;
  expiresAt: Date;
}

/** Lets the meetings module cancel runs without depending on this module (ADR 0004). */
export interface ProcessingCanceller {
  cancelForMeeting(meetingId: string, reason: 'meeting_deleted' | 'upload_failed'): Promise<void>;
}

const meetingNotFound = () => new NotFoundError('Meeting not found');

const uploadedPayload = z.object({
  workspaceId: z.uuid(),
  meetingId: z.uuid(),
  recordingId: z.uuid(),
});
const supersededPayload = z.object({ keys: z.array(z.string().min(1)).max(1_000) });

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/**
 * Processing use cases for the API and the outbox (ADR 0004): read a meeting's run, request a
 * reprocess, sign media URLs, cancel runs, and start a run when a recording is uploaded.
 */
export class RunService implements ProcessingCanceller {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      db: Database;
      repo: ProcessingRepository;
      registry: StepRegistry;
      queue: StepQueue;
      storage: ObjectStorage;
      publisher: ProgressPublisher;
      audit: AuditService;
      logger: Logger;
      mediaUrlTtlSeconds: number;
      enqueueTimeoutMs?: number;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  // --- API ------------------------------------------------------------------------------------------

  async getProcessing(actor: WorkspaceActor, meetingId: string): Promise<ProcessingView> {
    authorize(actor, 'meeting.read');
    const meeting = await this.deps.repo.findVisibleMeeting(actor.workspaceId, meetingId);
    if (!meeting) throw meetingNotFound();
    const latest = await this.deps.repo.latestRun(actor.workspaceId, meetingId);
    return {
      meetingStatus: meeting.status,
      run: latest
        ? this.toView(latest.run, latest.steps, roleCan(actor.role, 'processing.view_error_detail'))
        : null,
    };
  }

  /** Starts a new run on the meeting's original recording (owners/admins). 409 if one is active. */
  async requestReprocess(
    actor: WorkspaceActor,
    meetingId: string,
    fromStep: StepName | undefined,
    origin: RequestOrigin,
  ): Promise<ProcessingView> {
    authorize(actor, 'processing.reprocess');
    const { repo } = this.deps;
    const meeting = await repo.findVisibleMeeting(actor.workspaceId, meetingId);
    if (!meeting) throw meetingNotFound();
    const original = await repo.findRecording(actor.workspaceId, meetingId, 'original');
    if (original?.status !== 'uploaded') {
      throw new ConflictError('RECORDING_NOT_UPLOADED', 'This meeting has no uploaded recording');
    }
    const created = await this.deps.db.transaction((tx) =>
      repo.createRun(
        tx,
        {
          workspaceId: actor.workspaceId,
          meetingId,
          recordingId: original.id,
          trigger: 'reprocess',
          pipelineVersion: CURRENT_PIPELINE_VERSION,
          requestedBy: actor.userId,
          fromStep,
        },
        this.now(),
      ),
    );
    if ('conflict' in created) {
      throw new ConflictError(
        'RUN_ALREADY_ACTIVE',
        'This meeting is already being processed; wait for it to finish',
      );
    }
    await this.deps.audit.record({
      action: 'processing.reprocess_requested',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { runId: created.run.id, fromStep: fromStep ?? null },
      origin,
    });
    await this.started(created.run, actor.userId);
    return this.getProcessing(actor, meetingId);
  }

  /** Short-lived signed URLs for the normalized audio (inline) and its peaks. */
  async getMedia(actor: WorkspaceActor, meetingId: string): Promise<MediaView> {
    authorize(actor, 'meeting.read');
    const { repo, storage, mediaUrlTtlSeconds } = this.deps;
    if (!(await repo.findVisibleMeeting(actor.workspaceId, meetingId))) throw meetingNotFound();
    const normalized = await repo.findRecording(actor.workspaceId, meetingId, 'normalized');
    if (normalized?.status !== 'uploaded') {
      throw new NotFoundError('This meeting has no processed audio yet');
    }
    const contentType = normalized.contentType || NORMALIZED_AUDIO.contentType;
    const [audioUrl, peaksUrl] = await Promise.all([
      storage.presignInline(normalized.storageKey, { contentType, expiresIn: mediaUrlTtlSeconds }),
      normalized.peaksStorageKey
        ? storage.presignInline(normalized.peaksStorageKey, {
            contentType: 'application/json',
            expiresIn: mediaUrlTtlSeconds,
          })
        : null,
    ]);
    return {
      audio: {
        url: audioUrl,
        contentType,
        sizeBytes: normalized.sizeBytes,
        durationMs: normalized.durationMs,
        codec: normalized.codec,
        sampleRate: normalized.sampleRate,
        channels: normalized.channels,
      },
      peaks: peaksUrl ? { url: peaksUrl } : null,
      expiresAt: new Date(this.now().getTime() + mediaUrlTtlSeconds * 1000),
    };
  }

  // --- cancellation ---------------------------------------------------------------------------------

  async cancelForMeeting(
    meetingId: string,
    reason: 'meeting_deleted' | 'upload_failed',
  ): Promise<void> {
    const run = await this.deps.repo.cancelActiveRun(meetingId, this.now());
    if (!run) return;
    this.deps.logger.info({ run_id: run.id, meetingId, reason }, 'processing run cancelled');
    await this.deps.publisher.runChanged({
      workspaceId: run.workspaceId,
      meetingId,
      runId: run.id,
    });
    await this.deps.audit.record({
      action: 'processing.run_cancelled',
      workspaceId: run.workspaceId,
      target: { type: 'meeting', id: meetingId },
      metadata: { runId: run.id, reason },
    });
  }

  // --- outbox ---------------------------------------------------------------------------------------

  outboxHandlers(): OutboxHandler[] {
    return [
      {
        type: RECORDING_UPLOADED,
        flag: 'pipeline.media',
        handle: (event, tx) => this.onRecordingUploaded(event.payload, tx),
      },
      {
        type: OBJECTS_SUPERSEDED_EVENT,
        handle: async (event) => {
          const { keys } = supersededPayload.parse(event.payload);
          await this.deps.storage.deleteObjects(keys);
        },
      },
    ];
  }

  /** Creates the upload run (idempotent: the same event twice → one run). */
  private async onRecordingUploaded(
    payload: Record<string, unknown>,
    tx: Transaction,
  ): Promise<AfterCommit | void> {
    const parsed = uploadedPayload.safeParse(payload);
    if (!parsed.success) {
      this.deps.logger.error({ payload: Object.keys(payload) }, 'malformed recording.uploaded');
      return;
    }
    const { workspaceId, meetingId, recordingId } = parsed.data;
    const { repo } = this.deps;
    const [meeting, recording] = await Promise.all([
      repo.findVisibleMeeting(workspaceId, meetingId),
      repo.findRecordingById(workspaceId, recordingId),
    ]);
    if (!meeting || recording?.status !== 'uploaded' || recording.meetingId !== meetingId) {
      this.deps.logger.info(
        { meetingId, recordingId },
        'recording.uploaded for a gone recording; ignored',
      );
      return;
    }
    const created = await repo.createRun(
      tx,
      {
        workspaceId,
        meetingId,
        recordingId,
        trigger: 'upload',
        pipelineVersion: CURRENT_PIPELINE_VERSION,
        requestedBy: null,
      },
      this.now(),
    );
    if ('conflict' in created) {
      this.deps.logger.info({ meetingId, conflict: created.conflict }, 'upload run already exists');
      return;
    }
    return () => this.started(created.run, null);
  }

  /** After a run's creation committed: enqueue its first pending step, publish, audit. */
  private async started(run: RunRecord, actorUserId: string | null): Promise<void> {
    const first = run.currentStep ?? stepsOf(run.pipelineVersion)[0]!;
    try {
      await withTimeout(
        this.deps.queue.ensure({ runId: run.id, step: first }, getStep(this.deps.registry, first)),
        this.deps.enqueueTimeoutMs ?? 5_000,
        'enqueue first step',
      );
    } catch (err) {
      this.deps.logger.error(
        { err, run_id: run.id, step: first },
        'could not enqueue the first step; the sweeper will',
      );
    }
    await this.deps.publisher.runChanged({
      workspaceId: run.workspaceId,
      meetingId: run.meetingId,
      runId: run.id,
    });
    await this.deps.audit.record({
      action: 'processing.run_started',
      workspaceId: run.workspaceId,
      actorUserId,
      target: { type: 'meeting', id: run.meetingId },
      metadata: { runId: run.id, trigger: run.trigger, pipelineVersion: run.pipelineVersion },
    });
  }

  // --- views ----------------------------------------------------------------------------------------

  private toView(run: RunRecord, steps: StepRecord[], withDetail: boolean): RunView {
    const weightOf = (name: string) => this.deps.registry.get(name as StepName)?.weight ?? 1;
    const stepViews = steps.map((s): StepView => {
      const progress =
        s.status === 'succeeded' || s.status === 'skipped' ? 1 : (num(s.metadata.progress) ?? 0);
      return {
        name: s.name,
        status: s.status,
        attempts: s.attempts,
        progress,
        phase: s.status === 'running' ? str(s.metadata.phase) : null,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
        ...(withDetail ? { errorDetail: s.errorDetail } : {}),
      };
    });
    return {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      pipelineVersion: run.pipelineVersion,
      currentStep: run.currentStep,
      progress:
        run.status === 'completed'
          ? 1
          : computeRunProgress(
              stepViews.map((s) => ({
                status: s.status,
                weight: weightOf(s.name),
                progress: s.progress,
              })),
            ),
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      steps: stepViews,
    };
  }
}
