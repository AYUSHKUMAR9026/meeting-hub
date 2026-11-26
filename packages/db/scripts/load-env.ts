import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads repo-root .env.local, falling back to .env, for local CLI usage. Real environment variables always win. */
export function loadRootEnv(): void {
  const localPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  const envPath = existsSync(localPath)
    ? localPath
    : fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}
