import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db (integration)',
    include: ['test/**/*.int.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
