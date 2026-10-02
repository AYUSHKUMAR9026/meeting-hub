import createClient from 'openapi-fetch';

import type { components, paths } from './schema';

/**
 * Typed client generated from packages/contracts/openapi.json.
 * Regenerate types with `pnpm openapi:export` after changing API routes.
 */
export const api = createClient<paths>({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
});

export type ReadyResponse = components['schemas']['ReadyResponse'];
export type DependencyCheck = components['schemas']['DependencyCheck'];
