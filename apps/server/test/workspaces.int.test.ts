import { and, auditLogs, eq, people } from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  linkFromEmail,
  type Session,
  signIn,
  signUp,
  type TestApp,
  uniqueEmail,
  verifyEmail,
} from './support/harness';

describe('workspaces, members and invitations', () => {
  let t: TestApp;
  let owner: Session;
  let workspaceId: string;

  const auditActions = async (wid: string) =>
    (await t.deps.db.db.select().from(auditLogs).where(eq(auditLogs.workspaceId, wid))).map(
      (r) => r.action,
    );

  const personFor = async (wid: string, userId: string) =>
    (
      await t.deps.db.db
        .select()
        .from(people)
        .where(and(eq(people.workspaceId, wid), eq(people.userId, userId)))
    )[0];

  beforeAll(async () => {
    t = await createTestApp();
    owner = await createUser(t, 'owner');
    workspaceId = (await createWorkspace(t, owner, 'Acme Research')).id;
  });
  afterAll(() => t?.close());

  describe('creating a workspace', () => {
    it('makes the creator owner, with default settings and a slug from the name', async () => {
      const res = await call(t, owner, { method: 'GET', url: `/v1/workspaces/${workspaceId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Acme Research',
        slug: expect.stringMatching(/^acme-research/) as unknown,
        role: 'owner',
        settings: { timezone: 'UTC', retentionDays: 30, glossary: [] },
      });
    });

    it('creates a people row linked to the creator and an audit entry', async () => {
      expect(await personFor(workspaceId, owner.userId)).toMatchObject({
        email: owner.email,
        displayName: 'owner',
      });
      expect(await auditActions(workspaceId)).toContain('workspace.created');
    });

    it('lists it under my workspaces', async () => {
      const res = await call(t, owner, { method: 'GET', url: '/v1/workspaces' });
      expect(res.json<{ workspaces: { id: string; role: string }[] }>().workspaces).toContainEqual(
        expect.objectContaining({ id: workspaceId, role: 'owner' }),
      );
    });

    it('rejects a taken slug with 409 SLUG_TAKEN', async () => {
      const first = await createWorkspace(t, owner, 'Slug Clash');
      const res = await call(t, owner, {
        method: 'POST',
        url: '/v1/workspaces',
        payload: { name: 'Other', slug: first.slug },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'SLUG_TAKEN' });
    });
  });

  describe('updating a workspace', () => {
    it('renames it and updates settings, auditing field names only', async () => {
      const res = await call(t, owner, {
        method: 'PATCH',
        url: `/v1/workspaces/${workspaceId}`,
        payload: {
          name: 'Acme R&D',
          settings: { timezone: 'Europe/Berlin', retentionDays: 90, glossary: ['OKR', 'ARR'] },
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Acme R&D',
        settings: { timezone: 'Europe/Berlin', retentionDays: 90, glossary: ['OKR', 'ARR'] },
      });
      const [entry] = await t.deps.db.db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'workspace.updated')),
        );
      expect(entry?.metadata).toEqual({
        fields: ['name', 'settings.timezone', 'settings.retentionDays', 'settings.glossary'],
      });
    });

    it('validates the time zone (problem+json with field errors)', async () => {
      const res = await call(t, owner, {
        method: 'PATCH',
        url: `/v1/workspaces/${workspaceId}`,
        payload: { settings: { timezone: 'Mars/Olympus' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('invitation flow', () => {
    const inviteeEmail = uniqueEmail('invitee');
    let invitationId: string;
    let invitee: Session;

    it('emails an accept link when an owner invites someone', async () => {
      const res = await call(t, owner, {
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        payload: { email: inviteeEmail, role: 'member' },
      });
      expect(res.statusCode, res.body).toBe(201);
      invitationId = res.json<{ id: string }>().id;

      const link = await linkFromEmail(t, inviteeEmail);
      expect(link.pathname).toBe(`/accept-invitation/${invitationId}`);
      expect(t.mailer.lastTo(inviteeEmail)?.subject).toContain('Acme R&D');

      const pending = await call(t, owner, {
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/invitations`,
      });
      expect(pending.json<{ invitations: { id: string }[] }>().invitations).toContainEqual(
        expect.objectContaining({ id: invitationId, email: inviteeEmail, role: 'member' }),
      );
    });

    it('lets the invitee sign up, see and accept the invitation', async () => {
      await signUp(t, inviteeEmail, 'Invitee');
      await verifyEmail(t, inviteeEmail);
      const cookie = await signIn(t, inviteeEmail);
      const me = await call(t, { cookie } as Session, { method: 'GET', url: '/v1/me' });
      invitee = {
        cookie,
        email: inviteeEmail,
        name: 'Invitee',
        userId: me.json<{ user: { id: string } }>().user.id,
      };

      const details = await call(t, invitee, {
        method: 'GET',
        url: `/v1/invitations/${invitationId}`,
      });
      expect(details.statusCode, details.body).toBe(200);
      expect(details.json()).toMatchObject({ workspaceName: 'Acme R&D', role: 'member' });

      const accept = await call(t, invitee, {
        method: 'POST',
        url: `/v1/invitations/${invitationId}/accept`,
      });
      expect(accept.statusCode, accept.body).toBe(200);
      expect(accept.json()).toMatchObject({ workspace: { id: workspaceId, role: 'member' } });

      const ws = await call(t, invitee, { method: 'GET', url: `/v1/workspaces/${workspaceId}` });
      expect(ws.json()).toMatchObject({ role: 'member' });
    });

    it('auto-creates a people row for the new member and audits invite + join', async () => {
      expect(await personFor(workspaceId, invitee.userId)).toMatchObject({ email: inviteeEmail });
      expect(await auditActions(workspaceId)).toEqual(
        expect.arrayContaining(['member.invited', 'member.joined']),
      );
    });

    it('hides invitations from anyone but the recipient (404)', async () => {
      const res = await call(t, owner, {
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        payload: { email: uniqueEmail('someone-else'), role: 'viewer' },
      });
      const id = res.json<{ id: string }>().id;
      for (const req of [
        { method: 'GET' as const, url: `/v1/invitations/${id}` },
        { method: 'POST' as const, url: `/v1/invitations/${id}/accept` },
      ]) {
        expect((await call(t, invitee, req)).statusCode).toBe(404);
      }
    });

    it('revokes a pending invitation', async () => {
      const created = await call(t, owner, {
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/invitations`,
        payload: { email: uniqueEmail('revoked'), role: 'viewer' },
      });
      const id = created.json<{ id: string }>().id;
      const res = await call(t, owner, {
        method: 'DELETE',
        url: `/v1/workspaces/${workspaceId}/invitations/${id}`,
      });
      expect(res.statusCode).toBe(204);
      const pending = await call(t, owner, {
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/invitations`,
      });
      expect(
        pending.json<{ invitations: { id: string }[] }>().invitations.map((i) => i.id),
      ).not.toContain(id);
      expect(await auditActions(workspaceId)).toContain('invitation.revoked');
    });

    it('links an existing directory entry by email instead of duplicating it', async () => {
      const email = uniqueEmail('known-person');
      const added = await call(t, owner, {
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/people`,
        payload: { displayName: 'Known From Meetings', email },
      });
      const personId = added.json<{ id: string }>().id;

      const user = await createUser(t, 'known');
      // createUser picks its own email; re-point the directory entry at it for this case.
      await call(t, owner, {
        method: 'PATCH',
        url: `/v1/people/${personId}`,
        payload: { email: user.email },
      });
      await addMember(t, workspaceId, owner, user, 'viewer');

      const linked = await personFor(workspaceId, user.userId);
      expect(linked?.id).toBe(personId);
      expect(linked?.displayName).toBe('Known From Meetings');
    });
  });

  describe('roles', () => {
    let ws: string;
    let admin: Session;
    let memberUser: Session;

    beforeAll(async () => {
      ws = (await createWorkspace(t, owner, 'Roles Workspace')).id;
      admin = await createUser(t, 'admin');
      memberUser = await createUser(t, 'member');
      await addMember(t, ws, owner, admin, 'admin');
      await addMember(t, ws, owner, memberUser, 'member');
    });

    const setRole = (as: Session, userId: string, role: string) =>
      call(t, as, {
        method: 'PATCH',
        url: `/v1/workspaces/${ws}/members/${userId}`,
        payload: { role },
      });

    it('lets an admin change a member to viewer and back, auditing it', async () => {
      expect((await setRole(admin, memberUser.userId, 'viewer')).json()).toMatchObject({
        role: 'viewer',
      });
      expect((await setRole(admin, memberUser.userId, 'member')).statusCode).toBe(200);
      expect(await auditActions(ws)).toContain('member.role_changed');
    });

    it('stops admins granting owner (403 ROLE_ESCALATION)', async () => {
      const res = await setRole(admin, memberUser.userId, 'owner');
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ROLE_ESCALATION' });
    });

    it('stops admins changing or removing owners (403 CANNOT_MODIFY_OWNER)', async () => {
      expect((await setRole(admin, owner.userId, 'member')).json()).toMatchObject({
        code: 'CANNOT_MODIFY_OWNER',
      });
      const remove = await call(t, admin, {
        method: 'DELETE',
        url: `/v1/workspaces/${ws}/members/${owner.userId}`,
      });
      expect(remove.json()).toMatchObject({ status: 403, code: 'CANNOT_MODIFY_OWNER' });
    });

    it('stops members changing roles at all (403)', async () => {
      expect((await setRole(memberUser, admin.userId, 'viewer')).statusCode).toBe(403);
    });

    it('protects the last owner from demotion and leaving (409 LAST_OWNER)', async () => {
      expect((await setRole(owner, owner.userId, 'admin')).json()).toMatchObject({
        status: 409,
        code: 'LAST_OWNER',
      });
      const leave = await call(t, owner, {
        method: 'DELETE',
        url: `/v1/workspaces/${ws}/members/${owner.userId}`,
      });
      expect(leave.json()).toMatchObject({ status: 409, code: 'LAST_OWNER' });
    });

    it('allows the old owner to step down once there is a second owner', async () => {
      expect((await setRole(owner, admin.userId, 'owner')).statusCode).toBe(200);
      expect((await setRole(owner, owner.userId, 'admin')).statusCode).toBe(200);
      // Restore for later tests.
      expect((await setRole(admin, owner.userId, 'owner')).statusCode).toBe(200);
    });

    it('lets any member leave', async () => {
      const leaver = await createUser(t, 'leaver');
      await addMember(t, ws, owner, leaver, 'viewer');
      const res = await call(t, leaver, {
        method: 'DELETE',
        url: `/v1/workspaces/${ws}/members/${leaver.userId}`,
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('removing a member', () => {
    it('takes effect on their very next request', async () => {
      const ws = (await createWorkspace(t, owner, 'Removal Workspace')).id;
      const removed = await createUser(t, 'removed');
      await addMember(t, ws, owner, removed, 'member');
      expect(
        (await call(t, removed, { method: 'GET', url: `/v1/workspaces/${ws}` })).statusCode,
      ).toBe(200);

      const res = await call(t, owner, {
        method: 'DELETE',
        url: `/v1/workspaces/${ws}/members/${removed.userId}`,
      });
      expect(res.statusCode).toBe(204);

      // Same session, no re-login: every workspace route now 404s for them.
      for (const url of [`/v1/workspaces/${ws}`, `/v1/workspaces/${ws}/members`]) {
        expect((await call(t, removed, { method: 'GET', url })).statusCode).toBe(404);
      }
      const mine = await call(t, removed, { method: 'GET', url: '/v1/workspaces' });
      expect(
        mine.json<{ workspaces: { id: string }[] }>().workspaces.map((w) => w.id),
      ).not.toContain(ws);
      expect(await auditActions(ws)).toContain('member.removed');
    });
  });

  describe('audit log endpoint', () => {
    it('pages newest-first with a cursor', async () => {
      const first = await call(t, owner, {
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/audit-logs?limit=2`,
      });
      expect(first.statusCode).toBe(200);
      const page1 = first.json<{
        items: { id: string; createdAt: string }[];
        nextCursor: string;
      }>();
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();

      const second = await call(t, owner, {
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/audit-logs?limit=2&cursor=${page1.nextCursor}`,
      });
      const page2 = second.json<{ items: { id: string; createdAt: string }[] }>();
      expect(page2.items.length).toBeGreaterThan(0);
      expect(page2.items.map((i) => i.id)).not.toContain(page1.items[0]!.id);
      expect(page2.items[0]!.createdAt <= page1.items[1]!.createdAt).toBe(true);
    });
  });
});

describe('feature flags off', () => {
  let t: TestApp;
  let owner: Session;
  let workspaceId: string;

  beforeAll(async () => {
    t = await createTestApp({
      FEATURE_FLAGS_OVERRIDE: 'workspaces.invitations=false,people.directory=false',
    });
    owner = await createUser(t, 'flags-off');
    workspaceId = (await createWorkspace(t, owner, 'Flags Off')).id;
  });
  afterAll(() => t?.close());

  it('hides invitation routes (404)', async () => {
    const invite = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/invitations`,
      payload: { email: uniqueEmail('nobody'), role: 'member' },
    });
    expect(invite.statusCode).toBe(404);
    expect(
      (await call(t, owner, { method: 'GET', url: `/v1/workspaces/${workspaceId}/invitations` }))
        .statusCode,
    ).toBe(404);
  });

  it('hides people routes (404) but still creates the directory row', async () => {
    expect(
      (await call(t, owner, { method: 'GET', url: `/v1/workspaces/${workspaceId}/people` }))
        .statusCode,
    ).toBe(404);
    const [row] = await t.deps.db.db
      .select()
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), eq(people.userId, owner.userId)));
    expect(row).toBeDefined();
  });
});
