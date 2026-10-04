import { loadConfigOrExit } from './lib/config';
import { createLogger } from './lib/logger';
import { registerShutdown } from './lib/shutdown';
import { startWorkerRuntime } from './worker-runtime';

const config = loadConfigOrExit();
const logger = createLogger(config, { process: 'worker' });
const runtime = await startWorkerRuntime(config, logger);

registerShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, () => runtime.close());
