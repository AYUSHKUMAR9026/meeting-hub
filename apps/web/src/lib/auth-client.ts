'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth client. It talks to /api/auth on this origin; Next.js proxies that to the API,
 * where Better Auth is mounted. Workspace operations go through the typed /v1 client instead.
 */
export const authClient = createAuthClient({ basePath: '/api/auth' });

/** Only allow same-site relative return URLs (no open redirects). */
export function safeReturnTo(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  return value;
}
