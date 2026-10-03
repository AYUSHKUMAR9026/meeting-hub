import {
  acceptInvitationResponseSchema,
  createInvitationRequestSchema,
  createWorkspaceRequestSchema,
  invitationDetailsSchema,
  invitationIdParamsSchema,
  invitationListSchema,
  invitationParamsSchema,
  invitationSchema,
  memberListSchema,
  memberParamsSchema,
  memberSchema,
  updateMemberRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListSchema,
  workspaceParamsSchema,
  workspaceSchema,
} from '@meeting-hub/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { ApiDeps } from '../../deps';
import { currentUserOf, workspaceActorOf } from '../../modules/auth';
import type {
  InvitationView,
  MemberView,
  WorkspaceSummary,
  WorkspaceView,
} from '../../modules/workspaces';
import { callerOf, iso } from '../caller';
import { rateLimits } from '../rate-limit';
import { problems, SESSION_ERRORS, WORKSPACE_ERRORS } from './problems';

const toSummary = (w: WorkspaceSummary) => ({ ...w, createdAt: iso(w.createdAt) });
const toWorkspace = (w: WorkspaceView) => ({ ...w, createdAt: iso(w.createdAt) });
const toMember = (m: MemberView) => ({ ...m, joinedAt: iso(m.joinedAt) });
const toInvitation = (i: InvitationView) => ({
  ...i,
  expiresAt: iso(i.expiresAt),
  createdAt: iso(i.createdAt),
});

const noContent = { 204: z.null().describe('No content') };

