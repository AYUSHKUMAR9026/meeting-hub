import { type NextRequest, NextResponse } from 'next/server';

/**
 * Optimistic route protection (Next.js Proxy). Only checks that a session cookie exists — cheap,
 * no API call. Pages then verify the session for real on the server (lib/api/server.ts), and the
 * API enforces every permission regardless of what the UI shows.
 */
const SESSION_COOKIES = ['mh.session_token', '__Secure-mh.session_token'];
const PROTECTED_PREFIXES = ['/w/', '/onboarding', '/accept-invitation/'];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (isProtected && !hasSession) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('returnTo', `${pathname}${search}`);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
}

export const config = {
  // Pages only: skip the proxied API, Next internals and static files.
  matcher: ['/((?!api/|v1/|ready|_next/static|_next/image|favicon.ico|.*\\.[a-z0-9]+$).*)'],
};
