import { isAllowedUploadType } from '@meeting-hub/contracts';

import { isUniqueViolation } from '../../lib/db';
import { AppError, ConflictError, NotFoundError } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import type { AuditService, RequestOrigin } from '../audit';
import { assertCanModifyMeeting, authorize, type WorkspaceActor } from '../auth';
import {
  type CompletedPart,
  firstBatch,
  type ObjectStorage,
  originalRecordingKey,
  planUpload,
  type PresignedPart,
  validateCompletedParts,
} from '../media';
import {
  type Meeting,
  type MeetingRepository,
  type Recording,
  UploadRaceError,
} from './meeting-repository';
import { meetingNotFound } from './meeting-service';

/** The outbox event type Phase 4's processing pipeline consumes. */
export const RECORDING_UPLOADED_EVENT = 'recording.uploaded';

export interface UploadLimits {
  partSizeBytes: number;
  urlTtlSeconds: number;
  urlBatchSize: number;
  maxUploadBytes: number;
  downloadUrlTtlSeconds: number;
}

export interface StartUploadInput {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadSession {
  uploadId: string;
  meetingId: string;
  partSize: number;
  partCount: number;
  urlsExpireAt: Date;
  parts: PresignedPart[];
}

export interface CompletedUpload {
  uploadId: string;
  meetingId: string;
  status: 'uploaded';
  sizeBytes: number;
}

const uploadNotFound = () => new NotFoundError('Upload not found');
const alreadyCompleted = () =>
  new ConflictError('UPLOAD_ALREADY_COMPLETED', 'This upload has already completed');
const notInProgress = () =>
  new ConflictError(
    'UPLOAD_NOT_IN_PROGRESS',
    'This upload is no longer in progress; start a new one',
  );

/** S3 rejected the part list (wrong ETag, missing part, part too small). The client can fix it. */
const isInvalidParts = (err: unknown) =>
  ['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'].includes(
    (err as { name?: string } | null)?.name ?? '',
  );

type CompleteOutcome =
  | { kind: 'completed'; recording: Recording; sizeBytes: number }
  | { kind: 'already_completed'; recording: Recording }
  | { kind: 'size_mismatch'; recording: Recording; actualBytes: number }
  | { kind: 'object_missing'; recording: Recording };

/**
 * Direct-to-storage uploads (ADR 0003): the browser PUTs parts to presigned URLs; this service only
 * creates, signs, completes and aborts multipart uploads and keeps Postgres in step.
 */
export class UploadService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      repo: MeetingRepository;
      storage: ObjectStorage;
      audit: AuditService;
      logger: Logger;
      limits: UploadLimits;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async start(
    actor: WorkspaceActor,
    meetingId: string,
    input: StartUploadInput,
    idempotencyKey: string,
    origin: RequestOrigin,
  ): Promise<UploadSession> {
    const { repo, storage, limits } = this.deps;
    const meeting = await this.modifiableMeeting(actor, meetingId);
    const contentType = input.contentType.toLowerCase();

    const previous = await repo.findByIdempotencyKey(actor.workspaceId, idempotencyKey);
    if (previous) return this.replay(previous, meetingId, { ...input, contentType });

    if (!isAllowedUploadType(contentType)) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        `Files of type "${input.contentType}" can't be uploaded. Use an audio or video file (MP3, M4A, WAV, OGG, WebM, MP4 or MOV).`,
        { status: 415 },
      );
    }
    if (input.sizeBytes > limits.maxUploadBytes) {
      throw new AppError(
        'UPLOAD_TOO_LARGE',
        `The file is larger than the ${formatBytes(limits.maxUploadBytes)} limit.`,
        { status: 413 },
      );
    }
    const current = meeting.recording;
    if (current?.status === 'uploading') {
      throw new ConflictError(
        'UPLOAD_IN_PROGRESS',
        'An upload for this meeting is already in progress',
      );
    }
    if (current && current.status !== 'failed') {
      throw new ConflictError('RECORDING_EXISTS', 'This meeting already has a recording');
    }

    const plan = planUpload(input.sizeBytes, limits.partSizeBytes);
    const storageKey = originalRecordingKey(actor.workspaceId, meetingId);
    const s3UploadId = await storage.createMultipartUpload(storageKey, contentType);
    let recording: Recording;
    try {
      recording = await repo.saveStartedUpload(
        {
          meetingId,
          workspaceId: actor.workspaceId,
          storageKey,
          originalFilename: input.fileName,
          contentType,
          sizeBytes: input.sizeBytes,
          s3UploadId,
          partSize: plan.partSize,
          consentConfirmedBy: actor.userId,
          consentConfirmedAt: this.now(),
          idempotencyKey,
        },
        current ?? undefined,
      );
    } catch (err) {
      await storage
        .abortMultipartUpload(storageKey, s3UploadId)
        .catch((abortErr: unknown) =>
          this.deps.logger.warn(
            { err: abortErr, storageKey },
            'could not abort orphaned multipart upload',
          ),
        );
      if (isUniqueViolation(err) || err instanceof UploadRaceError) {
        // Lost a race: either the same request retried concurrently, or another upload started.
        const winner = await repo.findByIdempotencyKey(actor.workspaceId, idempotencyKey);
        if (winner) return this.replay(winner, meetingId, { ...input, contentType });
        throw new ConflictError(
          'UPLOAD_IN_PROGRESS',
          'An upload for this meeting is already in progress',
        );
      }
      throw err;
    }

    await this.deps.audit.record({
      action: 'upload.started',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: {
        recordingId: recording.id,
        contentType,
        sizeBytes: input.sizeBytes,
        partCount: plan.partCount,
        consentConfirmed: true,
      },
      origin,
    });
    return this.session(recording, firstBatch(plan.partCount, limits.urlBatchSize));
  }

  /** Fresh presigned URLs for some parts of an upload in progress. */
  async presignParts(
    actor: WorkspaceActor,
    meetingId: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ urlsExpireAt: Date; parts: PresignedPart[] }> {
    const recording = await this.findUpload(actor, meetingId, uploadId);
    if (recording.status === 'uploaded') throw alreadyCompleted();
    if (recording.status !== 'uploading') throw notInProgress();
    const { partCount } = planFor(recording);
    const invalid = partNumbers.filter((n) => n > partCount);
    if (invalid.length) {
      throw new AppError('INVALID_PART_NUMBER', `This upload has parts 1 to ${partCount} only`, {
        status: 400,
      });
    }
    const { urlsExpireAt, parts } = await this.session(recording, partNumbers);
    return { urlsExpireAt, parts };
  }

  /**
   * Completes the multipart upload, checks the stored size against the declared one, and marks the
   * recording and meeting uploaded together with the outbox event. Idempotent: a repeated or
   * concurrent call waits on the row lock and returns the same result without side effects.
   */
  async complete(
    actor: WorkspaceActor,
    meetingId: string,
    uploadId: string,
    parts: CompletedPart[],
    origin: RequestOrigin,
  ): Promise<CompletedUpload> {
    const { repo, storage } = this.deps;
    await this.modifiableMeeting(actor, meetingId);

    const outcome = await repo.withLockedUpload<CompleteOutcome>(
      actor.workspaceId,
      meetingId,
      uploadId,
      async (recording, tx) => {
        if (!recording) throw uploadNotFound();
        if (recording.status === 'uploaded') return { kind: 'already_completed', recording };
        if (recording.status !== 'uploading' || !recording.s3UploadId) throw notInProgress();

        const checked = validateCompletedParts(parts, planFor(recording).partCount);
        if (!checked.ok) throw new AppError('INVALID_PARTS', checked.message, { status: 400 });
        try {
          // 'missing' = S3 already completed it on an earlier attempt whose commit didn't happen;
          // the HEAD below tells us whether the object is there.
          await storage.completeMultipartUpload(
            recording.storageKey,
            recording.s3UploadId,
            checked.parts,
          );
        } catch (err) {
          if (isInvalidParts(err)) {
            throw new AppError(
              'INVALID_PARTS',
              'Storage rejected the part list: a part is missing, too small, or its ETag is wrong',
              { status: 400, cause: err },
            );
          }
          throw err;
        }

        const head = await storage.headObject(recording.storageKey);
        if (!head) {
          await tx.markFailed(recording);
          return { kind: 'object_missing', recording };
        }
        if (head.sizeBytes !== recording.sizeBytes) {
          await storage.deleteObject(recording.storageKey);
          await tx.markFailed(recording);
          return { kind: 'size_mismatch', recording, actualBytes: head.sizeBytes };
        }
        await tx.markUploaded(recording, head.sizeBytes, {
          type: RECORDING_UPLOADED_EVENT,
          payload: {
            workspaceId: recording.workspaceId,
            meetingId: recording.meetingId,
            recordingId: recording.id,
            storageKey: recording.storageKey,
            contentType: recording.contentType,
            sizeBytes: head.sizeBytes,
          },
        });
        return { kind: 'completed', recording, sizeBytes: head.sizeBytes };
      },
    );

    const audit = (
      action: 'upload.completed' | 'upload.failed',
      metadata: Record<string, unknown>,
    ) =>
      this.deps.audit.record({
        action,
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        target: { type: 'meeting', id: meetingId },
        metadata: { recordingId: uploadId, ...metadata },
        origin,
      });

    switch (outcome.kind) {
      case 'completed':
        await audit('upload.completed', { sizeBytes: outcome.sizeBytes });
        return { uploadId, meetingId, status: 'uploaded', sizeBytes: outcome.sizeBytes };
      case 'already_completed':
        return { uploadId, meetingId, status: 'uploaded', sizeBytes: outcome.recording.sizeBytes };
      case 'size_mismatch':
        await audit('upload.failed', {
          reason: 'size_mismatch',
          declaredBytes: outcome.recording.sizeBytes,
          actualBytes: outcome.actualBytes,
        });
        throw new AppError(
          'UPLOAD_SIZE_MISMATCH',
          `The uploaded file is ${outcome.actualBytes} bytes but ${outcome.recording.sizeBytes} were declared; it was discarded`,
          { status: 422 },
        );
      case 'object_missing':
        await audit('upload.failed', { reason: 'object_missing' });
        throw new AppError(
          'UPLOAD_INCOMPLETE',
          'Storage has no record of this upload any more; start a new one',
          { status: 422 },
        );
    }
  }

  /** Cancels an upload in progress: aborts it in storage and forgets it. */
  async abort(
    actor: WorkspaceActor,
    meetingId: string,
    uploadId: string,
    origin: RequestOrigin,
  ): Promise<void> {
    await this.modifiableMeeting(actor, meetingId);
    await this.deps.repo.withLockedUpload(
      actor.workspaceId,
      meetingId,
      uploadId,
      async (recording, tx) => {
        if (!recording) throw uploadNotFound();
        if (recording.status === 'uploaded') throw alreadyCompleted();
        if (recording.s3UploadId) {
          await this.deps.storage.abortMultipartUpload(recording.storageKey, recording.s3UploadId);
        }
        await tx.deleteUpload(recording);
      },
    );
    await this.deps.audit.record({
      action: 'upload.aborted',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { recordingId: uploadId },
      origin,
    });
  }

  /** The original recording with a short-lived attachment download URL (owners/admins only). */
  async download(
    actor: WorkspaceActor,
    meetingId: string,
    origin: RequestOrigin,
  ): Promise<{ recording: Recording; downloadUrl: string; downloadUrlExpiresAt: Date }> {
    authorize(actor, 'recording.download');
    const meeting = await this.deps.repo.get(actor.workspaceId, meetingId);
    if (!meeting) throw meetingNotFound();
    const recording = meeting.recording;
    if (recording?.status !== 'uploaded') {
      throw new NotFoundError('This meeting has no uploaded recording');
    }
    const ttl = this.deps.limits.downloadUrlTtlSeconds;
    const downloadUrl = await this.deps.storage.presignDownload(recording.storageKey, {
      fileName: recording.originalFilename,
      contentType: recording.contentType,
      expiresIn: ttl,
    });
    await this.deps.audit.record({
      action: 'recording.downloaded',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { recordingId: recording.id },
      origin,
    });
    return {
      recording,
      downloadUrl,
      downloadUrlExpiresAt: new Date(this.now().getTime() + ttl * 1000),
    };
  }

  // --- helpers ------------------------------------------------------------------------------------

  /** The visible meeting, if the actor may upload to it (404 if not visible, 403 if not theirs). */
  private async modifiableMeeting(actor: WorkspaceActor, meetingId: string): Promise<Meeting> {
    authorize(actor, 'recording.upload');
    const meeting = await this.deps.repo.get(actor.workspaceId, meetingId);
    if (!meeting) throw meetingNotFound();
    assertCanModifyMeeting(actor, 'recording.upload', meeting);
    return meeting;
  }

  private async findUpload(actor: WorkspaceActor, meetingId: string, uploadId: string) {
    const meeting = await this.modifiableMeeting(actor, meetingId);
    if (meeting.recording?.id !== uploadId) throw uploadNotFound();
    return meeting.recording;
  }

  /** Same key again: the same upload (with fresh URLs) if it's the same request, else an error. */
  private async replay(
    recording: Recording,
    meetingId: string,
    input: StartUploadInput,
  ): Promise<UploadSession> {
    const sameRequest =
      recording.meetingId === meetingId &&
      recording.originalFilename === input.fileName &&
      recording.contentType === input.contentType &&
      recording.sizeBytes === input.sizeBytes;
    if (!sameRequest) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different upload',
        { status: 422 },
      );
    }
    if (recording.status === 'uploaded') throw alreadyCompleted();
    if (recording.status !== 'uploading') throw notInProgress();
    return this.session(
      recording,
      firstBatch(planFor(recording).partCount, this.deps.limits.urlBatchSize),
    );
  }

  private async session(recording: Recording, partNumbers: number[]): Promise<UploadSession> {
    const { partSize, partCount } = planFor(recording);
    const ttl = this.deps.limits.urlTtlSeconds;
    const urlsExpireAt = new Date(this.now().getTime() + ttl * 1000);
    const parts = await this.deps.storage.presignUploadParts(
      recording.storageKey,
      recording.s3UploadId!,
      partNumbers,
      ttl,
    );
    return {
      uploadId: recording.id,
      meetingId: recording.meetingId,
      partSize,
      partCount,
      urlsExpireAt,
      parts,
    };
  }
}

/** The part layout fixed when the upload started (part size is stored with the recording). */
function planFor(recording: Recording): { partSize: number; partCount: number } {
  const partSize = recording.partSize!;
  return { partSize, partCount: Math.max(1, Math.ceil(recording.sizeBytes / partSize)) };
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
