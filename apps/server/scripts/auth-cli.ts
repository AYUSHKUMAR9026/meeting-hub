/**
 * Entry point for the Better Auth CLI (`pnpm --filter @meeting-hub/server auth:schema`).
 * Builds our real auth options with inert dependencies; the CLI only reads the schema they imply.
 * Compare its output (.auth-schema.generated.ts, gitignored) with packages/db/src/schema/auth.ts.
 */
import pino from 'pino';

import type { Database } from '../src/lib/db';
import { MemoryMailer } from '../src/lib/mailer';
import type { Redis } from '../src/lib/redis';
import { AuditService } from '../src/modules/audit';
import { createAuth } from '../src/modules/auth';

const logger = pino({ level: 'silent' });
const db = {} as Database; // never queried during schema generation

export const auth = createAuth({
  config: {
    NODE_ENV: 'development',
    WEB_ORIGIN: 'http://localhost:3000',
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'schema-generation-only-secret-0123456789',
    RATE_LIMIT_ENABLED: false,
  },
  db,
  redis: {} as Redis,
  mailer: new MemoryMailer(),
  audit: new AuditService(db, logger),
  logger,
});
