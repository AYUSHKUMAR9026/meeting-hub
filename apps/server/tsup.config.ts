import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/api.ts', 'src/worker.ts', 'src/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  // Workspace packages ship TypeScript source, so bundle them; real npm deps stay external.
  noExternal: [/^@meeting-hub\//],
});
