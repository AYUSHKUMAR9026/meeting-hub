import type { Logger } from './logger';

/**
 * Registers SIGTERM/SIGINT handlers that run `cleanup` once, bounded by `timeoutMs`,
 * then exit. Also turns unhandled errors into a logged, orderly shutdown.
 */
export function registerShutdown(
  logger: Logger,
  timeoutMs: number,
  cleanup: () => Promise<void>,
): void {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    try {
      await cleanup();
      logger.info('shutdown complete');
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      exitCode = 1;
    }
    clearTimeout(timer);
    logger.flush();
    process.exit(exitCode);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal, 0));
  }
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });
}
