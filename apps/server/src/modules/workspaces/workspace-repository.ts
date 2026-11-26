import { normalizeTimezone } from '@meeting-hub/contracts';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  invitation,
  meetings,
  meetingInvitations,
  member,
  organization,
  sql,
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
  contentRetention: 'pdf_only' | 'keep_transcript';
  timezone: string;
  retentionDays: number;
  glossary: string[];
  transcriptLanguage: string | null;
  sharingEnabled: boolean;
  externalAiEnabled: boolean;
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
  contentRetention: 'pdf_only',
  timezone: 'UTC',
  retentionDays: 30,
  glossary: [],
  transcriptLanguage: null,
  sharingEnabled: true,
  externalAiEnabled: false,
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

  async meetingsForInvitation(workspaceId: string, invitationId: string) {
    return this.db
      .select({ id: meetings.id, title: meetings.title, occurredAt: meetings.occurredAt })
      .from(meetingInvitations)
      .innerJoin(
        meetings,
        and(
          eq(meetings.id, meetingInvitations.meetingId),
          eq(meetings.workspaceId, meetingInvitations.workspaceId),
        ),
      )
      .where(
        and(
          eq(meetingInvitations.workspaceId, workspaceId),
          eq(meetingInvitations.invitationId, invitationId),
          sql`${meetings.deletedAt} IS NULL`,
        ),
      );
  }

  async linkMeetingInvitations(workspaceId: string, invitationId: string, meetingIds: string[]) {
    if (!meetingIds.length) return;
    await this.db
      .insert(meetingInvitations)
      .values(meetingIds.map((meetingId) => ({ workspaceId, invitationId, meetingId })))
      .onConflictDoNothing();
  }

  async invitedMeetings(workspaceId: string, meetingIds: string[]) {
    return this.db
      .select({
        id: meetings.id,
        title: meetings.title,
        occurredAt: meetings.occurredAt,
        createdBy: meetings.createdBy,
      })
      .from(meetings)
      .where(
        and(
          eq(meetings.workspaceId, workspaceId),
          inArray(meetings.id, meetingIds),
          sql`${meetings.deletedAt} IS NULL`,
        ),
      );
  }

  async acceptMeetingInvitations(workspaceId: string, invitationId: string, userId: string) {
    await this.db.execute(sql`INSERT INTO meeting_participants (workspace_id, meeting_id, person_id)
      SELECT mi.workspace_id, mi.meeting_id, p.id FROM meeting_invitations mi
      JOIN people p ON p.workspace_id = mi.workspace_id AND p.user_id = ${userId}
      JOIN meetings m ON m.id = mi.meeting_id AND m.workspace_id = mi.workspace_id AND m.deleted_at IS NULL
      WHERE mi.workspace_id = ${workspaceId} AND mi.invitation_id = ${invitationId} ON CONFLICT DO NOTHING`);
  }

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
        contentRetention: workspaceSettings.contentRetention,
        timezone: workspaceSettings.timezone,
        retentionDays: workspaceSettings.retentionDays,
        glossary: workspaceSettings.glossary,
        transcriptLanguage: workspaceSettings.transcriptLanguage,
        sharingEnabled: workspaceSettings.sharingEnabled,
        externalAiEnabled: workspaceSettings.externalAiEnabled,
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
      .values({
        workspaceId,
        ...initial,
        ...(initial.timezone ? { timezone: normalizeTimezone(initial.timezone) } : {}),
      })
      .onConflictDoNothing();
  }

  async updateSettings(workspaceId: string, patch: Partial<WorkspaceSettings>): Promise<void> {
    if (patch.timezone) patch = { ...patch, timezone: normalizeTimezone(patch.timezone) };
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

  /**
   * Runs `fn` while this process holds the workspace's membership lock: a transaction-level advisory
   * lock, so owner-affecting changes (role change, removal, leave) in one workspace run one at a
   * time and each sees the previous one's committed result. Better Auth writes on its own
   * connection, so a row lock on `member` would deadlock against its UPDATE; the advisory lock
   * guards the whole check → write sequence instead. Waiters poll with `pg_try_…` rather than
   * blocking, so they don't hold pooled connections the lock holder needs for that write.
   * Returns null if the lock wasn't acquired within `waitMs`.
   */
  async withMembershipLock<T>(
    workspaceId: string,
    fn: () => Promise<T>,
    waitMs = 10_000,
  ): Promise<{ value: T } | null> {
    const key = `workspace-membership:${workspaceId}`;
    const deadline = Date.now() + waitMs;
    for (let attempt = 0; ; attempt++) {
      const result = await this.db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`,
        );
        return rows[0]?.locked ? { value: await fn() } : null;
      });
      if (result || Date.now() >= deadline) return result;
      await new Promise((r) => setTimeout(r, Math.min(25 * 2 ** attempt, 250)));
    }
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
      .where(
        and(
          eq(invitation.organizationId, workspaceId),
          inArray(invitation.status, ['pending', 'accepted', 'rejected']),
        ),
      )
      .orderBy(asc(invitation.createdAt), asc(invitation.id));
    return rows
      .filter((r) => r.status !== 'pending' || r.expiresAt > new Date())
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
