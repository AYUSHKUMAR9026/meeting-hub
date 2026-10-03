import { problemSchema } from '@meeting-hub/contracts';

/** OpenAPI error responses for a route (all application/problem+json). */
export function problems<const S extends number>(...statuses: S[]) {
  return Object.fromEntries(statuses.map((s) => [s, problemSchema])) as Record<
    S,
    typeof problemSchema
  >;
}

/** Errors any session-protected route can return. */
export const SESSION_ERRORS = [401, 429, 500] as const;
/** Errors any workspace-scoped route can return (404 = not a member / not found). */
export const WORKSPACE_ERRORS = [400, 401, 403, 404, 429, 500] as const;
