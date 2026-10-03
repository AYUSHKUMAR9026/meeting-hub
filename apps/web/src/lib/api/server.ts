import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import createClient from 'openapi-fetch';
import { cache } from 'react';

import type { paths } from './schema';
import type { User, WorkspaceSummary } from './client';

const API_URL = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Typed client for server components: calls the API directly, forwarding the user's cookies. */
export async function serverApi() {
  const cookieHeader = (await cookies()).toString();
  return createClient<paths>({
    baseUrl: API_URL,
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
}

/** The signed-in user, or null. Checked against the API (and so the database) once per request. */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const api = await serverApi();
  const { data, response } = await api.GET('/v1/me');
  if (response.status === 401) return null;
  if (!data) throw new Error(`GET /v1/me failed with ${response.status}`);
  return data.user;
});

/** Server-side session check for protected pages; redirects to sign-in keeping the return URL. */
export async function requireUser(returnTo: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  return user;
}

export const getMyWorkspaces = cache(async (): Promise<WorkspaceSummary[]> => {
  const api = await serverApi();
  const { data, response } = await api.GET('/v1/workspaces');
  if (!data) throw new Error(`GET /v1/workspaces failed with ${response.status}`);
  return data.workspaces;
});
