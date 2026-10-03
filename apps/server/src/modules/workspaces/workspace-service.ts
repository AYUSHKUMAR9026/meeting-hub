import { randomBytes } from 'node:crypto';

import { ConflictError, NotFoundError } from '../../lib/errors';
import type { AuditService, RequestOrigin } from '../audit';
import {
  assertNoViolation,
  type Auth,
  authorize,
  callAuth,
  checkMembershipChange,
  type CurrentUser,
  permissionsFor,
  type WorkspaceActor,
  type WorkspaceRole,
} from '../auth';
import type { PeopleService } from '../people';
import type { FeatureFlagService } from '../platform';
import type {
  InvitationView,
  MemberView,
  WorkspaceRepository,
  WorkspaceSettings,
  WorkspaceSummary,
} from './workspace-repository';

export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  role: WorkspaceRole;
  permissions: string[];
  settings: WorkspaceSettings;
}

export interface InvitationDetails {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  expiresAt: Date;
  workspaceName: string;
  inviterEmail: string;
}

/** The caller's identity for Better Auth calls (it re-reads the session from these headers). */
export interface CallerContext {
  headers: Headers;
  origin: RequestOrigin;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `workspace${base ? `-${base}` : ''}`;
}

export const isValidSlug = (slug: string) =>
  SLUG_PATTERN.test(slug) && slug.length >= 3 && slug.length <= 48;

const notFound = () => new NotFoundError('Workspace not found');

/**
 * Workspace use cases. Better Auth's organization plugin does the membership writes; this service
 * runs our rules first (authorize + role rules), then the side effects Better Auth doesn't know
 * about: settings, people directory and audit log.
 */
export class WorkspaceService {
  constructor(
    private readonly deps: {
      auth: Auth;
      repo: WorkspaceRepository;
      people: PeopleService;
      audit: AuditService;
      flags: FeatureFlagService;
    },
  ) {}

