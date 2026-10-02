import { baseConfig } from '@meeting-hub/config/eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import globals from 'globals';

const config = [
  { ignores: ['.next/**', 'next-env.d.ts', 'src/lib/api/schema.d.ts'] },
  ...nextVitals,
  ...nextTs,
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  // eslint-plugin-react's version auto-detection uses an API removed in ESLint 10; pin it.
  { settings: { react: { version: '19.3' } } },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'no-console': 'warn' },
  },
];

export default config;
