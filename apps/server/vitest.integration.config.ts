import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server (integration)',
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
