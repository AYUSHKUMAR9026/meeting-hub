import { buildApp } from './app';
import { closeApiDeps, createApiDeps } from './deps';
import { loadConfigOrExit } from './lib/config';
import { createLogger } from './lib/logger';
import { registerShutdown } from './lib/shutdown';

const config = loadConfigOrExit();
const logger = createLogger(config, { process: 'api' });
const deps = createApiDeps(config, logger);
const app = await buildApp(deps);

registerShutdown(logger, config.SHUTDOWN_TIMEOUT_MS, async () => {
  await app.close(); // stops accepting connections and drains in-flight requests
  await closeApiDeps(deps);
});

// Connect eagerly so problems show up at boot; /ready reports the live state either way.
deps.redis
  .connect()
  .catch((err: unknown) => logger.warn({ err }, 'redis not reachable at startup'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
