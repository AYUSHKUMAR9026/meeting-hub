import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server (integration)',
    include: ['test/**/*.int.test.ts'],
    // Files share Postgres; recovery sweepers discover runs beyond their own BullMQ prefix.
    // Run files serially so one file's sweeper cannot claim another file's crash-recovery run.
    fileParallelism: false,
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
