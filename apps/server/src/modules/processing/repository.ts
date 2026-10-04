import {
  activeRunStatuses,
  and,
  asc,
  desc,
  domainEvents,
  eq,
  inArray,
  isNull,
  meetings,
  type MeetingStatus,
  type NewRecording,
  processingRuns,
  processingSteps,
  type ProcessingRunRow,
  type ProcessingStepRow,
  type RecordingRow,
  recordings,
  type RunStatus,
  type RunTrigger,
  sql,
} from '@meeting-hub/db';

import { type Database, type Transaction, violatedConstraint } from '../../lib/db';
import type { StepFailure } from './errors';
import { type RunRef, type StepName, stepsOf } from './pipeline';

export type RunRecord = ProcessingRunRow;
export type StepRecord = ProcessingStepRow;
export type Executor = Database | Transaction;

/** The outbox event that tells the dispatcher to delete objects a reprocess replaced. */
export const OBJECTS_SUPERSEDED_EVENT = 'media.objects_superseded';

const ACTIVE = [...activeRunStatuses] as RunStatus[];
const isActive = (status: RunStatus) => ACTIVE.includes(status);

export const toRunRef = (run: RunRecord): RunRef => ({
  id: run.id,
  workspaceId: run.workspaceId,
  meetingId: run.meetingId,
  recordingId: run.recordingId,
  trigger: run.trigger,
  pipelineVersion: run.pipelineVersion,
});

export interface NewRunInput {
  workspaceId: string;
  meetingId: string;
  recordingId: string;
  trigger: RunTrigger;
  pipelineVersion: number;
  requestedBy: string | null;
  /** Steps before this one are created as `skipped` (reprocess from a later step). */
  fromStep?: StepName | undefined;
}

/** Why a run couldn't be created. */
export type CreateRunConflict = 'run_active' | 'upload_run_exists';

/**
 * Data access for processing runs and steps (ADR 0004). State transitions run inside transactions
 * that lock the run row, so the driver, the sweeper and cancellation never interleave on one run.
 */
export class ProcessingRepository {
  constructor(private readonly db: Database) {}

