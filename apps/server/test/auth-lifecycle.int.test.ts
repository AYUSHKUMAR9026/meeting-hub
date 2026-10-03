import { auditLogs, eq } from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  call,
  cookiesFrom,
  linkFromEmail,
  PASSWORD,
  type Session,
  signIn,
  signUp,
  type TestApp,
  createTestApp,
  uniqueEmail,
} from './support/harness';

describe('session lifecycle: sign-up → verify → sign-in → session → sign-out', () => {
  let t: TestApp;
  const email = uniqueEmail('lifecycle');
  let userId: string;
  let cookie: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  const auditFor = (actorUserId: string) =>
    t.deps.db.db.select().from(auditLogs).where(eq(auditLogs.actorUserId, actorUserId));

  it('rejects /v1/me without a session (problem+json)', async () => {
    const res = await call(t, null, { method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('signs up without a session and emails a verification link', async () => {
    const res = await signUp(t, email, 'Lifecycle User');
    expect(cookiesFrom(res)).not.toContain('session_token');
    const link = await linkFromEmail(t, email);
    expect(link.origin).toBe('http://localhost:3000');
    expect(link.pathname).toBe('/api/auth/verify-email');
  });

  it('refuses to sign in before the email is verified', async () => {
    const res = await call(t, null, {
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('verifies the email via the link and signs the user in', async () => {
    const link = await linkFromEmail(t, email);
    const res = await t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(res.statusCode).toBe(302);
    expect(cookiesFrom(res)).toContain('mh.session_token=');
  });

  it('signs in with an httpOnly, SameSite=Lax session cookie', async () => {
    const res = await call(t, null, {
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = [res.headers['set-cookie']].flat().join('\n');
    expect(setCookie).toMatch(/mh\.session_token=.*HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    cookie = cookiesFrom(res);
  });

  it('resolves the session on /v1/me and tags logs with user_id', async () => {
    const res = await call(t, { cookie } as Session, {
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-request-id': 'lifecycle-me' },
    });
    expect(res.statusCode).toBe(200);
    const { user } = res.json<{ user: { id: string; email: string; emailVerified: boolean } }>();
    expect(user).toMatchObject({ email, emailVerified: true });
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // UUIDv7 from Postgres
    userId = user.id;

    const completed = t.logLines.find(
      (l) => l.request_id === 'lifecycle-me' && l.msg === 'request completed',
    );
    expect(completed).toMatchObject({ user_id: userId });
  });

  it('signs out and the cookie stops working immediately', async () => {
    const res = await call(t, { cookie } as Session, { method: 'POST', url: '/api/auth/sign-out' });
    expect(res.statusCode).toBe(200);
    const after = await call(t, { cookie } as Session, { method: 'GET', url: '/v1/me' });
    expect(after.statusCode).toBe(401);
  });

  it('audits sign-in and sign-out, never storing secrets', async () => {
    const rows = await auditFor(userId);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.sign_in', 'auth.sign_out']));
    const signIns = rows.filter((r) => r.action === 'auth.sign_in');
    // One from the verification link (auto sign-in), one from the password sign-in.
    expect(signIns.map((r) => r.metadata.via)).toEqual(
      expect.arrayContaining(['/verify-email', '/sign-in/email']),
    );
    expect(signIns.find((r) => r.metadata.via === '/sign-in/email')?.userAgent).toBe('vitest');
    expect(JSON.stringify(rows)).not.toMatch(/password|token/i);
  });

  it('audits a failed sign-in without the password', async () => {
    const res = await call(t, null, {
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password: 'wrong-password-123' },
    });
    expect(res.statusCode).toBe(401);
    const rows = await t.deps.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.sign_in_failed'));
    const row = rows.find((r) => r.metadata.email === email);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('wrong-password-123');
  });

  it('resets the password via the emailed link and revokes old sessions', async () => {
    const oldCookie = await signIn(t, email);
    const sentBefore = t.mailer.sent.length;
    const request = await call(t, null, {
      method: 'POST',
      url: '/api/auth/request-password-reset',
      payload: { email, redirectTo: '/reset-password' },
    });
    expect(request.statusCode).toBe(200);

    const link = await linkFromEmail(t, email, sentBefore);
    const landing = await t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(landing.statusCode).toBe(302);
    const token = new URL(landing.headers.location!, 'http://localhost:3000').searchParams.get(
      'token',
    );
    expect(token).toBeTruthy();

    const reset = await call(t, null, {
      method: 'POST',
      url: '/api/auth/reset-password',
      payload: { token, newPassword: 'a-brand-new-password' },
    });
    expect(reset.statusCode, reset.body).toBe(200);

    const stale = await call(t, { cookie: oldCookie } as Session, { method: 'GET', url: '/v1/me' });
    expect(stale.statusCode).toBe(401);
    await signIn(t, email, 'a-brand-new-password');
  });

  it("does not expose Better Auth's organization endpoints over HTTP", async () => {
    const fresh = await signIn(t, email, 'a-brand-new-password');
    for (const path of [
      '/api/auth/organization/create',
      '/api/auth/organization/update-member-role',
    ]) {
      const res = await call(t, { cookie: fresh } as Session, {
        method: 'POST',
        url: path,
        payload: { name: 'x', slug: 'x-x-x' },
      });
      expect(res.statusCode, path).toBe(404);
    }
  });

  it('hides Google sign-in while the flag is off', async () => {
    const providers = await call(t, null, { method: 'GET', url: '/v1/auth/providers' });
    expect(providers.json()).toEqual({ emailPassword: true, google: false });
    const res = await call(t, null, {
      method: 'POST',
      url: '/api/auth/sign-in/social',
      payload: { provider: 'google' },
    });
    expect(res.statusCode).toBe(404);
  });
});
