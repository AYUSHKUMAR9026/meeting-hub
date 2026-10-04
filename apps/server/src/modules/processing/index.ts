// Public API of the processing module (ADR 0004): the step registry, pipeline driver, sweeper, run
// service and progress publishing. BullMQ wiring lives in jobs/; this module only sees StepQueue.
import type { Database } from '../../lib/db';
import type { Logger } from '../../lib/logger';
import type { AuditService } from '../audit';
import { MediaToolkit, type ObjectStorage } from '../media';
import { type DriverOptions, PipelineDriver, type StepQueue } from './driver';
import { createStepRegistry, type StepRegistry } from './pipeline';
import type { ProgressPublisher } from './progress';
import { ProcessingRepository } from './repository';
import { RunService } from './run-service';
import { prepareMediaStep } from './steps/prepare-media';
import { ProcessingSweeper } from './sweeper';

export { type StepJob, type StepJobResult, type StepQueue, PipelineDriver } from './driver';
export {
  classifyStepError,
  RunCancelledError,
  STEP_ERRORS,
  type StepFailure,
  StepTimeoutError,
} from './errors';
export {
  createStepRegistry,
  CURRENT_PIPELINE_VERSION,
  getStep,
  nextStep,
  PIPELINES,
  type RunRef,
  STEP_NAMES,
  type StepContext,
  type StepDefinition,
  stepJobId,
  type StepName,
  type StepOutcome,
  type StepRegistry,
  stepsOf,
} from './pipeline';
export {
  computeRunProgress,
  processingChannel,
  type ProgressPublisher,
  ProgressThrottle,
  type RunChange,
  RedisProgressPublisher,
} from './progress';
export { OBJECTS_SUPERSEDED_EVENT, ProcessingRepository } from './repository';
export {
  type MediaView,
  type ProcessingCanceller,
  type ProcessingView,
  RECORDING_UPLOADED,
  type RunView,
  RunService,
  type StepView,
} from './run-service';
export { normalizedFileName } from './steps/prepare-media';
export { ProcessingSweeper, type SweepResult, TIMEOUT_GRACE_MS } from './sweeper';

export interface ProcessingDeps {
  db: Database;
  storage: ObjectStorage;
  audit: AuditService;
  logger: Logger;
  queue: StepQueue;
  publisher: ProgressPublisher;
  /** BullMQ queue for prepare_media. */
  mediaQueue: string;
  media: {
    ffmpegPath: string;
    ffprobePath: string;
    threads: number;
    maxDurationSeconds: number;
    tmpDir: string;
    maxInputBytes: number;
  };
  mediaUrlTtlSeconds: number;
  driver?: DriverOptions;
}

export interface Processing {
  repo: ProcessingRepository;
  registry: StepRegistry;
  runs: RunService;
  driver: PipelineDriver;
  sweeper: ProcessingSweeper;
}

/** Everything processing needs, for the API (runs) and the worker (driver, sweeper, outbox). */
export function createProcessing(deps: ProcessingDeps): Processing {
  const logger = deps.logger.child({ module: 'processing' });
  const repo = new ProcessingRepository(deps.db);
  const registry = createStepRegistry([
    prepareMediaStep({
      repo,
      storage: deps.storage,
      toolkit: new MediaToolkit(deps.media),
      tmpDir: deps.media.tmpDir,
      maxInputBytes: deps.media.maxInputBytes,
      queue: deps.mediaQueue,
    }),
  ]);
  const shared = {
    repo,
    registry,
    queue: deps.queue,
    publisher: deps.publisher,
    audit: deps.audit,
    logger,
  };
  return {
    repo,
    registry,
    runs: new RunService({
      ...shared,
      db: deps.db,
      storage: deps.storage,
      mediaUrlTtlSeconds: deps.mediaUrlTtlSeconds,
    }),
    driver: new PipelineDriver(shared, deps.driver),
    sweeper: new ProcessingSweeper(shared),
  };
}