export const workspaceRoutes: FastifyPluginCallbackZod<{ deps: ApiDeps }> = (
  app,
  { deps },
  done,
) => {
  const { workspaces } = deps;

  // --- workspaces -------------------------------------------------------------------------------

  app.get(
    '/v1/workspaces',
    {
      config: { access: { kind: 'authenticated' } },
      schema: {
        tags: ['workspaces'],
        summary: 'Workspaces I belong to',
        response: { 200: workspaceListSchema, ...problems(...SESSION_ERRORS) },
      },
    },
    async (req) => ({
      workspaces: (await workspaces.listMine(currentUserOf(req).id)).map(toSummary),
    }),
  );

  app.post(
    '/v1/workspaces',
    {
      config: { access: { kind: 'authenticated' } },
      schema: {
        tags: ['workspaces'],
        summary: 'Create a workspace (the caller becomes its owner)',
        body: createWorkspaceRequestSchema,
        response: { 201: workspaceSchema, ...problems(400, 409, ...SESSION_ERRORS) },
      },
    },
    async (req, reply) => {
      const created = await workspaces.create(currentUserOf(req), req.body, callerOf(req));
      return reply.status(201).send(toWorkspace(created));
    },
  );

  app.get(
    '/v1/workspaces/:wid',
    {
      config: { access: { kind: 'workspace', action: 'workspace.read' } },
      schema: {
        tags: ['workspaces'],
        summary: 'A workspace, its settings and my role',
        params: workspaceParamsSchema,
        response: { 200: workspaceSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => toWorkspace(await workspaces.get(workspaceActorOf(req))),
  );

  app.patch(
    '/v1/workspaces/:wid',
    {
      config: { access: { kind: 'workspace', action: 'workspace.update' } },
      schema: {
        tags: ['workspaces'],
        summary: 'Rename a workspace or change its settings',
        params: workspaceParamsSchema,
        body: updateWorkspaceRequestSchema,
        response: { 200: workspaceSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) =>
      toWorkspace(await workspaces.update(workspaceActorOf(req), req.body, callerOf(req))),
  );

  // --- members ----------------------------------------------------------------------------------

  app.get(
    '/v1/workspaces/:wid/members',
    {
      config: { access: { kind: 'workspace', action: 'member.read' } },
      schema: {
        tags: ['members'],
        summary: 'Members of a workspace',
        params: workspaceParamsSchema,
        response: { 200: memberListSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => ({
      members: (await workspaces.listMembers(workspaceActorOf(req))).map(toMember),
    }),
  );

  app.patch(
    '/v1/workspaces/:wid/members/:userId',
    {
      config: { access: { kind: 'workspace', action: 'member.update' } },
      schema: {
        tags: ['members'],
        summary: "Change a member's role",
        description:
          'Nobody can grant a role above their own; admins cannot change owners; the last owner ' +
          'cannot be demoted (409 LAST_OWNER).',
        params: memberParamsSchema,
        body: updateMemberRequestSchema,
        response: { 200: memberSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req) =>
      toMember(
        await workspaces.changeRole(
          workspaceActorOf(req),
          req.params.userId,
          req.body.role,
          callerOf(req),
        ),
      ),
  );

  app.delete(
    '/v1/workspaces/:wid/members/:userId',
    {
      config: {
        access: { kind: 'workspace', action: 'member.remove', unlessSelf: 'userId' },
      },
      schema: {
        tags: ['members'],
        summary: 'Remove a member, or leave (when userId is yours)',
        description:
          'Takes effect on the removed user’s next request. The last owner cannot leave.',
        params: memberParamsSchema,
        response: { ...noContent, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await workspaces.removeMember(workspaceActorOf(req), req.params.userId, callerOf(req));
      return reply.status(204).send(null);
    },
  );

  // --- invitations ------------------------------------------------------------------------------

  app.post(
    '/v1/workspaces/:wid/invitations',
    {
      config: {
        access: {
          kind: 'workspace',
          action: 'invitation.create',
          flag: 'workspaces.invitations',
        },
        rateLimit: rateLimits.invite,
      },
      schema: {
        tags: ['invitations'],
        summary: 'Invite someone by email',
        params: workspaceParamsSchema,
        body: createInvitationRequestSchema,
        response: { 201: invitationSchema, ...problems(409, ...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      const invitation = await workspaces.invite(workspaceActorOf(req), req.body, callerOf(req));
      return reply.status(201).send(toInvitation(invitation));
    },
  );

  app.get(
    '/v1/workspaces/:wid/invitations',
    {
      config: {
        access: { kind: 'workspace', action: 'invitation.read', flag: 'workspaces.invitations' },
      },
      schema: {
        tags: ['invitations'],
        summary: 'Pending invitations',
        params: workspaceParamsSchema,
        response: { 200: invitationListSchema, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req) => ({
      invitations: (await workspaces.listInvitations(workspaceActorOf(req))).map(toInvitation),
    }),
  );

  app.delete(
    '/v1/workspaces/:wid/invitations/:id',
    {
      config: {
        access: { kind: 'workspace', action: 'invitation.cancel', flag: 'workspaces.invitations' },
      },
      schema: {
        tags: ['invitations'],
        summary: 'Revoke a pending invitation',
        params: invitationParamsSchema,
        response: { ...noContent, ...problems(...WORKSPACE_ERRORS) },
      },
    },
    async (req, reply) => {
      await workspaces.cancelInvitation(workspaceActorOf(req), req.params.id, callerOf(req));
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/v1/invitations/:id',
    {
      config: { access: { kind: 'authenticated' } },
      schema: {
        tags: ['invitations'],
        summary: 'An invitation addressed to me',
        description: '404 unless the signed-in user is the recipient.',
        params: invitationIdParamsSchema,
        response: { 200: invitationDetailsSchema, ...problems(403, 404, ...SESSION_ERRORS) },
      },
    },
    async (req) => {
      const details = await workspaces.getInvitationForRecipient(req.params.id, callerOf(req));
      return { ...details, expiresAt: iso(details.expiresAt) };
    },
  );

  app.post(
    '/v1/invitations/:id/accept',
    {
      config: { access: { kind: 'authenticated' }, rateLimit: rateLimits.acceptInvitation },
      schema: {
        tags: ['invitations'],
        summary: 'Accept an invitation addressed to me',
        params: invitationIdParamsSchema,
        response: {
          200: acceptInvitationResponseSchema,
          ...problems(403, 404, 409, ...SESSION_ERRORS),
        },
      },
    },
    async (req) => ({
      workspace: toSummary(
        await workspaces.acceptInvitation(currentUserOf(req), req.params.id, callerOf(req)),
      ),
    }),
  );

  done();
};
