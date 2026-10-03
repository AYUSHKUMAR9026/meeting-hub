import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // `name` labels this package's report in the GitHub Actions job summary.
    name: 'web (unit)',
    include: ['src/**/*.test.ts'],
    // e2e/ holds Playwright specs (`pnpm test:e2e`), not Vitest tests.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
