import { runMigrations } from '../src/migrate';
import { loadRootEnv } from './load-env';

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set. Copy .env.example to .env or export it.\n');
  process.exit(1);
}

await runMigrations(url);
process.stdout.write('Migrations applied.\n');
