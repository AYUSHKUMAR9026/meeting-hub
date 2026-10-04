/**
 * A worker in its own process, so a test can kill it outright (SIGKILL / TerminateProcess) in the
 * middle of a step, the way a crashed or OOM-killed container dies. Started by
 * `spawnWorkerProcess` in ./processing.ts.
 */
import pino from 'pino';

import { loadConfig } from '../../src/lib/config';
import { startWorkerRuntime, type WorkerRuntimeOptions } from '../../src/worker-runtime';

const env = JSON.parse(process.env.TEST_WORKER_ENV ?? '{}') as Record<string, string>;
const options = JSON.parse(process.env.TEST_WORKER_OPTIONS ?? '{}') as WorkerRuntimeOptions;

const logger = pino({ level: 'info' });
await startWorkerRuntime(loadConfig(env), logger, options);
process.stdout.write('WORKER_READY\n');
