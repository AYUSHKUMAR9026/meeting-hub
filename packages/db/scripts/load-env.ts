import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads the repo-root .env for local CLI usage. Real environment variables always win. */
export function loadRootEnv(): void {
  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}
