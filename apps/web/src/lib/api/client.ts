import createClient from 'openapi-fetch';

import type { components, paths } from './schema';

/**
 * Typed browser client generated from packages/contracts/openapi.json.
 * Same-origin: Next.js rewrites /v1/* to the API, and the session cookie rides along.
 * Regenerate types with `pnpm openapi:export` after changing API routes.
 * In server components use `serverApi()` from ./server instead.
 */
export const api = createClient<paths>({ baseUrl: '', credentials: 'same-origin' });

type Schemas = components['schemas'];
export type ReadyResponse = Schemas['ReadyResponse'];
export type DependencyCheck = Schemas['DependencyCheck'];
export type Problem = Schemas['Problem'];
export type User = Schemas['User'];
export type Workspace = Schemas['Workspace'];
export type WorkspaceSummary = Schemas['WorkspaceSummary'];
export type WorkspaceRole = Schemas['WorkspaceRole'];
export type Member = Schemas['Member'];
export type Invitation = Schemas['Invitation'];
export type InvitationDetails = Schemas['InvitationDetails'];
export type Person = Schemas['Person'];
export type Meeting = Schemas['Meeting'];
export type MeetingStatus = Schemas['MeetingStatus'];
export type RecordingSummary = Schemas['RecordingSummary'];

/** A readable message from an API error body (problem+json) or anything thrown. */
export function problemMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error && typeof error === 'object') {
    const p = error as Partial<Problem>;
    if (p.errors?.length) return p.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    if (p.detail) return p.detail;
    if (p.title) return p.title;
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return fallback;
}
