import type { Logger } from '../../lib/logger';
import type { AuditService } from '../audit';
import {
  classifyStepError,
  exhausted,
  RunCancelledError,
  STEP_ERRORS,
  type StepFailure,
  StepTimeoutError,
} from './errors';
import {
  getStep,
  nextStep,
  type StepDefinition,
  type StepOutcome,
  type StepRegistry,
} from './pipeline';
import { type ProgressPublisher, ProgressThrottle } from './progress';
import { type ProcessingRepository, ProcessingTx, type RunRecord, toRunRef } from './repository';

/** The payload of every step job: ids only (ADR 0004). */
export interface StepJob {
  runId: string;
  step: string;
}

/** How the job layer reaches BullMQ (implemented in jobs/). */
export interface StepQueue {
  /**
   * Makes sure the job `{runId}.{step}` is waiting, delayed or active: adds it if missing, and
   * replaces a finished or failed one. Returns what it did.
   */
  ensure(job: StepJob, step: StepDefinition): Promise<'existing' | 'enqueued'>;
}

export type StepJobResult =
  /** Output committed; the next step (if any) was enqueued. */
  | 'succeeded'
  /** Nothing to do: run inactive or step already finished. */
  | 'skipped'
  /** Failed for good; the run is failed. */
  | 'failed'
  /** A retryable error; the queue should retry the job (with backoff). */
  | 'retry';

export interface DriverOptions {
  /** How often a running step checks whether its run was cancelled. */
  cancelPollMs?: number;
  now?: () => Date;
}

/**
 * Runs one step of a run per job (ADR 0004): claim → execute → commit (step output + success +
 * run completion in one transaction) → enqueue the next step. A crash anywhere is repaired by the
 * sweeper; the deterministic job id and storage keys make re-delivery safe.
 */
