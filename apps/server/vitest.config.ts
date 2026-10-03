import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `name` labels this package's report in the GitHub Actions job summary.
    name: 'server (unit)',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
    // The first test per file pays the cold Fastify/Zod import; under a parallel `turbo run test`
    // on a slow machine that alone can exceed Vitest's 5 s default.
    testTimeout: 15_000,
  },
});
