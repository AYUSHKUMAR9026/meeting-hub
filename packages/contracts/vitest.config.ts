import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `name` labels this package's report in the GitHub Actions job summary.
  test: { name: 'contracts (unit)', include: ['src/**/*.test.ts'] },
});
