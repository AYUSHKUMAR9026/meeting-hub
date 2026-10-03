import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // e2e/ holds Playwright specs (`pnpm test:e2e`), not Vitest tests.
  test: { exclude: [...configDefaults.exclude, 'e2e/**'] },
});
