import {
  account,
  invitation,
  member,
  organization as organizationTable,
  session,
  user,
  verification,
} from '@meeting-hub/db';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { organization } from 'better-auth/plugins';

import type { Config } from '../../lib/config';
import type { Database } from '../../lib/db';
import type { Logger } from '../../lib/logger';
import type { Mailer, MailMessage } from '../../lib/mailer';
import type { Redis } from '../../lib/redis';
import type { AuditService } from '../audit';
import { accessControl, accessControlRoles } from './authorization/access-control';
import { invitationEmail, passwordResetEmail, verificationEmail } from './emails';

export const AUTH_BASE_PATH = '/api/auth';
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthDeps {
  config: Pick<
    Config,
    | 'NODE_ENV'
    | 'WEB_ORIGIN'
    | 'BETTER_AUTH_SECRET'
    | 'BETTER_AUTH_URL'
    | 'GOOGLE_CLIENT_ID'
    | 'GOOGLE_CLIENT_SECRET'
    | 'RATE_LIMIT_ENABLED'
  >;
  db: Database;
  redis: Redis;
  mailer: Mailer;
  audit: AuditService;
  logger: Logger;
}

/** Better Auth rate-limit storage on Redis: one atomic INCR + EXPIRE per request, fails open. */
function redisRateLimitStorage(redis: Redis, logger: Logger) {
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      try {
        const redisKey = `rl:auth:${key}`;
        const result = await redis
          .multi()
          .incr(redisKey)
          .expire(redisKey, rule.window, 'NX')
          .ttl(redisKey)
          .exec();
        const count = Number(result?.[0]?.[1] ?? 0);
        const ttl = Number(result?.[2]?.[1] ?? rule.window);
        return count <= rule.max
          ? { allowed: true, retryAfter: null }
          : { allowed: false, retryAfter: Math.max(ttl, 1) };
      } catch (err) {
        logger.warn({ err }, 'auth rate-limit storage unavailable; allowing request');
        return { allowed: true, retryAfter: null };
      }
    },
  };
}

export function createAuth(deps: AuthDeps) {
  const { config, mailer, audit } = deps;
  const logger = deps.logger.child({ module: 'auth' });
  const isProduction = config.NODE_ENV === 'production';
  const webUrl = (path: string) => new URL(path, config.BETTER_AUTH_URL).toString();

  // Send without awaiting so response time doesn't reveal whether an account exists.
  const sendInBackground = (message: MailMessage, kind: string): Promise<void> => {
    mailer.send(message).catch((err: unknown) => logger.error({ err, kind }, 'email send failed'));
    return Promise.resolve();
  };

  const googleConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

  const options = {
    appName: 'Meeting Hub',
    baseURL: config.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [...new Set([config.WEB_ORIGIN, new URL(config.BETTER_AUTH_URL).origin])],
    telemetry: { enabled: false },
    logger: {
      level: isProduction ? 'warn' : 'info',
      log: (level, message, ...args) => {
        logger[level]({ args: args.length ? args : undefined }, message);
      },
    },
    database: drizzleAdapter(deps.db, {
      provider: 'pg',
      schema: {
        user,
        session,
        account,
        verification,
        organization: organizationTable,
        member,
        invitation,
      },
    }),
    advanced: {
      // Better Auth omits the id on insert; Postgres fills it with uuidv7() (ADR 0002).
      database: { generateId: 'uuid' },
      cookiePrefix: 'mh',
      useSecureCookies: isProduction,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: isProduction },
      // The API is only reachable through the web app's proxy, which sets X-Forwarded-For.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    session: {
      // Read the session from Postgres on every request so revocation is immediate.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: config.RATE_LIMIT_ENABLED,
      window: 60,
      max: 100,
      customStorage: redisRateLimitStorage(deps.redis, logger),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user: u, url }) =>
        sendInBackground(passwordResetEmail(u.email, url), 'password_reset'),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user: u, url }) =>
        sendInBackground(verificationEmail(u.email, url), 'verification'),
    },
    socialProviders: googleConfigured
      ? {
          google: {
            clientId: config.GOOGLE_CLIENT_ID!,
            clientSecret: config.GOOGLE_CLIENT_SECRET!,
          },
        }
      : {},
    plugins: [
      organization({
        ac: accessControl,
        roles: accessControlRoles,
        creatorRole: 'owner',
        teams: { enabled: false },
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: (data) =>
          sendInBackground(
            invitationEmail(data.email, webUrl(`/accept-invitation/${data.id}`), {
              workspaceName: data.organization.name,
              inviterName: data.inviter.user.name,
              role: data.role,
            }),
            'invitation',
          ),
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Every sign-in method (password, email verification, OAuth) ends in a new session.
          after: async (s, ctx) => {
            await audit.record({
              action: 'auth.sign_in',
              actorUserId: s.userId,
              target: { type: 'user', id: s.userId },
              metadata: { via: ctx?.path ?? 'unknown' },
              origin: { ip: s.ipAddress ?? null, userAgent: s.userAgent ?? null },
            });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-out') return;
        const current = await getSessionFromCtx(ctx);
        if (!current) return;
        await audit.record({
          action: 'auth.sign_out',
          actorUserId: current.user.id,
          target: { type: 'user', id: current.user.id },
          origin: { ip: current.session.ipAddress, userAgent: current.session.userAgent },
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const returned = ctx.context.returned;
        if (!isAPIError(returned)) return;
        const body = ctx.body as { email?: unknown } | undefined;
        await audit.record({
          action: 'auth.sign_in_failed',
          metadata: {
            email: typeof body?.email === 'string' ? body.email.toLowerCase() : null,
            reason: (returned.body as { code?: string } | undefined)?.code ?? returned.status,
          },
          origin: {
            ip: ctx.request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
            userAgent: ctx.request?.headers.get('user-agent') ?? null,
          },
        });
      }),
    },
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