  /** The caller's role in a workspace, or null if they can't see it. Used by requireWorkspace. */
  findRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    return this.deps.repo.findRole(workspaceId, userId);
  }

  listMine(userId: string): Promise<WorkspaceSummary[]> {
    return this.deps.repo.listForUser(userId);
  }

  async create(
    user: CurrentUser,
    input: { name: string; slug?: string | undefined; timezone?: string | undefined },
    caller: CallerContext,
  ): Promise<WorkspaceView> {
    const { auth, repo, people, audit } = this.deps;
    const slug = await this.pickSlug(input.name, input.slug);
    const created = await callAuth(() =>
      auth.api.createOrganization({
        body: { name: input.name, slug, keepCurrentActiveOrganization: true },
        headers: caller.headers,
      }),
    );
    if (!created) throw new Error('Better Auth returned no workspace');

    await repo.ensureSettings(created.id, input.timezone ? { timezone: input.timezone } : {});
    await people.ensureForMember(created.id, user);
    await audit.record({
      action: 'workspace.created',
      workspaceId: created.id,
      actorUserId: user.id,
      target: { type: 'workspace', id: created.id },
      metadata: { name: input.name, slug },
      origin: caller.origin,
    });
    return this.get({ userId: user.id, workspaceId: created.id, role: 'owner' });
  }

  async get(actor: WorkspaceActor): Promise<WorkspaceView> {
    authorize(actor, 'workspace.read');
    const workspace = await this.deps.repo.get(actor.workspaceId);
    if (!workspace) throw notFound();
    return {
      ...workspace,
      role: actor.role,
      permissions: permissionsFor(actor.role),
      settings: await this.deps.repo.getSettings(actor.workspaceId),
    };
  }

  async update(
    actor: WorkspaceActor,
    patch: { name?: string | undefined; settings?: Partial<WorkspaceSettings> | undefined },
    caller: CallerContext,
  ): Promise<WorkspaceView> {
    authorize(actor, 'workspace.update');
    const { auth, repo, audit } = this.deps;
    if (patch.name !== undefined) {
      const name = patch.name;
      await callAuth(() =>
        auth.api.updateOrganization({
          body: { organizationId: actor.workspaceId, data: { name } },
          headers: caller.headers,
        }),
      );
    }
    const settings = Object.fromEntries(
      Object.entries(patch.settings ?? {}).filter(([, v]) => v !== undefined),
    ) as Partial<WorkspaceSettings>;
    if (Object.keys(settings).length > 0) await repo.updateSettings(actor.workspaceId, settings);

    // Field names only: glossary terms may come from meeting content.
    const fields = [
      ...(patch.name !== undefined ? ['name'] : []),
      ...Object.keys(settings).map((k) => `settings.${k}`),
    ];
    if (fields.length > 0) {
      await audit.record({
        action: 'workspace.updated',
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        target: { type: 'workspace', id: actor.workspaceId },
        metadata: { fields },
        origin: caller.origin,
      });
    }
    return this.get(actor);
  }

  listMembers(actor: WorkspaceActor): Promise<MemberView[]> {
    authorize(actor, 'member.read');
    return this.deps.repo.listMembers(actor.workspaceId);
  }

  async changeRole(
    actor: WorkspaceActor,
    targetUserId: string,
    newRole: WorkspaceRole,
    caller: CallerContext,
  ): Promise<MemberView> {
    authorize(actor, 'member.update');
    const { auth, repo, audit } = this.deps;
    const target = await repo.findMember(actor.workspaceId, targetUserId);
    if (!target) throw new NotFoundError('Member not found');
    if (target.role !== newRole) {
      assertNoViolation(
        checkMembershipChange({
          actor,
          target,
          change: { kind: 'change_role', newRole },
          ownerCount: await repo.countOwners(actor.workspaceId),
        }),
      );
      await callAuth(() =>
        auth.api.updateMemberRole({
          body: { organizationId: actor.workspaceId, memberId: target.memberId, role: newRole },
          headers: caller.headers,
        }),
      );
      await audit.record({
        action: 'member.role_changed',
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        target: { type: 'user', id: targetUserId },
        metadata: { from: target.role, to: newRole },
        origin: caller.origin,
      });
    }
    const members = await repo.listMembers(actor.workspaceId);
    return members.find((m) => m.userId === targetUserId)!;
  }

  /** Removes a member, or leaves the workspace when the target is the caller. */
  async removeMember(
    actor: WorkspaceActor,
    targetUserId: string,
    caller: CallerContext,
  ): Promise<void> {
    const { auth, repo, audit } = this.deps;
    const isSelf = targetUserId === actor.userId;
    if (!isSelf) authorize(actor, 'member.remove');

    const target = await repo.findMember(actor.workspaceId, targetUserId);
    if (!target) throw new NotFoundError('Member not found');
    assertNoViolation(
      checkMembershipChange({
        actor,
        target,
        change: { kind: 'remove' },
        ownerCount: await repo.countOwners(actor.workspaceId),
      }),
    );

    if (isSelf) {
      await callAuth(() =>
        auth.api.leaveOrganization({
          body: { organizationId: actor.workspaceId },
          headers: caller.headers,
        }),
      );
    } else {
      await callAuth(() =>
        auth.api.removeMember({
          body: { organizationId: actor.workspaceId, memberIdOrEmail: target.memberId },
          headers: caller.headers,
        }),
      );
    }
    await audit.record({
      action: 'member.removed',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'user', id: targetUserId },
      metadata: { role: target.role, left: isSelf },
      origin: caller.origin,
    });
  }

  async invite(
    actor: WorkspaceActor,
    input: { email: string; role: WorkspaceRole },
    caller: CallerContext,
  ): Promise<InvitationView> {
    authorize(actor, 'invitation.create');
    await this.assertInvitationsEnabled(actor.workspaceId);
    assertNoViolation(
      checkMembershipChange({
        actor,
        change: { kind: 'invite', role: input.role },
        ownerCount: 0,
      }),
    );
    const { auth, audit } = this.deps;
    const email = input.email.trim().toLowerCase();
    const created = await callAuth(() =>
      auth.api.createInvitation({
        body: { organizationId: actor.workspaceId, email, role: input.role, resend: true },
        headers: caller.headers,
      }),
    );
    await audit.record({
      action: 'member.invited',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'invitation', id: created.id },
      metadata: { email, role: input.role },
      origin: caller.origin,
    });
    return {
      id: created.id,
      email: created.email,
      role: input.role,
      status: created.status,
      expiresAt: new Date(created.expiresAt),
      createdAt: new Date(created.createdAt),
      inviterId: created.inviterId,
    };
  }

  async listInvitations(actor: WorkspaceActor): Promise<InvitationView[]> {
    authorize(actor, 'invitation.read');
    await this.assertInvitationsEnabled(actor.workspaceId);
    return this.deps.repo.listPendingInvitations(actor.workspaceId);
  }

  async cancelInvitation(
    actor: WorkspaceActor,
    invitationId: string,
    caller: CallerContext,
  ): Promise<void> {
    authorize(actor, 'invitation.cancel');
    await this.assertInvitationsEnabled(actor.workspaceId);
    const { auth, repo, audit } = this.deps;
    const found = await repo.findInvitation(actor.workspaceId, invitationId);
    if (!found || found.status !== 'pending') throw new NotFoundError('Invitation not found');
    await callAuth(() =>
      auth.api.cancelInvitation({ body: { invitationId }, headers: caller.headers }),
    );
    await audit.record({
      action: 'invitation.revoked',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'invitation', id: invitationId },
      metadata: { email: found.email },
      origin: caller.origin,
    });
  }

  /** Invitation details for its recipient only (anyone else gets 404). */
  async getInvitationForRecipient(
    invitationId: string,
    caller: CallerContext,
  ): Promise<InvitationDetails> {
    const found = await callAuth(() =>
      this.deps.auth.api.getInvitation({ query: { id: invitationId }, headers: caller.headers }),
    );
    await this.assertInvitationsEnabled(found.organizationId);
    return {
      id: found.id,
      email: found.email,
      role: found.role ?? 'member',
      status: found.status,
      expiresAt: new Date(found.expiresAt),
      workspaceName: found.organizationName,
      inviterEmail: found.inviterEmail,
    };
  }

  async acceptInvitation(
    user: CurrentUser,
    invitationId: string,
    caller: CallerContext,
  ): Promise<WorkspaceSummary> {
    const { auth, repo, people, audit } = this.deps;
    // Resolves the workspace (and 404s for anyone but the recipient) before the flag check.
    const details = await callAuth(() =>
      auth.api.getInvitation({ query: { id: invitationId }, headers: caller.headers }),
    );
    await this.assertInvitationsEnabled(details.organizationId);
    const accepted = await callAuth(() =>
      auth.api.acceptInvitation({ body: { invitationId }, headers: caller.headers }),
    );
    if (!accepted) throw new NotFoundError('Invitation not found');
    const workspaceId = accepted.member.organizationId;

    await people.ensureForMember(workspaceId, user);
    await audit.record({
      action: 'member.joined',
      workspaceId,
      actorUserId: user.id,
      target: { type: 'user', id: user.id },
      metadata: { invitationId, role: accepted.member.role },
      origin: caller.origin,
    });
    const workspace = (await repo.listForUser(user.id)).find((w) => w.id === workspaceId);
    if (!workspace) throw notFound();
    return workspace;
  }

  private async assertInvitationsEnabled(workspaceId: string): Promise<void> {
    if (!(await this.deps.flags.isEnabled('workspaces.invitations', { workspaceId }))) {
      throw new NotFoundError('Invitations are not available');
    }
  }

  private async pickSlug(name: string, requested: string | undefined): Promise<string> {
    const { repo } = this.deps;
    if (requested) {
      if (await repo.slugExists(requested)) {
        throw new ConflictError('SLUG_TAKEN', 'That workspace URL is taken');
      }
      return requested;
    }
    const base = slugify(name);
    if (!(await repo.slugExists(base))) return base;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${base.slice(0, 40)}-${randomBytes(3).toString('hex')}`;
      if (!(await repo.slugExists(candidate))) return candidate;
    }
    throw new ConflictError('SLUG_TAKEN', 'Could not find a free workspace URL; pick one');
  }
}
