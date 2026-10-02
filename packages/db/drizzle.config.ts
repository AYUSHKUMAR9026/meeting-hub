import { defineConfig } from 'drizzle-kit';

import { loadRootEnv } from './scripts/load-env';

loadRootEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? 'postgres://meeting_hub:meeting_hub@localhost:5432/meeting_hub',
  },
  strict: true,
  verbose: true,
});
