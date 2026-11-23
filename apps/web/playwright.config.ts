import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests against the real stack: web (:3000) → API (:4000) + worker → Postgres/Redis/Garage,
 * with email read from Mailpit and recordings uploaded from the browser straight to Garage.
 * Needs `pnpm infra:up && pnpm db:migrate` first.
 * Owns the API and worker to guarantee the fake provider. Locally it can reuse the web server.
 */
const isCI = Boolean(process.env.CI);
const repoRoot = '../..';
const transcriptionEnv = {
  TRANSCRIPTION_PROVIDER: 'fake',
  LLM_PROVIDER: 'fake',
  FEATURE_FLAGS_OVERRIDE: 'transcription.enabled=true,analysis.enabled=true',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @meeting-hub/server exec tsx src/api.ts',
      cwd: repoRoot,
      // The smoke test uploads ~11 MiB; 5 MiB parts (the S3 minimum) make that a 3-part upload.
      env: { ...transcriptionEnv, UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024) },
      url: 'http://localhost:4000/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Processes uploads (outbox → prepare_media with ffmpeg); needs ffmpeg on PATH.
      command: 'pnpm --filter @meeting-hub/server exec tsx src/worker.ts',
      cwd: repoRoot,
      env: transcriptionEnv,
      wait: { stdout: /processing worker started/ },
      timeout: 120_000,
    },
    {
      command: isCI
        ? 'pnpm --filter @meeting-hub/web build && pnpm --filter @meeting-hub/web start'
        : 'pnpm --filter @meeting-hub/web dev',
      cwd: repoRoot,
      url: 'http://localhost:3000/sign-in',
      reuseExistingServer: !isCI,
      timeout: 300_000,
    },
  ],
});