export class PipelineDriver {
  private readonly cancelPollMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      repo: ProcessingRepository;
      registry: StepRegistry;
      queue: StepQueue;
      publisher: ProgressPublisher;
      audit: AuditService;
      logger: Logger;
    },
    options: DriverOptions = {},
  ) {
    this.cancelPollMs = options.cancelPollMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  async processJob(job: StepJob): Promise<StepJobResult> {
    const def = getStep(this.deps.registry, job.step);
    const logger = this.deps.logger.child({ run_id: job.runId, step: job.step });
    const claim = await this.claim(job, def);

    if (claim.kind === 'inactive') {
      logger.info('run no longer active; nothing to do');
      return 'skipped';
    }
    if (claim.kind === 'done') {
      // Finished on an earlier delivery; make sure what follows was enqueued.
      await this.enqueueNext(claim.run, def, logger);
      return 'skipped';
    }
    if (claim.kind === 'exhausted') {
      await this.publish(claim.run);
      await this.auditFinished(claim.run, 'processing.run_failed', claim.failure);
      logger.warn({ code: claim.failure.code }, 'step attempts exhausted; run failed');
      return 'failed';
    }

    const { run, attempt } = claim;
    await this.publish(run);
    const runRef = toRunRef(run);
    let outcome: StepOutcome;
    if (await def.isAlreadyDone(runRef)) {
      logger.info('output already present; marking the step done');
      outcome = { commit: async () => {}, discard: async () => {}, metadata: { reused: true } };
    } else {
      logger.info({ attempt }, 'step started');
      try {
        outcome = await this.execute(def, runRef, attempt, logger);
      } catch (err) {
        return this.handleFailure(run, def, attempt, err, logger);
      }
    }

    const committed = await this.commit(run, def, outcome);
    if (committed.kind === 'inactive') {
      logger.info('run stopped while the step ran; discarding its output');
      await outcome
        .discard()
        .catch((err: unknown) => logger.error({ err }, 'could not discard step output'));
      return 'skipped';
    }
    logger.info({ next: committed.next }, 'step succeeded');
    await this.publish(run);
    if (committed.kind === 'completed') {
      await this.auditFinished(run, 'processing.run_completed');
    } else {
      await this.enqueue(run, committed.next, logger);
    }
    return 'succeeded';
  }

  // --- phases ---------------------------------------------------------------------------------------

  private claim(job: StepJob, def: StepDefinition) {
    type Claim =
      | { kind: 'inactive' }
      | { kind: 'done'; run: RunRecord }
      | { kind: 'exhausted'; run: RunRecord; failure: StepFailure }
      | { kind: 'claimed'; run: RunRecord; attempt: number };
    const { repo } = this.deps;
    return repo.withActiveRun(job.runId, async (run, tx): Promise<Claim> => {
      if (!run) return { kind: 'inactive' };
      const step = await repo.findStep(tx, run.id, def.name);
      if (!step || step.status === 'failed') return { kind: 'inactive' };
      if (step.status === 'succeeded' || step.status === 'skipped') return { kind: 'done', run };
      const now = this.now();
      if (step.attempts >= def.maxAttempts) {
        const failure = exhausted(
          {
            code: step.errorCode ?? STEP_ERRORS.unexpected,
            message: '',
            detail: step.errorDetail ?? 'the worker stopped during every attempt',
            permanent: false,
          },
          step.attempts,
        );
        await repo.failStep(tx, run, def.name, failure, now);
        return { kind: 'exhausted', run, failure };
      }
      const attempt = await repo.markStepRunning(tx, run, def.name, def.runStatus, now);
      return { kind: 'claimed', run, attempt };
    });
  }

  private async execute(
    def: StepDefinition,
    run: ReturnType<typeof toRunRef>,
    attempt: number,
    logger: Logger,
  ): Promise<StepOutcome> {
    const { repo } = this.deps;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new StepTimeoutError(def.timeoutMs)),
      def.timeoutMs,
    );
    const isActive = () => repo.isRunActive(run.id);
    const watcher = setInterval(() => {
      isActive()
        .then((active) => {
          if (!active) controller.abort(new RunCancelledError());
        })
        .catch((err: unknown) => logger.warn({ err }, 'could not check for cancellation'));
    }, this.cancelPollMs);

    const throttle = new ProgressThrottle();
    let progressWrite: Promise<void> = Promise.resolve();
    try {
      return await def.execute({
        run,
        attempt,
        signal: controller.signal,
        logger,
        progress: (fraction, phase) => {
          if (!throttle.shouldWrite(fraction)) return;
          progressWrite = progressWrite
            .then(() => repo.updateStepProgress(run.id, def.name, fraction, phase))
            .then(() =>
              this.deps.publisher.runChanged({
                workspaceId: run.workspaceId,
                meetingId: run.meetingId,
                runId: run.id,
              }),
            )
            .catch((err: unknown) => logger.warn({ err }, 'could not record progress'));
        },
        checkpoint: async () => {
          controller.signal.throwIfAborted();
          if (!(await isActive())) {
            controller.abort(new RunCancelledError());
            throw new RunCancelledError();
          }
        },
      });
    } catch (err) {
      // An abort surfaces as whatever the aborted operation threw; report the reason instead.
      throw controller.signal.aborted ? (controller.signal.reason as Error) : err;
    } finally {
      clearTimeout(timeout);
      clearInterval(watcher);
      await progressWrite;
    }
  }

  private commit(run: RunRecord, def: StepDefinition, outcome: StepOutcome) {
    type Committed =
      { kind: 'inactive' } | { kind: 'completed'; next: null } | { kind: 'next'; next: string };
    const { repo } = this.deps;
    return repo.withActiveRun(run.id, async (locked, tx): Promise<Committed> => {
      if (!locked) return { kind: 'inactive' };
      const step = await repo.findStep(tx, run.id, def.name);
      if (step?.status !== 'running') return { kind: 'inactive' };
      const now = this.now();
      await outcome.commit(new ProcessingTx(tx, now));
      await repo.markStepSucceeded(tx, run.id, def.name, outcome.metadata ?? {}, now);
      const next = nextStep(locked.pipelineVersion, def.name);
      if (!next) {
        await repo.completeRun(tx, locked, now);
        return { kind: 'completed', next: null };
      }
      await repo.advance(tx, run.id, next, now);
      return { kind: 'next', next };
    });
  }

  private async handleFailure(
    run: RunRecord,
    def: StepDefinition,
    attempt: number,
    err: unknown,
    logger: Logger,
  ): Promise<StepJobResult> {
    if (err instanceof RunCancelledError) {
      logger.info('run cancelled while the step ran');
      return 'skipped';
    }
    const classified = classifyStepError(err);
    const final = classified.permanent || attempt >= def.maxAttempts;
    const failure = !classified.permanent && final ? exhausted(classified, attempt) : classified;
    const { repo } = this.deps;
    const recorded = await repo.withActiveRun(run.id, async (locked, tx) => {
      if (!locked) return false;
      const now = this.now();
      if (final) await repo.failStep(tx, locked, def.name, failure, now);
      else await repo.markStepRetrying(tx, run.id, def.name, failure, now);
      return true;
    });
    if (!recorded) return 'skipped';
    await this.publish(run);
    if (final) {
      // A permanent failure is usually the input (a bad file): code and detail say it all.
      logger.warn(
        classified.permanent
          ? { code: failure.code, detail: failure.detail, attempt }
          : { err, code: failure.code, attempt },
        'step failed; run failed',
      );
      await this.auditFinished(run, 'processing.run_failed', failure);
      return 'failed';
    }
    logger.warn({ err, code: failure.code, attempt }, 'step failed; will retry');
    return 'retry';
  }

  // --- helpers --------------------------------------------------------------------------------------

  /** After a re-delivered job of a finished step: enqueue whatever comes next. */
  private async enqueueNext(run: RunRecord, def: StepDefinition, logger: Logger) {
    const next = nextStep(run.pipelineVersion, def.name);
    if (next) await this.enqueue(run, next, logger);
  }

  private async enqueue(run: RunRecord, step: string, logger: Logger) {
    try {
      await this.deps.queue.ensure({ runId: run.id, step }, getStep(this.deps.registry, step));
    } catch (err) {
      // Committed already: the sweeper enqueues it within a minute.
      logger.error({ err, next: step }, 'could not enqueue the next step; the sweeper will');
    }
  }

  private publish(run: RunRecord) {
    return this.deps.publisher.runChanged({
      workspaceId: run.workspaceId,
      meetingId: run.meetingId,
      runId: run.id,
    });
  }

  private auditFinished(
    run: RunRecord,
    action: 'processing.run_completed' | 'processing.run_failed',
    failure?: StepFailure,
  ) {
    return this.deps.audit.record({
      action,
      workspaceId: run.workspaceId,
      target: { type: 'meeting', id: run.meetingId },
      metadata: { runId: run.id, trigger: run.trigger, ...(failure ? { code: failure.code } : {}) },
    });
  }
}