  /**
   * Creates a run, its step rows and moves the meeting to `processing`, inside `tx`, in a savepoint
   * so a conflict leaves the caller's transaction usable.
   */
  async createRun(
    tx: Transaction,
    input: NewRunInput,
    now: Date,
  ): Promise<{ run: RunRecord } | { conflict: CreateRunConflict }> {
    const steps = stepsOf(input.pipelineVersion);
    const from = input.fromStep ? steps.indexOf(input.fromStep) : 0;
    if (from < 0)
      throw new Error(`step ${input.fromStep} is not in pipeline v${input.pipelineVersion}`);
    try {
      return await tx.transaction(async (sp) => {
        const [run] = await sp
          .insert(processingRuns)
          .values({
            workspaceId: input.workspaceId,
            meetingId: input.meetingId,
            recordingId: input.recordingId,
            trigger: input.trigger,
            pipelineVersion: input.pipelineVersion,
            requestedBy: input.requestedBy,
            currentStep: steps[from]!,
          })
          .returning();
        await sp.insert(processingSteps).values(
          steps.map((name, position) => ({
            runId: run!.id,
            workspaceId: input.workspaceId,
            name,
            position,
            status: position < from ? ('skipped' as const) : ('pending' as const),
            ...(position < from ? { finishedAt: now } : {}),
          })),
        );
        await setMeetingStatus(sp, input.meetingId, 'processing', now);
        return { run: run! };
      });
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'processing_runs_one_active_per_meeting_key') {
        return { conflict: 'run_active' };
      }
      if (constraint === 'processing_runs_upload_per_recording_key') {
        return { conflict: 'upload_run_exists' };
      }
      throw err;
    }
  }

  // --- reads ----------------------------------------------------------------------------------------

  async findRun(runId: string, db: Executor = this.db): Promise<RunRecord | undefined> {
    const [row] = await db.select().from(processingRuns).where(eq(processingRuns.id, runId));
    return row;
  }

  stepsOf(runId: string, db: Executor = this.db): Promise<StepRecord[]> {
    return db
      .select()
      .from(processingSteps)
      .where(eq(processingSteps.runId, runId))
      .orderBy(asc(processingSteps.position));
  }

  /** The meeting's most recent run (any status) with its steps. */
  async latestRun(
    workspaceId: string,
    meetingId: string,
  ): Promise<{ run: RunRecord; steps: StepRecord[] } | null> {
    const [run] = await this.db
      .select()
      .from(processingRuns)
      .where(
        and(eq(processingRuns.workspaceId, workspaceId), eq(processingRuns.meetingId, meetingId)),
      )
      .orderBy(desc(processingRuns.createdAt), desc(processingRuns.id))
      .limit(1);
    return run ? { run, steps: await this.stepsOf(run.id) } : null;
  }

  /** Active and its meeting not deleted: the condition for any step to keep working. */
  async isRunActive(runId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: processingRuns.id })
      .from(processingRuns)
      .innerJoin(meetings, eq(meetings.id, processingRuns.meetingId))
      .where(
        and(
          eq(processingRuns.id, runId),
          inArray(processingRuns.status, ACTIVE),
          isNull(meetings.deletedAt),
        ),
      );
    return Boolean(row);
  }

  async findVisibleMeeting(workspaceId: string, meetingId: string) {
    const [row] = await this.db
      .select({ id: meetings.id, status: meetings.status, durationMs: meetings.durationMs })
      .from(meetings)
      .where(
        and(
          eq(meetings.id, meetingId),
          eq(meetings.workspaceId, workspaceId),
          isNull(meetings.deletedAt),
        ),
      );
    return row;
  }

  async findRecording(
    workspaceId: string,
    meetingId: string,
    kind: 'original' | 'normalized',
  ): Promise<RecordingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.workspaceId, workspaceId),
          eq(recordings.meetingId, meetingId),
          eq(recordings.kind, kind),
        ),
      );
    return row;
  }

  async findRecordingById(workspaceId: string, recordingId: string) {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.id, recordingId)));
    return row;
  }

  /** Active runs, least recently touched first, with their steps (for the sweeper). */
  async listActiveRuns(limit: number): Promise<{ run: RunRecord; steps: StepRecord[] }[]> {
    const runs = await this.db
      .select()
      .from(processingRuns)
      .where(inArray(processingRuns.status, ACTIVE))
      .orderBy(asc(processingRuns.updatedAt))
      .limit(limit);
    if (runs.length === 0) return [];
    const steps = await this.db
      .select()
      .from(processingSteps)
      .where(
        inArray(
          processingSteps.runId,
          runs.map((r) => r.id),
        ),
      )
      .orderBy(asc(processingSteps.position));
    return runs.map((run) => ({ run, steps: steps.filter((s) => s.runId === run.id) }));
  }

  // --- transitions ----------------------------------------------------------------------------------

  /**
   * Runs `fn` in a transaction with the run row locked. `run` is undefined when it doesn't exist,
   * isn't active, or its meeting was deleted: nothing may change it any more.
   */
  withActiveRun<T>(
    runId: string,
    fn: (run: RunRecord | undefined, tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: processingRuns })
        .from(processingRuns)
        .innerJoin(meetings, eq(meetings.id, processingRuns.meetingId))
        .where(
          and(
            eq(processingRuns.id, runId),
            inArray(processingRuns.status, ACTIVE),
            isNull(meetings.deletedAt),
          ),
        )
        .for('update', { of: processingRuns });
      return fn(row?.run, tx);
    });
  }

  async findStep(tx: Executor, runId: string, name: string): Promise<StepRecord | undefined> {
    const [row] = await tx
      .select()
      .from(processingSteps)
      .where(and(eq(processingSteps.runId, runId), eq(processingSteps.name, name)));
    return row;
  }

  async markStepRunning(
    tx: Transaction,
    run: RunRecord,
    step: string,
    runStatus: RunStatus,
    now: Date,
  ): Promise<number> {
    const [row] = await tx
      .update(processingSteps)
      .set({
        status: 'running',
        attempts: sql`${processingSteps.attempts} + 1`,
        startedAt: now,
        finishedAt: null,
        metadata: sql`${processingSteps.metadata} || '{"progress": 0}'::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(processingSteps.runId, run.id), eq(processingSteps.name, step)))
      .returning({ attempts: processingSteps.attempts });
    await tx
      .update(processingRuns)
      .set({
        status: runStatus,
        currentStep: step,
        startedAt: run.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(processingRuns.id, run.id));
    return row!.attempts;
  }

  async markStepSucceeded(
    tx: Transaction,
    runId: string,
    step: string,
    metadata: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await tx
      .update(processingSteps)
      .set({
        status: 'succeeded',
        finishedAt: now,
        errorCode: null,
        errorMessage: null,
        errorDetail: null,
        metadata: sql`${processingSteps.metadata} || ${JSON.stringify({ ...metadata, progress: 1, phase: null })}::jsonb`,
        updatedAt: now,
      })
      .where(and(eq(processingSteps.runId, runId), eq(processingSteps.name, step)));
  }

  /** A retryable failure: back to pending (the queue retries it), last error kept for display. */
  async markStepRetrying(
    tx: Transaction,
    runId: string,
    step: string,
    failure: StepFailure,
    now: Date,
  ): Promise<void> {
    await tx
      .update(processingSteps)
      .set({
        status: 'pending',
        errorCode: failure.code,
        errorMessage: failure.message,
        errorDetail: failure.detail,
        updatedAt: now,
      })
      .where(and(eq(processingSteps.runId, runId), eq(processingSteps.name, step)));
    await touchRun(tx, runId, now);
  }

  /** The step failed for good, and with it the run and the meeting. */
  async failStep(
    tx: Transaction,
    run: RunRecord,
    step: string,
    failure: StepFailure,
    now: Date,
  ): Promise<void> {
    await tx
      .update(processingSteps)
      .set({
        status: 'failed',
        finishedAt: now,
        errorCode: failure.code,
        errorMessage: failure.message,
        errorDetail: failure.detail,
        updatedAt: now,
      })
      .where(and(eq(processingSteps.runId, run.id), eq(processingSteps.name, step)));
    await tx
      .update(processingSteps)
      .set({ status: 'skipped', finishedAt: now, updatedAt: now })
      .where(and(eq(processingSteps.runId, run.id), eq(processingSteps.status, 'pending')));
    await tx
      .update(processingRuns)
      .set({
        status: 'failed',
        currentStep: step,
        errorCode: failure.code,
        errorMessage: failure.message,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(processingRuns.id, run.id));
    await setMeetingStatus(tx, run.meetingId, 'failed', now);
  }

  /** Points the run at its next step (still active). */
  async advance(tx: Transaction, runId: string, next: string, now: Date): Promise<void> {
    await tx
      .update(processingRuns)
      .set({ currentStep: next, updatedAt: now })
      .where(eq(processingRuns.id, runId));
  }

  /** The last step succeeded: the run is completed and the meeting ready. */
  async completeRun(tx: Transaction, run: RunRecord, now: Date): Promise<void> {
    await tx
      .update(processingRuns)
      .set({ status: 'completed', currentStep: null, finishedAt: now, updatedAt: now })
      .where(eq(processingRuns.id, run.id));
    await setMeetingStatus(tx, run.meetingId, 'ready', now);
  }

  /** Content-free progress for the running step (no-op once it's no longer running). */
  async updateStepProgress(
    runId: string,
    step: string,
    progress: number,
    phase: string | undefined,
  ): Promise<void> {
    await this.db
      .update(processingSteps)
      .set({
        metadata: sql`${processingSteps.metadata} || ${JSON.stringify({ progress, phase: phase ?? null })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(processingSteps.runId, runId),
          eq(processingSteps.name, step),
          eq(processingSteps.status, 'running'),
        ),
      );
  }

  /**
   * Cancels the meeting's active run, if any: run → cancelled, unfinished steps → skipped. Works
   * on soft-deleted meetings too (deletion is what usually cancels).
   */
  async cancelActiveRun(meetingId: string, now: Date): Promise<RunRecord | null> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(processingRuns)
        .where(and(eq(processingRuns.meetingId, meetingId), inArray(processingRuns.status, ACTIVE)))
        .for('update');
      if (!run) return null;
      await tx
        .update(processingSteps)
        .set({ status: 'skipped', finishedAt: now, updatedAt: now })
        .where(
          and(
            eq(processingSteps.runId, run.id),
            inArray(processingSteps.status, ['pending', 'running', 'waiting_external']),
          ),
        );
      const [cancelled] = await tx
        .update(processingRuns)
        .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
        .where(eq(processingRuns.id, run.id))
        .returning();
      return cancelled!;
    });
  }
}

