import type { Logger } from '../../lib/logger';
import type { AuditService } from '../audit';
import type { StepQueue } from './driver';
import { STEP_ERRORS } from './errors';
import { getStep, type StepRegistry } from './pipeline';
import type { ProgressPublisher } from './progress';
import type { ProcessingRepository } from './repository';

/** Extra time a running step gets past its timeout before the sweeper fails it. */
export const TIMEOUT_GRACE_MS = 5 * 60_000;

export interface SweepResult {
  /** Steps whose job was missing (lost enqueue, wiped Redis, dead worker) and was re-added. */
  enqueued: number;
  timedOut: number;
}

/**
 * Repairs the gap between Postgres (the truth) and BullMQ (delivery), every minute (ADR 0004):
 * - an active run's next pending step with no live job → enqueue it;
 * - a running step whose job vanished or finished → re-enqueue it;
 * - a running step past its timeout plus a grace period → fail it (and the run).
 */
export class ProcessingSweeper {
  constructor(
    private readonly deps: {
      repo: ProcessingRepository;
      registry: StepRegistry;
      queue: StepQueue;
      publisher: ProgressPublisher;
      audit: AuditService;
      logger: Logger;
      batchSize?: number;
    },
  ) {}

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const { repo, registry, queue, logger } = this.deps;
    const result: SweepResult = { enqueued: 0, timedOut: 0 };
    for (const { run, steps } of await repo.listActiveRuns(this.deps.batchSize ?? 500)) {
      const step = steps.find((s) => s.status !== 'succeeded' && s.status !== 'skipped');
      if (!step || (step.status !== 'pending' && step.status !== 'running')) continue;
      const log = logger.child({ run_id: run.id, step: step.name });
      try {
        const def = getStep(registry, step.name);
        const runningFor = step.startedAt ? now.getTime() - step.startedAt.getTime() : 0;
        if (step.status === 'running' && runningFor > def.timeoutMs + TIMEOUT_GRACE_MS) {
          if (await this.failTimedOut(run.id, step.name, now)) {
            result.timedOut += 1;
            log.warn({ runningForMs: runningFor }, 'step exceeded its timeout; run failed');
          }
          continue;
        }
        if ((await queue.ensure({ runId: run.id, step: step.name }, def)) === 'enqueued') {
          result.enqueued += 1;
          log.warn({ status: step.status }, 'step had no live job; re-enqueued');
        }
      } catch (err) {
        log.error({ err }, 'sweep of run failed');
      }
    }
    return result;
  }

  private async failTimedOut(runId: string, step: string, now: Date): Promise<boolean> {
    const { repo } = this.deps;
    const failed = await repo.withActiveRun(runId, async (run, tx) => {
      if (!run) return null;
      const current = await repo.findStep(tx, runId, step);
      if (current?.status !== 'running') return null;
      await repo.failStep(
        tx,
        run,
        step,
        {
          code: STEP_ERRORS.timedOut,
          message: 'Processing took too long and was stopped.',
          detail: `still running ${Math.round((now.getTime() - (current.startedAt?.getTime() ?? now.getTime())) / 1000)}s after it started`,
          permanent: true,
        },
        now,
      );
      return run;
    });
    if (!failed) return false;
    await this.deps.publisher.runChanged({
      workspaceId: failed.workspaceId,
      meetingId: failed.meetingId,
      runId: failed.id,
    });
    await this.deps.audit.record({
      action: 'processing.run_failed',
      workspaceId: failed.workspaceId,
      target: { type: 'meeting', id: failed.meetingId },
      metadata: { runId: failed.id, trigger: failed.trigger, code: STEP_ERRORS.timedOut },
    });
    return true;
  }
}
