import { baseConfig } from '@meeting-hub/config/eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Architectural boundaries (see CLAUDE.md):
 * - lib/       shared infrastructure; may import only lib/
 * - modules/x  domain modules; may import lib/ and OTHER modules' index.ts only
 * - http/      routes & HTTP plumbing; may import lib/ and modules' index.ts
 * - jobs/      queues & processors; may import lib/ and modules' index.ts
 * - src/*.ts   entry points & composition root (api.ts, worker.ts, app.ts, deps.ts) are not
 *              elements: they wire everything together and may import anything.
 */
const moduleIndex = { element: { type: 'module', fileInternalPath: 'index.ts' } };
const lib = { element: { type: 'lib' } };

export default [
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.json' } },
      // Only this app's own files are elements; workspace packages are treated as external.
      'boundaries/include': ['src/**/*.ts'],
      'boundaries/elements': [
        { type: 'module', pattern: 'src/modules/*', capture: ['moduleName'] },
        { type: 'lib', pattern: 'src/lib' },
        { type: 'http', pattern: 'src/http' },
        { type: 'jobs', pattern: 'src/jobs' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // Files inside one element can always import each other.
            { allow: { dependency: { relationship: { to: 'internal' } } } },
            { from: { element: { type: 'lib' } }, allow: { to: lib } },
            { from: { element: { type: 'module' } }, allow: { to: [lib, moduleIndex] } },
            { from: { element: { type: 'http' } }, allow: { to: [lib, moduleIndex] } },
            { from: { element: { type: 'jobs' } }, allow: { to: [lib, moduleIndex] } },
          ],
        },
      ],
    },
  },
];
