// Production migration entry (`docker run <server-image> migrate`).
// Locally, use `pnpm db:migrate`, which runs packages/db/scripts/migrate.ts.
import { runMigrations } from '@meeting-hub/db';

import { loadDotEnv } from './lib/config';

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
// MIGRATIONS_DIR overrides the default (<package>/migrations, i.e. /app/migrations in the image).
await runMigrations(url, process.env.MIGRATIONS_DIR || undefined);
process.stdout.write('Migrations applied.\n');
