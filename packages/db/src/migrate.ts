import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Default location of the SQL migrations when running from source. */
export const defaultMigrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(
  connectionString: string,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end();
  }
}
