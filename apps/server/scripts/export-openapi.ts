/**
 * Writes the API's OpenAPI document to packages/contracts/openapi.json.
 * Builds the app without listening or connecting to anything (all clients are lazy),
 * using placeholder config so it works in CI without a .env.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../src/app';
import { closeApiDeps, createApiDeps } from '../src/deps';
import { loadConfig } from '../src/lib/config';
import { createLogger } from '../src/lib/logger';

const config = loadConfig({
  NODE_ENV: 'development', // include dev-only routes in the document
  LOG_LEVEL: 'silent',
  WEB_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgres://placeholder@localhost:5432/placeholder',
  REDIS_URL: 'redis://localhost:6379',
  S3_REGION: 'placeholder',
  S3_BUCKET: 'placeholder',
  S3_ACCESS_KEY_ID: 'placeholder',
  S3_SECRET_ACCESS_KEY: 'placeholder',
});
const logger = createLogger({ ...config, NODE_ENV: 'production' });
const deps = createApiDeps(config, logger);
const app = await buildApp(deps);
await app.ready();

const outFile = fileURLToPath(new URL('../../../packages/contracts/openapi.json', import.meta.url));
await writeFile(outFile, `${JSON.stringify(app.swagger(), null, 2)}\n`);

await app.close();
await closeApiDeps(deps);
process.stdout.write(`OpenAPI document written to ${outFile}\n`);