/**
 * Writes a step may make in its commit (the transaction that also marks it succeeded). Tenant
 * scoping comes from the locked run the driver hands in.
 */
export class ProcessingTx {
  constructor(
    readonly tx: Transaction,
    private readonly now: Date,
  ) {}

  async recordOriginalMedia(
    run: RunRef,
    media: {
      sha256: string;
      durationMs: number;
      codec: string | null;
      sampleRate: number | null;
      channels: number | null;
    },
  ): Promise<void> {
    await this.tx
      .update(recordings)
      .set({ ...media, updatedAt: this.now })
      .where(and(eq(recordings.id, run.recordingId), eq(recordings.workspaceId, run.workspaceId)));
  }

  /**
   * Replaces the meeting's normalized recording in place (one per meeting). Returns the storage
   * keys of what it replaced, which the caller hands to `supersede` (deleted after commit).
   */
  async replaceNormalized(
    run: RunRef,
    values: Omit<NewRecording, 'id' | 'meetingId' | 'workspaceId' | 'kind' | 'status'>,
  ): Promise<string[]> {
    const [existing] = await this.tx
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.meetingId, run.meetingId),
          eq(recordings.workspaceId, run.workspaceId),
          eq(recordings.kind, 'normalized'),
        ),
      )
      .for('update');
    const row = { ...values, status: 'uploaded' as const, updatedAt: this.now };
    if (!existing) {
      await this.tx.insert(recordings).values({
        ...row,
        meetingId: run.meetingId,
        workspaceId: run.workspaceId,
        kind: 'normalized',
      });
      return [];
    }
    await this.tx
      .update(recordings)
      .set({ ...row, createdAt: this.now })
      .where(eq(recordings.id, existing.id));
    const keep = new Set([values.storageKey, values.peaksStorageKey]);
    return [existing.storageKey, existing.peaksStorageKey].filter(
      (k): k is string => Boolean(k) && !keep.has(k),
    );
  }

  async setMeetingDuration(run: RunRef, durationMs: number): Promise<void> {
    await this.tx
      .update(meetings)
      .set({ durationMs, updatedAt: this.now })
      .where(and(eq(meetings.id, run.meetingId), eq(meetings.workspaceId, run.workspaceId)));
  }

  /** Outbox event: delete these objects once this transaction has committed. */
  async supersede(run: RunRef, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.tx.insert(domainEvents).values({
      type: OBJECTS_SUPERSEDED_EVENT,
      payload: { workspaceId: run.workspaceId, meetingId: run.meetingId, runId: run.id, keys },
    });
  }
}

export { isActive as isActiveRunStatus };

async function setMeetingStatus(
  db: Executor,
  meetingId: string,
  status: MeetingStatus,
  now: Date,
): Promise<void> {
  await db
    .update(meetings)
    .set({ status, updatedAt: now })
    .where(and(eq(meetings.id, meetingId), isNull(meetings.deletedAt)));
}

async function touchRun(db: Executor, runId: string, now: Date) {
  await db.update(processingRuns).set({ updatedAt: now }).where(eq(processingRuns.id, runId));
}
