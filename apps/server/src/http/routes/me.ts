import { authProvidersResponseSchema, meResponseSchema } from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ApiDeps } from '../../deps';
import { currentUserOf } from '../../modules/auth';
import { problems, SESSION_ERRORS } from './problems';

export const meRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (app, { deps }, done) => {
  app.get(
    '/v1/me',
    {
      config: { access: { kind: 'authenticated' } },
      schema: {
        tags: ['auth'],
        summary: 'The signed-in user',
        response: { 200: meResponseSchema, ...problems(...SESSION_ERRORS) },
      },
    },
    (req) => ({ user: currentUserOf(req) }),
  );

  app.get(
    '/v1/auth/providers',
    {
      config: { access: { kind: 'public' } },
      schema: {
        tags: ['auth'],
        summary: 'Sign-in methods available on this deployment',
        response: { 200: authProvidersResponseSchema },
      },
    },
    async () => ({
      emailPassword: true as const,
      google:
        Boolean(deps.config.GOOGLE_CLIENT_ID && deps.config.GOOGLE_CLIENT_SECRET) &&
        (await deps.flags.isEnabled('auth.google_signin')),
    }),
  );

  done();
};
