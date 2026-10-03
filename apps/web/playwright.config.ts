import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests against the real stack: web (:3000) → API (:4000) → Postgres/Redis,
 * with email read from Mailpit. Needs `pnpm infra:up && pnpm db:migrate` first.
 * Locally, already-running dev servers are reused; in CI both are started here.
 */
const isCI = Boolean(process.env.CI);
const repoRoot = '../..';

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
      url: 'http://localhost:4000/health',
      reuseExistingServer: !isCI,
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
