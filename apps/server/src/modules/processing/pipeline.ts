import type { RunStatus, RunTrigger } from '@meeting-hub/db';

import type { Logger } from '../../lib/logger';
import type { ProcessingTx } from './repository';

/**
 * Pipeline versions (ADR 0004): an ordered list of step names. A run keeps the version it started
 * with. Later phases append steps and add a new version; never change an existing one.
 */
export const PIPELINES = {
  1: ['prepare_media'],
} as const satisfies Record<number, readonly string[]>;

export type PipelineVersion = keyof typeof PIPELINES;
export const CURRENT_PIPELINE_VERSION: PipelineVersion = 1;

export type StepName = (typeof PIPELINES)[PipelineVersion][number];
export const STEP_NAMES = [...new Set(Object.values(PIPELINES).flat())] as StepName[];

/** The run a step works on (ids only; steps load what they need). */
export interface RunRef {
  id: string;
  workspaceId: string;
  meetingId: string;
  recordingId: string;
  trigger: RunTrigger;
  pipelineVersion: number;
}

export interface StepContext {
  run: RunRef;
  /** 1 for the first attempt. */
  attempt: number;
  /** Aborted when the run is cancelled (or the meeting deleted) or the step times out. */
  signal: AbortSignal;
  /** Bound to run_id and step. */
  logger: Logger;
  /** This step's own progress, 0..1, with an optional phase label (throttled by the driver). */
  progress(fraction: number, phase?: string): void;
  /** Throws if the run stopped being active; call between sub-phases. */
  checkpoint(): Promise<void>;
}

export interface StepOutcome {
  /** Writes the step's output. Runs in the transaction that marks the step succeeded. */
  commit(tx: ProcessingTx): Promise<void>;
  /** Removes what the step wrote, when its result won't be committed (run cancelled meanwhile). */
  discard(): Promise<void>;
  /** Small, content-free facts stored in processing_steps.metadata. */
  metadata?: Record<string, unknown>;
}

/** One entry of the step registry. Everything the driver and sweeper need to run the step. */
export interface StepDefinition {
  name: StepName;
  /** BullMQ queue the step's jobs go to (see jobs/queues.ts). */
  queue: string;
  /** The run's status while this step runs. */
  runStatus: RunStatus;
  maxAttempts: number;
  /** Base delay of the exponential backoff between attempts (jittered). */
  backoffMs: number;
  /** Hard limit for one attempt. */
  timeoutMs: number;
  /** Share of the run's progress bar. */
  weight: number;
  /** Check-before-do: true when this run's output for the step already exists. */
  isAlreadyDone(run: RunRef): Promise<boolean>;
  execute(ctx: StepContext): Promise<StepOutcome>;
}

export type StepRegistry = ReadonlyMap<StepName, StepDefinition>;

/** Builds the registry and checks it against every pipeline version. */
export function createStepRegistry(definitions: readonly StepDefinition[]): StepRegistry {
  const registry = new Map<StepName, StepDefinition>();
  for (const def of definitions) {
    if (registry.has(def.name)) throw new Error(`step "${def.name}" is registered twice`);
    if (!(def.weight > 0)) throw new Error(`step "${def.name}" needs a positive weight`);
    if (!Number.isInteger(def.maxAttempts) || def.maxAttempts < 1) {
      throw new Error(`step "${def.name}" needs maxAttempts >= 1`);
    }
    if (!(def.timeoutMs > 0) || !(def.backoffMs >= 0)) {
      throw new Error(`step "${def.name}" needs a timeout and a backoff`);
    }
    registry.set(def.name, def);
  }
  for (const [version, steps] of Object.entries(PIPELINES)) {
    for (const name of steps) {
      if (!registry.has(name)) throw new Error(`pipeline v${version} uses unknown step "${name}"`);
    }
  }
  return registry;
}

export function stepsOf(version: number): readonly StepName[] {
  const steps = (PIPELINES as Record<number, readonly StepName[] | undefined>)[version];
  if (!steps) throw new Error(`unknown pipeline version ${version}`);
  return steps;
}

export function getStep(registry: StepRegistry, name: string): StepDefinition {
  const def = registry.get(name as StepName);
  if (!def) throw new Error(`unknown step "${name}"`);
  return def;
}

/** The step after `name` in the run's pipeline, or null if it's the last one. */
export function nextStep(version: number, name: string): StepName | null {
  const steps = stepsOf(version);
  const i = steps.indexOf(name as StepName);
  if (i < 0) throw new Error(`step "${name}" is not in pipeline v${version}`);
  return steps[i + 1] ?? null;
}

/** BullMQ job id for a run's step. BullMQ rejects a single ':' in custom ids, hence '.'. */
export const stepJobId = (runId: string, step: string) => `${runId}.${step}`;
