import { readinessSchema, workspaceParamsSchema } from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import type { ApiDeps } from '../../deps';
import { workspaceActorOf } from '../../modules/auth';
import { problems, WORKSPACE_ERRORS } from './problems';

export const readinessRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  app.get(
    '/v1/workspaces/:wid/readiness',
    {
      config: { access: { kind: 'workspace', action: 'workspace.update' } },
      schema: {
        tags: ['system'],
        params: workspaceParamsSchema,
        response: { 200: readinessSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => {
      const workspace = await deps.workspaces.get(workspaceActorOf(req));
      const config = deps.config;
      const checks = [
        ['Rooms', 'rooms.enabled'],
        ['Transcription', 'transcription.enabled'],
        ['Analysis', 'analysis.enabled'],
        ['Exports', 'exports.enabled'],
        ['Review', 'review.enabled'],
        ['Progress', 'progress.enabled'],
        ['Invitations', 'workspaces.invitations'],
        ['Processing', 'pipeline.media'],
      ] as const;
      const [roomReachable, smtpReachable] = await Promise.allSettled([
        config.ROOM_PROVIDER === 'fake'
          ? Promise.resolve()
          : fetch(config.LIVEKIT_URL, { signal: AbortSignal.timeout(2000) }).then((r) => {
              if (!r.ok) throw new Error('unreachable');
            }),
        deps.mailer.verify?.() ?? Promise.resolve(),
      ]);
      const features = await Promise.all(
        checks.map(async ([name, flag]) => {
          let reason = '';
          let fix: 'settings' | 'environment' = 'environment';
          if (!(await deps.flags.isEnabled(flag, { workspaceId: workspace.id })))
            return { name, state: 'off' as const, reason: `Feature flag ${flag} is off.`, fix };
          if (name === 'Rooms') {
            if (
              config.ROOM_PROVIDER === 'livekit' &&
              (!config.LIVEKIT_API_KEY || !config.LIVEKIT_API_SECRET)
            )
              reason = 'LiveKit credentials are missing.';
            else if (roomReachable.status === 'rejected') reason = 'LiveKit is unreachable.';
          }
          if (name === 'Invitations' && smtpReachable.status === 'rejected')
            reason = 'Mailpit / SMTP is unreachable.';
          const provider =
            name === 'Transcription'
              ? config.TRANSCRIPTION_PROVIDER
              : name === 'Analysis'
                ? config.LLM_PROVIDER
                : null;
          if (provider && provider !== 'fake') {
            if (provider === 'groq' && !config.GROQ_API_KEY) reason = 'GROQ_API_KEY is missing.';
            else if (provider === 'gemini' && !config.GEMINI_API_KEY)
              reason = 'GEMINI_API_KEY is missing.';
            else if (!workspace.settings.externalAiEnabled) {
              reason = 'Allow external AI processing is off.';
              fix = 'settings';
            }
          }
          return {
            name,
            state: reason ? ('misconfigured' as const) : ('ready' as const),
            reason:
              reason ||
              (provider === 'fake'
                ? 'Fake local provider; no external requests.'
                : 'Configured and reachable.'),
            fix: reason ? fix : null,
          };
        }),
      );
      return { features };
    },
  );
  done();
};
