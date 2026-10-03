import {
  and,
  asc,
  count,
  eq,
  invitation,
  member,
  organization,
  user,
  workspaceSettings,
} from '@meeting-hub/db';

import type { Database } from '../../lib/db';
import { isWorkspaceRole, type WorkspaceRole } from '../auth';

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  createdAt: Date;
}

export interface WorkspaceSettings {
  timezone: string;
  retentionDays: number;
  glossary: string[];
}

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
}

export interface InvitationView {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  inviterId: string;
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  timezone: 'UTC',
  retentionDays: 30,
  glossary: [],
};

/** Better Auth stores roles as text (comma-separated when multiple). We only ever assign one. */
function parseRole(raw: string): WorkspaceRole {
  const role = raw.split(',')[0]!.trim();
  // An unknown role gets the least privilege rather than an error.
  return isWorkspaceRole(role) ? role : 'viewer';
}

/**
 * Reads over Better Auth's organization tables plus our workspace_settings. Every method about a
 * workspace takes its id; the only cross-workspace query is "workspaces this user belongs to".
 */
export class WorkspaceRepository {
  constructor(private readonly db: Database) {}

  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: organization.createdAt,
        role: member.role,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(asc(organization.name), asc(organization.id));
    return rows.map((r) => ({ ...r, role: parseRole(r.role) }));
  }

  /** The user's role in the workspace, or null if they are not a member (or it doesn't exist). */
  async findRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const [row] = await this.db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)));
    return row ? parseRole(row.role) : null;
  }

  async get(workspaceId: string) {
    const [row] = await this.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: organization.createdAt,
      })
      .from(organization)
      .where(eq(organization.id, workspaceId));
    return row;
  }

  /** Settings, or the defaults if the row is missing (see ADR 0002 on non-atomic creation). */
  async getSettings(workspaceId: string): Promise<WorkspaceSettings> {
    const [row] = await this.db
      .select({
        timezone: workspaceSettings.timezone,
        retentionDays: workspaceSettings.retentionDays,
        glossary: workspaceSettings.glossary,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));
    return row ?? DEFAULT_SETTINGS;
  }

  async ensureSettings(
    workspaceId: string,
    initial: Partial<WorkspaceSettings> = {},
  ): Promise<void> {
    await this.db
      .insert(workspaceSettings)
      .values({ workspaceId, ...initial })
      .onConflictDoNothing();
  }

  async updateSettings(workspaceId: string, patch: Partial<WorkspaceSettings>): Promise<void> {
    await this.db
      .insert(workspaceSettings)
      .values({ workspaceId, ...patch })
      .onConflictDoUpdate({
        target: workspaceSettings.workspaceId,
        set: { ...patch, updatedAt: new Date() },
      });
  }

  async listMembers(workspaceId: string): Promise<MemberView[]> {
    const rows = await this.db
      .select({
        memberId: member.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, workspaceId))
      .orderBy(asc(member.createdAt), asc(member.id));
    return rows.map(({ memberId: _m, ...r }) => ({ ...r, role: parseRole(r.role) }));
  }

  async findMember(workspaceId: string, userId: string) {
    const [row] = await this.db
      .select({ memberId: member.id, userId: member.userId, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)));
    return row ? { ...row, role: parseRole(row.role) } : undefined;
  }

  async countOwners(workspaceId: string): Promise<number> {
    const members = await this.db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.organizationId, workspaceId));
    return members.filter((m) => parseRole(m.role) === 'owner').length;
  }

  async countMembers(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(member)
      .where(eq(member.organizationId, workspaceId));
    return row?.n ?? 0;
  }

  async listPendingInvitations(workspaceId: string): Promise<InvitationView[]> {
    const rows = await this.db
      .select()
      .from(invitation)
      .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.status, 'pending')))
      .orderBy(asc(invitation.createdAt), asc(invitation.id));
    return rows
      .filter((r) => r.expiresAt > new Date())
      .map((r) => ({
        id: r.id,
        email: r.email,
        role: parseRole(r.role ?? 'member'),
        status: r.status,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        inviterId: r.inviterId,
      }));
  }

  async findInvitation(workspaceId: string, invitationId: string) {
    const [row] = await this.db
      .select({ id: invitation.id, email: invitation.email, status: invitation.status })
      .from(invitation)
      .where(and(eq(invitation.organizationId, workspaceId), eq(invitation.id, invitationId)));
    return row;
  }

  async slugExists(slug: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, slug));
    return Boolean(row);
  }
}
