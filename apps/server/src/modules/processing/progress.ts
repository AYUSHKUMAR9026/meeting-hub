import type { StepStatus } from '@meeting-hub/db';

import type { Logger } from '../../lib/logger';
import type { Redis } from '../../lib/redis';

export interface StepProgressInput {
  status: StepStatus;
  weight: number;
  /** The running step's own estimate, 0..1. */
  progress?: number | null;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Overall run progress, 0..1: weights of finished steps (succeeded or skipped) plus the running
 * step's weight times its own estimate, over the total weight.
 */
export function computeRunProgress(steps: readonly StepProgressInput[]): number {
  const total = steps.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return 0;
  const done = steps.reduce((sum, s) => {
    if (s.status === 'succeeded' || s.status === 'skipped') return sum + s.weight;
    if (s.status === 'running' || s.status === 'waiting_external') {
      return sum + s.weight * clamp01(s.progress ?? 0);
    }
    return sum;
  }, 0);
  return clamp01(done / total);
}

/**
 * Decides when a step's progress is worth writing: at most every `intervalMs`, unless it moved by
 * `minDelta` or more.
 */
export class ProgressThrottle {
  private lastAt = -Infinity;
  private lastValue = -Infinity;

  constructor(
    private readonly intervalMs = 2_000,
    private readonly minDelta = 0.05,
    private readonly now: () => number = Date.now,
  ) {}

  shouldWrite(value: number): boolean {
    const t = this.now();
    if (t - this.lastAt >= this.intervalMs || Math.abs(value - this.lastValue) >= this.minDelta) {
      this.lastAt = t;
      this.lastValue = value;
      return true;
    }
    return false;
  }
}

/** Redis pub/sub channel carrying "this meeting's run changed" signals (payload: ids only). */
export const processingChannel = (meetingId: string) =>
  `meeting-hub:processing:meeting:${meetingId}`;

export interface RunChange {
  workspaceId: string;
  meetingId: string;
  runId: string;
}

/** Tells live subscribers (SSE) that a run changed. Best effort: polling covers lost messages. */
export interface ProgressPublisher {
  runChanged(change: RunChange): Promise<void>;
}

export class RedisProgressPublisher implements ProgressPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async runChanged(change: RunChange): Promise<void> {
    try {
      await this.redis.publish(processingChannel(change.meetingId), JSON.stringify(change));
    } catch (err) {
      this.logger.warn({ err, runId: change.runId }, 'could not publish run change');
    }
  }
}
